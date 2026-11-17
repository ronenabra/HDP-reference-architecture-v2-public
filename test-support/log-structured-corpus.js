'use strict';
/** Small shared synthetic corpus for writer/reader/export and browser fidelity. */
const fs = require('node:fs'), path = require('node:path');
const { createLogger } = require('../src/shared/logger');
const TOKEN = 'opaque-token-exact-☃-double//slash';
const jwt = [ { alg: 'ES256', typ: 'JWT' }, { sub: '<script>literal</script>', exp: 0, name: 'שלום' } ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.signature';
/** Write through the actual shared logger, preserving a read-only source manifest. */
function writeStructuredCorpus(root) {
    const directory = path.join(root, 'pcm-core'); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'current.log'); fs.writeFileSync(file, '');
    const before = process.env.LOG_DIR; process.env.LOG_DIR = directory;
    const logger = createLogger({ service: 'pcm-core' });
    if (before === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = before;
    let deep = 'deep value target'; for (let index = 0; index < 80; index++) deep = { next: deep };
    const shared = { identifier: { system: 'synthetic', value: 'Patient/demo' }, nested: [null, false, 0, '', {}, []] };
    const issuanceRecord = { kind: 'data_source_access', iat: 100, exp: 130, scope: 'patient/Observation.s?status=final patient/Patient.s', pcm_authentication_context: { correlation_verified: false }, lineEndings: '  first\r\nsecond\nthird\r\tשלום', authorization_details: [shared], authorization: { evidence: JSON.parse(JSON.stringify(shared)) }, long: 'long synthetic literal <script>window.UNTRUSTED=true</script> '.repeat(1800), deep };
    const rows = [
        ['Opaque issuance fixture', { type: 'TOKEN_ISSUED', kind: issuanceRecord.kind, access_token: TOKEN, issuanceRecord, scope: issuanceRecord.scope, decision: 'issued', flowId: 'structured-flow', correlationId: 'structured-correlation', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }],
        ['Legacy token fixture', { type: 'TOKEN_ISSUED', kind: 'management' }],
        ['Unknown field fixture', JSON.parse('{"type":"FUTURE_SCHEMA","":{"a.b":[null,false,0,"",{},[]]},"__proto__":{"<script>":"untrusted literal"},"wide":[]}')],
        ['Recorded HTTP fixture', { type: 'OUTGOING_RESPONSE', method: 'POST', url: '/token//original?count=0', status: 200, body: { access_token: jwt, empty: '' } }],
        ['Recorded denial fixture', { type: 'TOKEN_AUTHORIZATION_DENIED', decision: 'denied', reason: 'invalid_scope', requestedScope: 'system/Patient.s?_count=11', active: false, status: 0, unknown: '<img src=x onerror="window.UNTRUSTED=true">' }],
        ['Malformed assertion fixture', { type: 'REQUEST', body: { client_assertion: 'malformed.original.value' } }],
        ['AWS excluded fixture', { type: 'TOKEN_ISSUED', access_token: TOKEN, issuanceRecord: { iat: 100, exp: 130, AWS_SECRET_ACCESS_KEY: 'owned-synthetic-aws-secret' } }]
    ];
    rows[2][1].wide = Array.from({ length: 16000 }, (_, index) => index === 15999 ? 'last search target' : index);
    for (const [message, details] of rows) logger.info(message, details);
    const bytes = fs.readFileSync(file);
    const emitted = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    return { file, bytes: bytes.length, token: TOKEN, jwt, emitted, lines: emitted.length, issuanceRecord };
}
module.exports = { TOKEN, writeStructuredCorpus };
