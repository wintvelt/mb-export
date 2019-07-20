// functions to create an export file
const { response, safeParse } = require('./helpers-api');
const { putPromise, deletePromise, getFile, getFileWithDate } = require('./s3functions');
const { publicBucket, bucketName, accessToken, adminCode } = require('./SECRETS');
const { getMoneyData, retrieveMoneyData } = require('./helpers-moneybird');

const Excel = require('exceljs/modern.nodejs');
const moment = require('moment');

// MAIN HANDLER
exports.exportHandler = function (event) {
    const eventMethod = (process.env.AWS_SAM_LOCAL && event.httpMethod === 'GET') ?
        event.queryStringParameters.method : event.httpMethod;
    if (eventMethod === 'GET' && (!event.queryStringParameters || !event.queryStringParameters.filename)) {
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
        getFileWithDate('id-list-purchasing.json', bucketName)
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
    const body = (process.env.AWS_SAM_LOCAL && !event.body) ? { ids: ["260703856723232639", "260736893579167014"] }
        : JSON.parse(event.body);
    const auth = (process.env.AWS_SAM_LOCAL) ? 'Bearer ' + accessToken : event.headers.Authorization;

    if (!body.ids) return response(403, 'Bad request');

    return Promise.all([
        getFile('incoming-summary-list.json', publicBucket),
        body.ids,
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
    var filteredSums = [];
    for (let i = 0; i < data[0].length; i++) {
        const sumEl = data[0][i];
        for (let j = 0; j < data[1].length; j++) {
            const expId = data[1][j];
            if (sumEl.id === expId) filteredSums.push(sumEl)
        }
    }
    if (filteredSums.length === 0) return "nothing to export";

    const auth = data[2];

    var purchToGet = [];
    var recToGet = [];
    for (let i = 0; i < filteredSums.length; i++) {
        const sumEl = filteredSums[i];
        if (sumEl.type === 'receipt') {
            recToGet.push(sumEl.id)
        } else {
            purchToGet.push(sumEl.id)
        }
    }

    return Promise.all([
        getMoneyData('/ledger_accounts.json', auth),
        getMoneyData('/tax_rates.json', auth),
        retrieveMoneyData('/documents/purchase_invoices/synchronization.json', auth, purchToGet),
        retrieveMoneyData('/documents/receipts/synchronization.json', auth, recToGet),
        data[0]
    ])
}

// function to create export and save files
function createExport(data) {
    if (typeof data === "string") return data;

    const dataObj = {
        ledgers: safeParse(data[0]),
        taxRates: safeParse(data[1]),
        purchRecords: safeParse(data[2]),
        recRecords: safeParse(data[3]),
        oldSums: data[4]
    };

    var workbook = new Excel.Workbook();
    workbook.creator = 'Wouter';
    workbook.lastModifiedBy = 'Wouter';
    workbook.created = new Date(2019, 7, 1);

    var sheet = workbook.addWorksheet('Moblybird export');
    sheet.addRow([
        'id', 'referentie', 'status', 'datum', 'vervaldatum', 'contact', 'contactnummer', 'valuta', 'betaald op',
        'aantal', 'aantal (decimaal)', 'omschrijving', 'categorie', 'categorienummer', 'totaalprijs exclusief btw',
        'btw-tarief', 'totaalprijs inclusief btw', 'totaalprijs exclusief btw (EUR)', 'totaalprijs inclusief btw (EUR)',
        'btw-tarief naam', 'btw', 'begin periode', 'eind periode'
    ]);

    const exportRows = makeExportRows(dataObj);
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
    const dateStampFormat = (process.env.AWS_SAM_LOCAL) ? 'YYYYMMDD' : 'YYYYMMDD HHmmss';
    const exportName = 'purchase-export-' + moment().format(dateStampFormat) + '.xlsx';

    const exportFile = workbook.xlsx.writeBuffer()
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

    // create new Summary file
    const allRecords = dataObj.purchRecords.concat(dataObj.recRecords);
    const newSums = [];
    for (let i = 0; i < dataObj.oldSums.length; i++) {
        const oldSum = dataObj.oldSums[i];
        var newSum = oldSum;
        for (let j = 0; j < allRecords.length; j++) {
            const record = allRecords[j];
            if (record.id === oldSum.id) {
                newSum = Object.assign({}, oldSum, { fileName: exportName, mutations: [] });
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

// Helper function to create new rows for export
function makeExportRows(dataObj) {
    const allRecords = dataObj.purchRecords.concat(dataObj.recRecords);
    var exportRows = [];
    for (let i = 0; i < allRecords.length; i++) {
        const item = allRecords[i];
        for (let j = 0; j < item.details.length; j++) {
            const detail = item.details[j];
            const newRow = makeDetailRow(item, detail, dataObj);
            exportRows.push(newRow)
        }
    }
    return exportRows;
}

// to rows per detail for export
function makeDetailRow(record, detail, dataObj) {
    var newRow = [];
    // id, including link
    newRow.push({
        text: record.id,
        hyperlink: 'https://moneybird.com/' + adminCode + '/documents/' + record.id,
        tooltip: 'Klik om naar Moneybird doc te gaan'
    });
    newRow.push(record.reference);
    newRow.push(record.state);
    newRow.push(record.date);
    newRow.push(record.due_date);
    newRow.push(record.contact.company_name);
    newRow.push(record.contact.customer_id);
    newRow.push(record.currency);
    newRow.push(record.paid_at);
    newRow.push(detail.amount);
    newRow.push(tryParse(detail.amount_decimal));
    newRow.push(detail.description);
    newRow.push(getField('name', detail.ledger_account_id, dataObj.ledgers));
    newRow.push(tryParse(getField('account_id', detail.ledger_account_id, dataObj.ledgers)));
    newRow.push(tryParse(detail.total_price_excl_tax_with_discount));
    const taxrate = tryParse(getField('percentage', detail.tax_rate_id, dataObj.taxRates))
    newRow.push(taxrate);
    newRow.push(tryParse(detail.price));
    const eurPriceEx = tryParse(detail.total_price_excl_tax_with_discount_base);
    newRow.push(eurPriceEx);
    const vatAmount = Math.round(eurPriceEx * taxrate) / 100;
    newRow.push(eurPriceEx + vatAmount);
    newRow.push(getField('name', detail.tax_rate_id, dataObj.taxRates));
    newRow.push(vatAmount);
    newRow.push(getPeriod('from', detail.period));
    newRow.push(getPeriod('to', detail.period));
    return newRow;
}

// Delete handler (to update summary and delete public file)
function exportDeleteHandler(event) {
    const filename = (process.env.AWS_SAM_LOCAL && event.queryStringParameters && event.queryStringParameters.filename) ?
        event.queryStringParameters.filename : JSON.parse(event.body).filename;
    console.log('got here');
    if (!filename || filename.slice(0, 16) !== 'purchase-export-') return response(403, 'Bad request');

    return Promise.all([
        getFile('incoming-summary-list.json', publicBucket),
        filename
    ])
        .then(updateFiles)
        .then(res => response(200, res[2]))
        .catch(err => response(500, "Oops, server error " + err))
}

function updateFiles(data) {
    const oldSums = data[0];
    const filename = data[1];
    var fileInExport = false;
    var newSums = [];
    for (let i = 0; i < oldSums.length; i++) {
        const item = oldSums[i];
        if (item.fileName && item.fileName === filename) {
            delete item.fileName;
            fileInExport = true;
            newSums.push(item);
        } else {
            newSums.push(item);
        }
    }
    if (!fileInExport) return deletePromise({
        Bucket: publicBucket,
        Key: filename
    });

    return Promise.all([
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
        }),
        newSums
    ])
}

// helper to get data from MoneyBird
function getField(fieldName, id, mbList) {
    var value = null;
    for (let i = 0; i < mbList.length; i++) {
        const item = mbList[i];
        if (item.id === id) { value = item[fieldName] }
    }
    return value;
}

// helper to try parse
function tryParse(value) {
    var outVal = parseFloat(value);
    if (isNaN(outVal)) {
        return value;
    } else {
        return outVal;
    }
}

// helper to extract period
function getPeriod(type, period) {
    if (typeof period !== 'string' || period.length !== 18) return null;
    const start = (type === 'from') ? 0 : 10;
    return new Date(
        parseInt(period.slice(start, start + 4)),
        parseInt(period.slice(start + 4, start + 6)),
        parseInt(period.slice(start + 6, start + 8))
    )
}