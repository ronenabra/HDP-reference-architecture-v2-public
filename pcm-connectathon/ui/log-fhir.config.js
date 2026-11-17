'use strict';
/** Reuse the maintained real-template fixture and two focused Chromium projects. */
const base = require('./log-structured.config');
module.exports = { ...base, testMatch: 'log-fhir.spec.js' };
