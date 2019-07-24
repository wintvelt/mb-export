// Moneybird API helpers
const { adminCode } = require('./SECRETS');
const { fetch, safeParse } = require('./helpers-api');

const base_url = 'moneybird.com';

exports.getMoneyData = function (path, auth) {
    const fullpath = '/api/v2/' + adminCode + path;
    // headers for request
    const options = {
        hostname: base_url,
        path: fullpath,
        method: 'GET',
        headers: {
            Authorization: auth
        }
    };
    return fetch(options);
}

// for getting a large set of data based on POST of IDs (following synchronisation)
exports.retrieveMoneyData = function (path, auth, data = []) {
    if (data.length === 0) return [];
    if (data.length <= 100) return retrieveSingleMoneyData(path, auth, data);

    // make list of lists
    const dataLOL = makeLOL(data, 100);
    const promises = dataLOL.map(singleData => retrieveSingleMoneyData(path, auth, singleData)
        .then(res => safeParse(res)));
    console.log('made moneybird promises');
    return Promise.all(promises)
        .then(results => {
            return new Promise((resolve, reject) => {
                resolve(flattenLOL(results))
            })
        })
        .catch(err => err);
}

const retrieveSingleMoneyData = function (path, auth, data = []) {
    console.log('getting money data');
    console.log(path);
    console.log(data.length);
    if (data.length === 0) return '';
    const fullpath = '/api/v2/' + adminCode + path;
    const body = JSON.stringify({ ids: data });
    const options = {
        hostname: base_url,
        path: fullpath,
        method: 'POST',
        // mode: "cors",
        cache: "no-cache", // *default, no-cache, reload, force-cache, only-if-cached
        headers: {
            Authorization: auth,
            "Content-Type": "application/json",
            "Content-Length": body.length
        },
        body: body
    };
    return fetch(options);
}

// make list of lists
function makeLOL(array, size = 100, outArr = []) {
    if (array.length <= size) return [...outArr, array]
    return makeLOL(array.slice(size), size, [...outArr, array.slice(0, size)]);
}

// flatten list if lists
function flattenLOL(array) {
    var outArr = [];
    for (let i = 0; i < array.length; i++) {
        const flatArr = array[i];
        outArr = outArr.concat(flatArr);
    }
    return outArr;
}