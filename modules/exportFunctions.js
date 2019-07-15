// functions to create an export file
const { response, safeParse } = require('./helpers-api');
const { putPromise, getFile } = require('./s3functions');
const { publicBucket, accessToken, adminCode } = require('./SECRETS');
const { getMoneyData, retrieveMoneyData } = require('./helpers-moneybird');

const Excel = require('exceljs/modern.nodejs');
const moment = require('moment');

exports.exportHandler = function (event) {
    if (event.httpMethod !== 'GET') return response(405, 'Method not allowed');

    const body = (process.env.AWS_SAM_LOCAL) ? { ids: ["260703856723232639", "260736893579167014"] } : JSON.parse(event.body);
    const auth = (process.env.AWS_SAM_LOCAL) ? 'Bearer ' + accessToken : event.headers.Authorization;

    if (!body.ids) return response(403, 'Bad request');

    return Promise.all([
        getFile('incoming-summary-list.json', publicBucket),
        body.ids,
        auth
    ])
        .then(retrieve)
        .then(createExport)
        .then(res => response(200, res))
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
        'id',
        'referentie',
        'status',
        'datum',
        'vervaldatum',
        'contact',
        'contactnummer',
        'valuta',
        'betaald op',
        'aantal',
        'aantal (decimaal)',
        'omschrijving',
        'categorie',
        'categorienummer',
        'totaalprijs exclusief btw',
        'btw-tarief',
        'totaalprijs inclusief btw',
        'totaalprijs exclusief btw (EUR)',
        'totaalprijs inclusief btw (EUR)',
        'btw-tarief naam',
        'btw',
        'begin periode',
        'eind periode'
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
    const exportName = 'purchase-export-' + moment().format('YYYYMMDD') + '.xlsx';

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
        })
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
    newRow.push(getLedger('name', detail.ledger_account_id, dataObj.ledgers));
    newRow.push(tryParse(getLedger('account_id', detail.ledger_account_id, dataObj.ledgers)));
    newRow.push(tryParse(detail.total_price_excl_tax_with_discount));
    const taxrate = tryParse(getTax('percentage', detail.tax_rate_id, dataObj.taxRates))
    newRow.push(taxrate);
    newRow.push(tryParse(detail.price));
    const eurPriceEx = tryParse(detail.total_price_excl_tax_with_discount_base);
    newRow.push(eurPriceEx);
    const vat = eurPriceEx * taxrate / 100;
    newRow.push(eurPriceEx + vat);
    newRow.push(getTax('name', detail.tax_rate_id, dataObj.taxRates));
    newRow.push(vat);
    newRow.push(getPeriod('from', detail.period));
    newRow.push(getPeriod('to', detail.period));
    return newRow;
}

// helper to get data from ledgers
function getLedger(fieldName, id, ledgers) {
    var value = null;
    for (let i = 0; i < ledgers.length; i++) {
        const ledger = ledgers[i];
        if (ledger.id === id) { value = ledger[fieldName] }
    }
    return value;
}

// helper to get data from tax rates
function getTax(fieldName, id, rates) {
    var value = null;
    for (let i = 0; i < rates.length; i++) {
        const rate = rates[i];
        if (rate.id === id) { value = rate[fieldName] }
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