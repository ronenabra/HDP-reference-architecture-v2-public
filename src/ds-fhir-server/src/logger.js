/** Service-specific binding for the shared structured logger. */
const fs = require('fs');
const path = require('path');
const local = path.join(__dirname, '..', '..', 'shared', 'logger');
const { createLogger } = require(fs.existsSync(`${local}.js`) ? local : '/shared/logger');

module.exports = createLogger({ service: 'ds-fhir-server', onFinished: require('on-finished') });
