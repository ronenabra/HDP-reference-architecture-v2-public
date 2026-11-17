'use strict';
/** Reuse pinned desktop/native-touch browser settings with a real owned gateway. */
const base = require('./log-search.config');
module.exports = { ...base, testMatch: 'gateway-arrival.spec.js',
    use: { ...base.use, baseURL: 'http://127.0.0.1:43186' }, webServer: undefined };
