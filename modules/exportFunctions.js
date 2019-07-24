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
    const body = (process.env.AWS_SAM_LOCAL && !event.body) ? { ids: ["260703856723232639", "260736893579167014"] }
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
    if (exportRows.length > 0) {
        var workbook = new Excel.Workbook();
        workbook.creator = 'Wouter';
        workbook.lastModifiedBy = 'Wouter';
        workbook.created = new Date(2019, 7, 1);

        var sheet = workbook.addWorksheet('Moblybird export');
        sheet.addRow([
            'id', 'referentie', 'status', 'datum', 'vervaldatum', 'contact', 'contactnummer', 'valuta', 'betaald op',
            'aantal', 'aantal (decimaal)', 'omschrijving', 'categorie', 'categorienummer', 'totaalprijs exclusief btw',
            'btw-tarief', 'totaalprijs inclusief btw', 'totaalprijs exclusief btw (EUR)', 'totaalprijs inclusief btw (EUR)',
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
        var newSum = Object.assign({}, oldSum);
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

// Helper function to create new rows for export
function makeExportRows(dataObj) {
    console.log('begin make export rows');

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
    newRow.push(record.created_at.slice(0,10));
    newRow.push(record.updated_at.slice(0,10));
    return newRow;
}

// Delete handler (to update summary and delete public file)
function exportDeleteHandler(event) {
    const filename = (process.env.AWS_SAM_LOCAL && event.queryStringParameters && event.queryStringParameters.filename) ?
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