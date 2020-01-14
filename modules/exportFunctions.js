// functions to create an export file
const { response, safeParse } = require('./helpers-api');
const { putPromise, deletePromise, getFile, getFileWithDate } = require('./s3functions');
const { publicBucket, bucketName, accessToken } = require('./SECRETS');
const { getMoneyData, retrieveMoneyData } = require('./helpers-moneybird');
const { makeExportRows } = require('./helpers-xls');

const Excel = require('exceljs/modern.nodejs');
const moment = require('moment');

// MAIN HANDLER
exports.exportHandler = function (event) {
    const eventMethod = (process.env.AWS_SAM_LOCAL && event.httpMethod === 'GET') ?
        event.queryStringParameters.method : event.httpMethod;
    if (eventMethod === 'GET' && !(event.queryStringParameters && event.queryStringParameters.filename)) {
        return response(403, 'bad request')
    };
    if (eventMethod === 'DELETE' && event.httpMethod === 'GET' &&
        (!event.queryStringParameters || !event.queryStringParameters.filename)) {
        return response(403, 'bad request')
    };
    switch (eventMethod) {
        case 'GET':
            return exportGetHandler(event);
            break;

        case 'POST':
            return exportPostHandler(event);
            break;

        case 'DELETE':
            return exportDeleteHandler(event);
            break;

        case 'OPTIONS':
            return response(200, 'ok');

        default:
            return response(405, 'Method not allowed');
            break;
    }

}

// Export GET handler
// to respond with summaries + last sync date
function exportGetHandler(event) {
    return Promise.all([
        getFile(event.queryStringParameters.filename, publicBucket),
        getFileWithDate('id-list-all-docs.json', bucketName)
    ])
        .then(makeSumsWithDate)
        .then(res => response(200, res))
        .catch(err => response(500, "Oops, server error " + err))
}


function makeSumsWithDate(dataList) {
    return new Promise((resolve, reject) => {
        if (dataList.length < 2) reject('some data missing');
        const outObj = {
            list: dataList[0],
            syncDate: dataList[1].syncDate
        }
        resolve(outObj);
    })
}

// Export POST handler
// to create new export
function exportPostHandler(event) {
    const body = (process.env.AWS_SAM_LOCAL && !event.body) ? 
        (event.queryStringParameters && event.queryStringParameters.body && 
            JSON.parse(decodeURI(event.queryStringParameters.body)))
        : JSON.parse(event.body);
    const auth = (process.env.AWS_SAM_LOCAL) ? 'Bearer ' + accessToken : event.headers.Authorization;

    if (!body.ids) return response(403, 'Bad request');

    return Promise.all([
        getFile('incoming-summary-list.json', publicBucket),
        body,
        auth
    ])
        .then(retrieve)
        .then(createExport)
        .then(res => response(200, res[2]))
        .catch(err => response(500, "Oops, server error " + err))
}

// function to process summary-list
// and retrieve additional info from Moneybird
function retrieve(data) {
    console.log('begin retrieve');
    const oldSums = data[0];
    const body = data[1];
    const auth = data[2];

    var filteredSums = [];
    for (let i = 0; i < oldSums.length; i++) {
        const sumEl = oldSums[i];
        for (let j = 0; j < body.ids.length; j++) {
            const expId = body.ids[j];
            if (sumEl.id === expId) filteredSums.push(sumEl)
        }
    }
    if (filteredSums.length === 0) return "nothing to export";

    var purchToGet = [];
    var recToGet = [];
    for (let i = 0; i < filteredSums.length; i++) {
        const sumEl = filteredSums[i];
        if (sumEl.type === 'receipt') {
            recToGet.push(sumEl.id);
            purchToGet.push(sumEl.id);
        } else {
            recToGet.push(sumEl.id);
            purchToGet.push(sumEl.id);
        }
    }
    console.log('end retrieve');
    console.log(purchToGet, recToGet);

    return Promise.all([
        getMoneyData('/ledger_accounts.json', auth),
        getMoneyData('/tax_rates.json', auth),
        retrieveMoneyData('/documents/purchase_invoices/synchronization.json', auth, purchToGet),
        retrieveMoneyData('/documents/receipts/synchronization.json', auth, recToGet),
        oldSums,
        body
    ])
}

