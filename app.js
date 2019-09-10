// dependencies
const { fileHandler } = require('./modules/s3functions');
const { syncHandler } = require('./modules/syncFunctions');
const { exportHandler } = require('./modules/exportFunctions');
const { response } = require('./modules/helpers-api');

exports.handler = async function (event) {

    switch (event.path) {
        case '/files':
            return fileHandler(event);
            break;

        case '/sync':
            return syncHandler(event);
            break;

        case '/export':
            return exportHandler(event);
            break;

        default:
            return response(404, 'not found');
            break;
    }

}