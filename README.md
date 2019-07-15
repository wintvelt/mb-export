# Moblybird Finvision export

This is a function that handles requests for exporting incoming invoices.
For syncing with ExactOnline (or any other platform).
Built for Finvision.

To update the following files on the public S3 store:

* [incoming-summary-list.json](https://moblybird-export-files.s3.eu-central-1.amazonaws.com/incoming-summary-list.json) file with summaries of all incoming purchasing invoices and receipts
* [file-list-summary](https://moblybird-export-files.s3.eu-central-1.amazonaws.com/file-list-summary.json) list of all export files with filename, createdate, incomingCount
* export files with name convention `purchase-export-[datetime-stamp].xlsx` 

These files can be accessed by regular `GET` requests (also from browser),  
at the path: https://moblybird-export-files.s3.eu-central-1.amazonaws.com/ (folder is not public)

It has the following endpoints:

* `/sync` to sync with latest version of Moneybird
    * `GET`
        * Requires `Authorization` in header for Moneybird 
* `/export`
    * `POST`
        * Requires `Authorization` in header for Moneybird 
        * Request `Body` requires `ids` with id-list to create export file
        * Creates a new export file
* `/files` to retrieve a file from the public S3 storage
    * `GET`
        * needs `?filename=` parameter
        * retrieves a file from S3
    * `POST`
        * Request `Body` requires `{ filename, data }` of file to store
    * `DELETE`
        * Request `Body` requires `{ filename }` of file to delete

## Files stored for sync internally
The function keeps the following files on S3 for synchronisation:

* `id-list-purchasing.json` ids and version numbers of latest state in Moneybird
* `id-list-receipts.json` (same for receipts)

---

# Inner workings
## Export functions under the hood
The export function has the following flow:

1. Retrieve `incoming-summary-list.json` from public S3 (in `exportHandler`)
    * pass file on to next, together with id-list from request and auth
2. Obtain relevant data from Moneybird (`retrieve`)
    * filter summary-list using id-list from request (if empty, then abort)
    * retrieve from Moneybird files with data to create export:
        * ledgers
        * tax-rates
        * Moneybird records for purchase_invoices to export
        * Moneybird records for receipts to export
    * pass files to next, together with
        * unfiltered summary-list
3. Create the export table (`createExport`)
    * On public S3 store save:
        * `purchase-export-[datetime-stamp].xlsx`
        * `incoming-summary-list.json` (with updated export filename)


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
