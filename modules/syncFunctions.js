// Functions to get latest data from Moneybird, and update the summary on S3
const { bucketName, publicBucket, accessToken } = require('./SECRETS');
const { response, safeParse } = require('./helpers-api');
const { putPromise, getFile } = require('./s3functions');
const { getMoneyData, retrieveMoneyData } = require('./helpers-moneybird');

exports.syncHandler = function (event) {
    const auth = (process.env.AWS_SAM_LOCAL) ? 'Bearer ' + accessToken : event.headers.Authorization;
    if (!auth) return response(400, 'Bad request');

    switch (event.httpMethod) {
        case 'GET':
            // initial retrieval of files
            return Promise.all([
                getFile('id-list-purchasing.json', bucketName),
                getMoneyData('/documents/purchase_invoices/synchronization.json', auth),
                getFile('id-list-receipts.json', bucketName),
                getMoneyData('/documents/receipts/synchronization.json', auth)
            ])
                .then(res => compRetrieve(res, auth))
                .then(updSave)
                .then(res => {
                    return response(200, res)
                })
                .catch(error => {
                    return response(500, 'strange error ' + error);
                });
            break;

        default:
            return response(405, 'not allowed');

    }
}

// takes in Id-lists from S3 and moneybird
// compares them and outputs lists of all new ids, and updated ids
// together with old summary file
function compRetrieve(results, auth) {
    const purchaseUpdates = compareOldNew(results[0], results[1]);
    const receiptUpdates = compareOldNew(results[2], results[3]);

    const purchNew = getUpdates({
        type: 'purchasing',
        updates: purchaseUpdates[0],
        auth: auth
    });

    const purchUpdates = getUpdates({
        type: 'purchasing',
        updates: purchaseUpdates[1],
        auth: auth
    });

    const recNew = getUpdates({
        type: 'receipts',
        updates: receiptUpdates[0],
        auth: auth
    });

    const recUpdates = getUpdates({
        type: 'receipts',
        updates: receiptUpdates[1],
        auth: auth
    });

    return Promise.all([
        purchNew,
        purchUpdates,
        recNew,
        recUpdates,
        getFile('incoming-summary-list.json', publicBucket),
        putPromise({
            Bucket: bucketName,
            Key: 'id-list-purchasing.json',
            Body: JSON.stringify(results[1]),
            ContentType: 'application/json'
        }),
        putPromise({
            Bucket: bucketName,
            Key: 'id-list-receipts.json',
            Body: JSON.stringify(results[3]),
            ContentType: 'application/json'
        })
    ])
}

// updSave: creates new summary list with new and updates
// and saves to S3
function updSave(files) {
    if (files.length !== 7) return "error";
    const purchNew = safeParse(files[0]);
    const purchUpdates = safeParse(files[1]);
    const recNew = safeParse(files[2]);
    const recUpdates = safeParse(files[3]);
    const oldSummaries = safeParse(files[4]);

    var newSummaries = [];
    // update old summary list
    for (let i = 0; i < oldSummaries.length; i++) {
        const oldSum = oldSummaries[i];
        const listToCheck = (oldSum.type === 'receipt') ? recUpdates : purchUpdates;
        var newerItem = null;
        for (let j = 0; j < listToCheck.length; j++) {
            const item = listToCheck[j];
            if (item.id === oldSum.id) { newerItem = item }
        }
        if (newerItem) {
            newSummaries.push(sumUpdate(oldSum.type, newerItem, oldSum));
        } else {
            newSummaries.push(oldSum);
        }
    }
    // add new items to summary
    for (let i = 0; i < purchNew.length; i++) {
        const newItem = purchNew[i];
        newSummaries.push(sumUpdate('purchase_invoice', newItem))
    }
    for (let i = 0; i < recNew.length; i++) {
        const newItem = recNew[i];
        newSummaries.push(sumUpdate('receipt', newItem))
    }
    const postParams = {
        ACL: 'public-read',
        Bucket: publicBucket,
        Key: 'incoming-summary-list.json',
        Body: JSON.stringify(newSummaries),
        ContentType: 'application/json'
    }
    return putPromise(postParams)
}

// Helper for compRetrieve
function compareOldNew(oldStr = '', latestStr = '') {
    const old = safeParse(oldStr);
    const latest = safeParse(latestStr);
    var newList = [];
    var updatedList = [];
    for (let i = 0; i < latest.length; i++) {
        const latestId = latest[i].id;
        const latestVersion = latest[i].version;
        var inOld = false;
        for (let j = 0; j < old.length; j++) {
            if (old[j].id === latestId) {
                inOld = true;
                if (old[j].version < latestVersion) {
                    updatedList.push(latestId);
                }
            }
        }
        if (!inOld) {
            newList.push(latestId);
        }
    }
    return ([ [...new Set(newList)], [...new Set(updatedList)] ]);
}

// helper for updSave
// to make new summary or update existing
function sumUpdate(type, newRecord, oldSum = {}) {
    var newSum = {
        id: newRecord.id,
        type: type,
        createDate: newRecord.created_at,
        invoiceDate: newRecord.date,
        status: newRecord.state,
        fileName: oldSum.fileName,
        mutations: oldSum.mutations || []
    }
    if (oldSum.createDate && newSum.invoiceDate !== oldSum.invoiceDate) {
        newSum.mutations = [...newSum.mutations,
        { fieldName: "invoiceDate", oldValue: oldSum.invoiceDate, newValue: newSum.invoiceDate }
        ];
    }
    if (oldSum.createDate && newSum.status !== oldSum.status) {
        newSum.mutations = [...newSum.mutations,
        { fieldName: "status", oldValue: oldSum.status, newValue: newSum.status }
        ];
    }
    return newSum;
}

// to retrieve Moneybird records from list of Ids (returns Promise)
function getUpdates({ type, updates, auth }) {
    const path = (type === 'receipts') ?
        '/documents/receipts/synchronization.json'
        : '/documents/purchase_invoices/synchronization.json';
    return retrieveMoneyData(path, auth, updates);
}