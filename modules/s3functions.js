// Read and write files on S3
var { S3 } = require('aws-sdk');
const { secretID, secretKey, publicBucket } = require('./SECRETS');
const { response } = require('./helpers-api');


// get reference to S3 client 
var s3 = new S3({
    accessKeyId: secretID,
    secretAccessKey: secretKey,
    region: 'eu-central-1'
});


exports.fileHandler = function (event) {
    switch (event.httpMethod) {
        case 'GET':
            if (!event.queryStringParameters || !event.queryStringParameters.filename) return response(400, 'Bad request');
            const getParams = {
                Bucket: publicBucket,
                Key: decodeURI(event.queryStringParameters.filename)
            }
            return getPromise(getParams)
                .then(data => {
                    const buffer = Buffer.from(data.Body);
                    return response(200, buffer.toString('utf8'));
                })
                .catch(err => response(500, 'server error-thing'));

        case 'POST':
            if (!event.body) return response(400, 'Bad request');
            const postBody = JSON.parse(event.body);
            if (!postBody.filename || !postBody.data) return response(400, 'Bad request');
            const postParams = {
                Bucket: publicBucket,
                Key: postBody.filename,
                Body: JSON.stringify(postBody.data),
                ContentType: 'application/json'
            }
            return putPromise(postParams)
                .then(data => {
                    const buffer = Buffer.from(data.Body);
                    return response(200, buffer.toString('utf8'));
                })
                .catch(err => response(500, 'server error-thing'));

        case 'DELETE':
            if (!event.body) return response(400, 'Bad request');
            const delBody = JSON.parse(event.body);
            if (!delBody.filename) return response(400, 'Bad request');
            const delParams = {
                Bucket: publicBucket,
                Key: delBody.filename
            }
            return deletePromise(delParams)
                .then(data => response(200, data))
                .catch(err => response(500, 'server error-thing'));

        default:
            return response(405, 'not allowed');
    }

}

const getPromise = function (params) {
    return new Promise(function (resolve, reject) {
        s3.getObject(params,
            (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            }
        );
    });
}

const putPromise = function (params) {
    return new Promise(function (resolve, reject) {
        s3.putObject(params,
            (err, data) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(data)
                }
            }
        );
    });
}

const deletePromise = function (params) {
    return new Promise(function (resolve, reject) {
        s3.deleteObject(params,
            (err, data) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(data)
                }
            }
        );
    });
}

// File promise that always resolves (empty file returns [])
exports.getFile = function(fileName, bucket) {
    return getPromise({ Bucket: bucket, Key: fileName })
        .then(data => {
            const buffer = Buffer.from(data.Body);
            return new Promise((resolve, reject) => {
                resolve(JSON.parse(buffer.toString('utf8')));
            });
        })
        .catch(err => new Promise((resolve, reject) => resolve([])));
}

// File promise that always resolves (empty file returns [])
exports.getFileWithDate = function(fileName, bucket) {
    return getPromise({ Bucket: bucket, Key: fileName })
        .then(data => {
            const buffer = Buffer.from(data.Body);
            return new Promise((resolve, reject) => {
                const outObj = {
                    list: JSON.parse(buffer.toString('utf8')),
                    syncDate: data.LastModified
                }
                resolve(outObj);
            });
        })
        .catch(err => new Promise((resolve, reject) => resolve([])));
}
exports.getPromise = getPromise;
exports.putPromise = putPromise;
exports.deletePromise = deletePromise;