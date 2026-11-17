'use strict';
/** Owned fixture on loopback and mapped insecure HTTP for real clipboard qualification. */
const base = require('./log-structured.config');
module.exports = { ...base, testMatch: 'log-copy.spec.js', timeout: 90000,
    use: { ...base.use, launchOptions: { args: ['--no-proxy-server', '--host-resolver-rules=MAP logs-copy.invalid 127.0.0.1'] } } };
