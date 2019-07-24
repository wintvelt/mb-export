# Moblybird Finvision export

This is a function that handles requests for exporting incoming invoices.
For syncing with ExactOnline (or any other platform).
Built for Finvision.

It keeps track of all exports that were made. So you can ensure that no documents are duplicated in export. Or to only make export of mutations, for check and processing later.

To update the following files on the public S3 store:

* [incoming-summary-list.json](https://moblybird-export-files.s3.eu-central-1.amazonaws.com/incoming-summary-list.json) file with summaries of all incoming purchasing invoices and receipts
* export files with name convention `[unlogged]-purchase-export-[datetime-stamp]-[optional extension].xlsx` 

These files can be accessed by regular `GET` requests (also from browser),  
at the path: https://moblybird-export-files.s3.eu-central-1.amazonaws.com/ (files are public, folder is not)

## Public file structure and usage
The `incoming-summary-list.json` file is a JSON list of objects with the following structure:

* `id`: Moneybird document id, also used for internal reference (e.g. "260703856723232639")
* `type`: Moneybird document type, (can be "purchase_invoice" | "receipt)
* `createDate`: Date when the document was created in Moneybird (e.g. "2019-07-11T12:03:14.066Z")
* `invoiceDate`: Date on the invoice (e.g. "2019-07-11")
* `status`: State of the document in Moneybird (can be "new", "open", "late", "pending_payment", "late", "paid")
* `fileName`: (optional) latest export file that included this document (e.g. "purchase-export-20190701 091055.xlsx")
    * this field with not exist if a) document was never exported or b) latest sexport file was deleted through /export API
* `allFiles` : array of all files (including previous - undeleted - exports and unlogged files) that contain this doc
* `mutations`: List of mutations since the last export (NB: only invoicedate or status changes are tracked)
    * with the following structure
        * `fieldName` name of field that changed (can be "status", "invoiceDate", "type", "other")
        * `oldValue` (only for status or invoiceDate)
        * `newvalue`
    * When a document is added to an export file, mutations will be cleared

The file (available via public URL) can be used for the following actions:

* show number of documents not yet exported
    * with date-ranges (created and invoice date)
    * with selection filters to export only a subset
* selection tools for mutated documents (so they can be exported again)

* show a list of available export files, each with summary info, e.g.
    * number of documents in export
    * number of documents in this export with mutations since export
    * daterange from-to when these documents were created
    * daterange from-to of invoice dates
    * option to download the related export file (again)
    * option to delete an export file (so that related docs can be exported again)
* show number of documents not yet exported
    * with date-ranges (created and invoice date)
    * with selection filters to export only a subset
* selection tools for mutated documents (so they can be exported again)


## API Endpoints
This package has the following endpoints:

* `/sync` to sync with latest version of Moneybird
    * `GET`
        * Requires `Authorization` in header for Moneybird
        * returns an updated incoming summary list (json)
* `/export`
    * `GET`
        * Retrieves `incoming-summary-list.json` file (from public S3), with date of latest sync
        * Returns json object with `{ list, syncDate }` structure
    * `POST`
        * Requires `Authorization` in header for Moneybird 
        * Request `Body` structured as `{ ids, ext, noLog }` 
            * `ids`: id-list of docs to include in export file
            * `ext`: (optional) extension to be added to export filename
            * `noLog`: (optional, default = false) when set to true, export will not be logged
        * Creates a new export file and returns new summary list as response
    * `DELETE`
        * Request `Body` requires `{ filename }` with name of export file to delete
        * Will update the summary file (to remove export indicator in items)
        * And delete the filename from public S3 bucket
        * returns an updated summary list as response

* `/files` to retrieve a file from the public S3 storage
    * `GET`
        * needs `?filename=` parameter
        * retrieves a file from S3
    * `POST` (**Unsafe**)
        * Request `Body` requires `{ filename, data }` of file to store
        * *Use with caution: overwriting official public files may break the state of sync*
    * `DELETE` (**Unsafe**)
        * Request `Body` requires `{ filename }` of file to delete
        * *Use with caution: deleting official public files may break the state of sync*



---

# Inner workings
## Files stored for sync internally
The function keeps the following files on S3 for synchronisation:

* `id-list-all-docs` contains id, type and version numbers of latest state in Moneybird

## Export functions under the hood
The export function has the following flow:

For `POST` (to create new export file)
1. Retrieve `incoming-summary-list.json` from public S3 (in `exportPostHandler`)
    * pass file on to next, together with 
        * auth (from request) to gain access to Moneybird
        * body from request with id-list, extension, and noLog flag
2. Obtain relevant data from Moneybird (`retrieve`)
    * filter summary-list using id-list from request (if empty, then abort)
    * retrieve from Moneybird files with data to create export:
        * ledgers
        * tax-rates
        * Moneybird records for purchase_invoices to export
        * Moneybird records for receipts to export
    * pass files to next, together with
        * unfiltered (original) summary-list
        * request body (for ext and noLog flag)
3. Create the export table (`createExport`)
    * On public S3 store save:
        * `[nolog-]purchase-export-[datetime-stamp]-[ext].xlsx`
        * `incoming-summary-list.json` with updated export filename and reset of mutations with exported items - this step is skipped if noLog flag is set to true

For `DELETE` (to delete an export file)
1. Retrieve `incoming-summary-list.json` from public S3 (in `exportDeleteHandler`)
    * pass file on to next, together with filename
2. Update summary list and delete file from public
    * Update the summary-list, to remove filename reference from relevant entries
    * only if there are updates to summary-list:
        * Save new `incoming-summary-list.json` on public S3 store
        * Delete the file from S3 store

## Sync function under the hood
The sync function has the following flow:

1. Retrieve raw data files from S3 and Moneybird (main `syncHandler`)
    * Retrieve files:
        * S3 last stored `id-list-purchasing.json` (may be empty)
        * Moneybird latest purchase_invoices (id and version)
        * S3 last stored `id-list-receipts.json` (may be empty)
        * Moneybird latest receipts (id and version)
    * Pass all docs on to next
2. Compare and retrieve relevant records (`compRetrieve`)
    * Compare latest and last stored
    * Retrieve files:
        * Moneybird Updated purchase_invoices
        * Moneybird New purchase_invoices
        * Moneybird Updated receipts
        * Moneybird New receipts
        * S3 last stored summaries of invoices
    * Also save files:
        * S3 latest `id-list-purchasing.json` (direct copy from Moneybird)
        * S3 latest `id-list-receipts.json` (direct copy from Moneybird)
    * Pass all results to next
3. Update summaries and save (`updSave`)
    * Create updated summary doc
    * Save files:
        * S3 updated summary list (on public S3)
        * Excel sheet with export (on public S3)
