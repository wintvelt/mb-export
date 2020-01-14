// API helpers
const https = require('https');

// Helper for response
// constructor for response to requester
exports.response = function (code, message) {
    var msg;
    if (typeof message === 'string') {
        msg = message
    } else {
        try {
            msg = JSON.stringify(message, null, 2);
        } catch (error) {
            msg = 'onleesbare boodschap';
        }
    }
    return {
        'isBase64Encoded': false,
        'statusCode': code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
            'Access-Control-Max-Age': '86400',
            'Access-Control-Allow-Credentials': true,
            'Access-Control-Allow-Headers': 
                'X-Requested-With, X-HTTP-Method-Override, Content-Type, Authorization, Origin, Accept'
        },
        'body': msg
    };
};

exports.fetch = function (options) {
    return new Promise(function (resolve, reject) {

        const request = https.request(options, (res) => {
            console.log('fetch inside request');
            console.log(options.path);
            console.log(options.method);
            if (res.statusCode < 200 || res.statusCode > 299) {
                console.log('fetch error '+res.statusCode);
                reject(new Error('Failed to load, status code: ' + res.statusCode));
            }
            // temporary data holder
            const body = [];
            // on every content chunk, push it to the data array
            res.on('data', (chunk) => {
                console.log('fetch did get data',options.path);
                body.push(chunk)
            });
            // we are done, resolve promise with those joined chunks
            res.on('end', () => {
                console.log('fetch finished', options.path);
                resolve(body.join(''))
            });
        });
        // handle connection errors of the request
        request.on('error', (err) => reject(Error(err)));
        // post the request to server to get some data
        if (options.method === 'POST') request.write(options.body);
        request.end();
    });
}

// to safely Parse data from an API (turn into object if possible/ needed)
exports.safeParse = function (file) {
    if (typeof file !== "string") return file;
    try {
        return JSON.parse(file);
    } catch (error) {
        return []
    }
}