const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = process.env.TEST_TMPDIR || '/tmp';
const services = [
    'pcm-core',
    'sp-client',
    'ds-auth-adapter',
    'ds-fhir-server'
];

test('service loggers load shared log policy in isolated container-like layout', () => {
    for (const service of services) {
        const tmp = fs.mkdtempSync(path.join(tmpRoot, `${service}-logger-runtime-`));
        const appDir = path.join(tmp, 'app');
        const appSrcDir = path.join(appDir, 'src');
        const sharedDir = path.join(tmp, 'shared');
        const logsDir = path.join(tmp, 'logs');

        fs.mkdirSync(appSrcDir, { recursive: true });
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.copyFileSync(
            path.join(repoRoot, 'src', service, 'src', 'logger.js'),
            path.join(appSrcDir, 'logger.js')
        );
        for (const file of ['logger.js', 'log-policy.js', 'log-event.js', 'trace-context.js']) {
            fs.copyFileSync(path.join(repoRoot, 'src/shared', file), path.join(sharedDir, file));
        }

        const result = spawnSync(process.execPath, ['-e', [
            "const logger = require('./src/logger');",
            "logger.info('runtime import smoke patient=000000018?identifier=000000018', {",
            " authorization: 'Bearer secret-credential',",
            " client_assertion: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',",
            " patient_identifier: '000000018',",
            " body: { resourceType: 'Patient', identifier: [{ value: '000000018' }] },",
            " url: '/fhir/Patient?identifier=000000018',",
            " aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE'",
            "});",
            "console.log(logger.classifyRoute ? logger.classifyRoute('/fetch-data').category : 'ok');"
        ].join('')], {
            cwd: appDir,
            env: {
                ...process.env,
                LOG_DIR: logsDir,
                NODE_PATH: path.join(repoRoot, 'node_modules')
            },
            encoding: 'utf8'
        });

        try {
            assert.equal(result.status, 0, `${service} logger failed: ${result.stderr || result.stdout}`);
            const logFile = path.join(logsDir, 'current.log');
            assert.match(result.stdout, /\[INFO\] runtime import smoke/);
            assert.ok(fs.existsSync(logFile), `${service} did not write current.log`);
            const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
            assert.equal(entry.details.authorization, 'Bearer secret-credential');
            assert.match(entry.details.client_assertion, /^eyJ/);
            assert.equal(entry.details.patient_identifier, '000000018');
            assert.equal(entry.details.body.identifier[0].value, '000000018');
            assert.equal(entry.details.url, '/fhir/Patient?identifier=000000018');
            assert.equal(entry.details.aws_access_key_id, '[AWS_CREDENTIAL_BLOCKED]');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
});
