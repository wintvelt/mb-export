// Functions to get latest data from Moneybird, and update the summary on S3
const { bucketName, publicBucket, accessToken } = require('./SECRETS');
const { response, safeParse } = require('./helpers-api');
const { putPromise, getFile } = require('./s3functions');
const { getMoneyData, retrieveMoneyData } = require('./helpers-moneybird');

exports.syncHandler = function (event) {
    const auth = (process.env.AWS_SAM_LOCAL) ? 'Bearer ' + accessToken : event.headers.Authorization;

    switch (event.httpMethod) {
        case 'GET':
            if (!auth) return response(400, 'Bad request');
            // initial retrieval of files
            return Promise.all([
                getFile('id-list-all-docs.json', bucketName),
                getMoneyData('/documents/purchase_invoices/synchronization.json', auth),
                getMoneyData('/documents/receipts/synchronization.json', auth),
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

        case 'OPTIONS':
            return response(200, 'ok');

        default:
            return response(405, 'not allowed');

    }
}

// takes in Id-lists from S3 and moneybird
// compares them and outputs lists of all new ids, and updated ids
// together with old summary file
function compRetrieve(results, auth) {
    console.log('sync got into compretrieve');
    const purchases = compareOldNew(results[0], results[1], 'purchase_invoice');
    const receipts = compareOldNew(results[0], results[2], 'receipt');
    console.log('sync compare worked');
    const idListAll = safeParse(results[1]).map(it => Object.assign({}, it, { type: 'purchase_invoice' }))
        .concat(safeParse(results[2]).map(it => Object.assign({}, it, { type: 'receipt' })));
    const purchNew = getUpdates({
        type: 'purchasing',
        updates: purchases,
        auth: auth
    });

    const recNew = getUpdates({
        type: 'receipts',
        updates: receipts,
        auth: auth
    });
    console.log('compretrieve made promises');
    return Promise.all([
        purchNew,
        recNew,
        getFile('incoming-summary-list.json', publicBucket),
        putPromise({
            Bucket: bucketName,
            Key: 'id-list-all-docs.json',
            Body: JSON.stringify(idListAll),
            ContentType: 'application/json'
        })
    ])
}

// updSave: creates new summary list with new and updates
// and saves to S3
function updSave(files) {
    console.log('got to updSave');
    const newDocs = safeParse(files[0])
        .map(it => Object.assign(it, { type: 'purchase_invoice' }))
        .filter(it => (it.state !== 'new'))
        .concat(safeParse(files[1])
            .map(it => Object.assign(it, { type: 'receipt' }))
            .filter(it => (it.state !== 'new'))
        );
    console.log(typeof newDocs);
    var newIds = new Set(newDocs.map(it => it.id));
    const oldSummaries = safeParse(files[2]).filter(it => (it.state !== 'new'));
    var newSummaries = [];
    console.log('got to parse input');
    // update old summary list
    for (let i = 0; i < oldSummaries.length; i++) {
        if (i === 0) console.log('got into oldsum loop');
        const oldSum = oldSummaries[i];
        var newerItem = null;
        for (let j = 0; j < newDocs.length; j++) {
            if (j === 0) console.log('got into newdocs loop');
            const item = newDocs[j];
            if (item.id === oldSum.id) {
                newerItem = Object.assign({}, item);
            }
        }
        console.log('finished newdocs loop');
        if (newerItem) {
            console.log('got newer item');
            newSummaries.push(sumUpdate(oldSum, newerItem));
            newIds.delete(oldSum.id);
            console.log('deleted item from set');
        } else {
            newSummaries.push(oldSum);
        }
    }
    console.log('made new sums');
    // add new items to summary
    for (let i = 0; i < newDocs.length; i++) {
        const newDoc = newDocs[i];
        if (i === 0) console.log(newDoc.id);
        if (newIds.has(newDoc.id)) {
            if (i === 0) console.log('did set Check');
            newSummaries.push(sumUpdate(null, newDoc));
            if (i === 0) console.log('did update with new doc');
        }
    }
    console.log('added sums to new list');
    const postParams = {
        ACL: 'public-read',
        Bucket: publicBucket,
        Key: 'incoming-summary-list.json',
        Body: JSON.stringify(newSummaries),
        ContentType: 'application/json'
    }
    return putPromise(postParams).then(res => newSummaries);
}

// Helper for compRetrieve
function compareOldNew(oldStr = '', latestStr = '', type) {
    const old = safeParse(oldStr);
    const latest = safeParse(latestStr);
    var newList = [];
    for (let i = 0; i < latest.length; i++) {
        const latestId = latest[i].id;
        const latestVersion = latest[i].version;
        var inOld = false;
        for (let j = 0; j < old.length; j++) {
            if (old[j].id === latestId) {
                inOld = true;
                if (old[j].version < latestVersion || old[j].type !== type) {
                    newList.push(latestId);
                }
            }
        }
        if (!inOld) {
            newList.push(latestId);
        }
    }
    return ([...new Set(newList)]);
}

// helper for updSave
// to make new summary or update existing
function sumUpdate(oldSum, newRecord) {
    console.log('starting sumupdate');
    var newSum = {
        id: newRecord.id,
        type: newRecord.type,
        createDate: newRecord.created_at,
        invoiceDate: newRecord.date,
        status: newRecord.state,
        type: newRecord.type,
        mutations: []
    }
    if (!oldSum) return newSum;
    console.log('sumupdate got new item');
    newSum.fileName = oldSum.fileName || '';
    newSum.allFiles = oldSum.allFiles || [];
    console.log('sumupdate did filenames');

    if (!newSum.fileName) return Object.assign(newSum, { mutations : [] });

    if (oldSum.mutations) { newSum.mutations = [...oldSum.mutations] };
    console.log('sumupdate did mutations');
    if (newSum.invoiceDate !== oldSum.invoiceDate) {
        newSum.mutations = [...newSum.mutations,
        { fieldName: "invoiceDate", oldValue: oldSum.invoiceDate, newValue: newSum.invoiceDate }
        ];
    }
    console.log('sumupdate checked invoicedate');
    if (newSum.status !== oldSum.status) {
        newSum.mutations = [...newSum.mutations,
        { fieldName: "status", oldValue: oldSum.status, newValue: newSum.status }
        ];
    }
    console.log('sumupdate checked status');
    if (newSum.type !== oldSum.type) {
        newSum.mutations = [...newSum.mutations,
        { fieldName: "type", oldValue: oldSum.type, newValue: newSum.type }
        ];
    }
    console.log('sumupdate checked type');
    if (newSum.mutations.length === 0) {
        newSum.mutations = [ { fieldName: 'other' } ];
    }

    console.log('sumupdate done');
    return newSum;
}

// to retrieve Moneybird records from list of Ids (returns Promise)
function getUpdates({ type, updates, auth }) {
    const path = (type === 'receipts') ?
        '/documents/receipts/synchronization.json'
        : '/documents/purchase_invoices/synchronization.json';
    return retrieveMoneyData(path, auth, updates);
}