// function to create export and save files
function createExport(data) {
    console.log('begin create export');

    if (typeof data === "string") return data;

    const dataObj = {
        ledgers: safeParse(data[0]),
        taxRates: safeParse(data[1]),
        purchRecords: safeParse(data[2]),
        recRecords: safeParse(data[3]),
        oldSums: data[4],
        body: data[5]
    };
    console.log('made dataObj');
    console.log(data[2]);

    const exportRows = makeExportRows(dataObj);
    console.log('begin xls create');

    const dateStampFormat = 'YYYYMMDD HHmmss';
    var exportName = 
        ((dataObj.body.noLog) ? 'nolog-' : '')
        + 'purchase-export-'
        + moment().format(dateStampFormat)
        + ((dataObj.body.ext) ? '-' + dataObj.body.ext : '')
        + '.xlsx';

    var exportFile = 'empty export file';
    if (exportRows && exportRows.length > 0) {
        var workbook = new Excel.Workbook();
        workbook.creator = 'Wouter';
        workbook.lastModifiedBy = 'Wouter';
        workbook.created = new Date(2019, 7, 1);

        var sheet = workbook.addWorksheet('Moblybird export');
        sheet.addRow([
            'id', 'link', 'referentie', 'status', 'datum', 'vervaldatum', 'contact', 'contactnummer', 
            'valuta', 'betaald op', 'aantal', 'aantal (decimaal)', 'omschrijving', 
            'categorie', 'categorienummer', 'totaalprijs exclusief btw', 'btw-tarief', 
            'totaalprijs inclusief btw', 'totaalprijs exclusief btw (EUR)', 'totaalprijs inclusief btw (EUR)',
            'btw-tarief naam', 'btw', 'begin periode', 'eind periode', 'datum aanmaak', 'laatste update'
        ]);

        for (let i = 0; i < exportRows.length; i++) {
            const newRow = exportRows[i];
            sheet.addRow(newRow);
        }

        sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) {
                row.font = { bold: true }
            } else {
                row.font = { bold: false }
            }
        });

        var linkCol = sheet.getColumn(2);
        linkCol.font = { color: { argb: 'FF00ACC2' } };
        sheet.getCell('B1').font = { color: { argb: 'FF000000' } };

        const widths = [ 20, 10, 30, 10, 20, 20, 20, 10, 10, 20, 10, 10, 20, 20,
        10, 10, 10, 10, 10, 10, 20, 10, 20, 20, 20, 20 ];
        widths.forEach((v, i) => {
            sheet.getColumn(i+1).width = v;
        })

        exportFile = workbook.xlsx.writeBuffer()
            .then(function (buffer) {
                const postParams = {
                    ACL: 'public-read',
                    Bucket: publicBucket,
                    Key: exportName,
                    Body: buffer
                }
                return putPromise(postParams)
                    .then(data => {
                        return response(200, data);
                    })
                    .catch(err => response(500, 'error tje'));
            });
    }
    console.log('begin create new sum file');
    // create new Summary file
    const expRecords = dataObj.purchRecords.concat(dataObj.recRecords);
    const newSums = [];
    for (let i = 0; i < dataObj.oldSums.length; i++) {
        const oldSum = dataObj.oldSums[i];
        var newSum = Object.assign({}, { allFiles : [] }, oldSum);
        for (let j = 0; j < expRecords.length; j++) {
            const record = expRecords[j];
            if (record.id === oldSum.id) {
                newSum.allFiles = [...new Set(newSum.allFiles.concat(exportName))];
                if (!dataObj.body.noLog) {
                    newSum.fileName = exportName;
                    newSum.mutations = [];
                }
            }
        }
        newSums.push(newSum);
    }

    return Promise.all([
        exportFile,
        putPromise({
            ACL: 'public-read',
            Bucket: publicBucket,
            Key: 'incoming-summary-list.json',
            Body: JSON.stringify(newSums),
            ContentType: 'application/json'
        }),
        newSums
    ])
}

// Delete handler (to update summary and delete public file)
function exportDeleteHandler(event) {
    const filename = (process.env.AWS_SAM_LOCAL
        && event.queryStringParameters &&
        event.queryStringParameters.filename) ?
        event.queryStringParameters.filename : JSON.parse(event.body).filename;

    return Promise.all([
        getFile('incoming-summary-list.json', publicBucket),
        filename
    ])
        .then(updateFiles)
        .then(res => response(200, res[0]))
        .catch(err => response(500, "Oops, server error " + err))
}

function updateFiles(data) {
    const oldSums = data[0];
    const filename = data[1];
    var sumsChanged = false;
    var newSums = [];
    for (let i = 0; i < oldSums.length; i++) {
        const item = oldSums[i];
        if (item.allFiles && item.allFiles.includes(filename)) {
            item.allFiles = item.allFiles.filter(fn => (fn !== filename))
            sumsChanged = true;
        }
        if (item.fileName && item.fileName === filename) {
            delete item.fileName;
            sumsChanged = true;
        }
        newSums.push(item);
    }
    if (!sumsChanged) return Promise.all([
        oldSums,
        deletePromise({
            Bucket: publicBucket,
            Key: filename
        })
    ])

    return Promise.all([
        newSums,
        putPromise({
            ACL: 'public-read',
            Bucket: publicBucket,
            Key: 'incoming-summary-list.json',
            Body: JSON.stringify(newSums),
            ContentType: 'application/json'
        }),
        deletePromise({
            Bucket: publicBucket,
            Key: filename
        })
    ])
}