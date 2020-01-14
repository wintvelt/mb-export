// Helpers to create excel workbook
const { adminCode } = require('./SECRETS');

// Helper function to create new rows for excel export
exports.makeExportRows = function (dataObj) {
    console.log('begin make export rows');

    const allRecords = dataObj.purchRecords.concat(dataObj.recRecords);
    var exportRows = [];
    for (let i = 0; i < allRecords.length; i++) {
        const item = allRecords[i];
        if (item.details) {
            for (let j = 0; j < item.details.length; j++) {
                const detail = item.details[j];
                const newRow = makeDetailRow(item, detail, dataObj);
                exportRows.push(newRow)
            }
        }
    }
    const allCurrentIds = allRecords.map(it => it.id);
    const allExportIds = dataObj.body.ids;
    allExportIds.forEach(id => {
        const oldSum = dataObj.oldSums.find(it => it.id === id);
        if (oldSum && !allCurrentIds.includes(id)) {
            const newRow = makeDeletedRow(oldSum);
            exportRows.push(newRow);
        }
    });
    return exportRows;
}

// to rows per detail for export
function makeDetailRow(record, detail, dataObj) {
    const taxrate = tryParse(getField('percentage', detail.tax_rate_id, dataObj.taxRates));
    const eurPriceEx = tryParse(detail.total_price_excl_tax_with_discount_base);
    const vatAmount = Math.round(eurPriceEx * taxrate) / 100;

    const cellValues = [
        record.id,
        {
            text: 'link',
            hyperlink: 'https://moneybird.com/' + adminCode + '/documents/' + record.id,
            tooltip: 'Klik om naar Moneybird doc te gaan',
        },
        record.reference,
        record.state,
        record.date,
        record.due_date,
        record.contact.company_name,
        record.contact.customer_id,
        record.currency,
        record.paid_at,
        detail.amount,
        tryParse(detail.amount_decimal),
        detail.description,
        getField('name', detail.ledger_account_id, dataObj.ledgers),
        tryParse(getField('account_id', detail.ledger_account_id, dataObj.ledgers)),
        tryParse(detail.total_price_excl_tax_with_discount),
        taxrate,
        tryParse(detail.price),
        eurPriceEx,
        eurPriceEx + vatAmount,
        getField('name', detail.tax_rate_id, dataObj.taxRates),
        vatAmount,
        getPeriod('from', detail.period),
        getPeriod('to', detail.period),
        record.created_at.slice(0, 10),
        (record.updated_at) ? record.updated_at.slice(0, 10) : null,
    ]
    var newRow = [];
    for (let i = 0; i < cellValues.length; i++) {
        const cellValue = cellValues[i];
        if (cellValue) newRow[i] = cellValue
    }

    return newRow;
}

function makeDeletedRow(record) {
    let newRow = [record.id];
    newRow[2] = 'Document verwijderd';
    newRow[3] = 'DELETED';
    newRow[6] = `${record.fileName} bevat meest recente detailgegevens`;
    newRow[11] = {
        text: 'link',
        hyperlink: 'https://moblybird-export-files.s3.eu-central-1.amazonaws.com/'+record.filename,
        tooltip: 'Klik om naar Excel doc te gaan',
    }
    return newRow;
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