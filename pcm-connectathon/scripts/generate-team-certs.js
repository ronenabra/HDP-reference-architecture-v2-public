#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot, run, writeJson, requireSafeTeamId, DEFAULT_TEAMS_ROOT } = require('./lib');

const args = parseArgs(process.argv);
const teamId = args['team-id'] || 'local';
requireSafeTeamId(teamId);

const root = repoRoot();
const destination = path.resolve(root, args.out || path.join(args['teams-root'] || DEFAULT_TEAMS_ROOT, teamId, 'certs'));
const outDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pcm-team-credentials-'));
const { provisionLeaf, publishFiles } = require('../../src/shared/role-credentials');
try {
if (fs.existsSync(destination)) fs.cpSync(destination, outDir, { recursive: true });

function openssl(...opensslArgs) {
    run('openssl', opensslArgs, { cwd: outDir });
}

function generateCa(prefix, subject) {
    const certPath = path.join(outDir, `${prefix}.crt`), keyPath = path.join(outDir, `${prefix}.key`);
    if (fs.existsSync(certPath) || fs.existsSync(keyPath)) {
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) throw new Error('Incomplete existing CA; explicit repair is required before provisioning');
        const cert = new (require('crypto').X509Certificate)(fs.readFileSync(certPath));
        if (!cert.ca || !cert.checkPrivateKey(require('crypto').createPrivateKey(fs.readFileSync(keyPath)))) throw new Error('Existing CA certificate/key is invalid or mismatched');
        return;
    }
    openssl('genrsa', '-out', `${prefix}.key`, '2048');
    openssl('req', '-x509', '-new', '-nodes', '-key', `${prefix}.key`, '-sha256', '-days', '1024', '-out', `${prefix}.crt`, '-subj', subject);
}

/** Provision or validate one leaf using the same role semantics as Admin. */
function generateCert(name, cn, sans, caPrefix = 'rootCA', keyType = 'rsa') {
    const assertion = keyType === 'ec' || keyType === 'ec384';
    return provisionLeaf({ directory: outDir, certName: `${name}.crt`, keyName: `${name}.key`,
        caName: `${caPrefix}.crt`, caKeyName: `${caPrefix}.key`, commonName: cn, sans: sans.filter(Boolean),
        algorithm: keyType === 'ec384' ? 'ES384' : assertion ? 'ES256' : 'RSA', assertion });
}

function thumbprint(fileName) {
    const result = require('child_process').spawnSync('openssl', ['x509', '-in', fileName, '-outform', 'DER'], { cwd: outDir });
    if (result.status !== 0) throw new Error(`failed to read ${fileName}`);
    return require('crypto').createHash('sha256').update(result.stdout).digest('base64url');
}

generateCa('rootCA', `/C=IL/ST=TelAviv/L=TelAviv/O=HDP-PCM-Connectathon/CN=${teamId}-Root-CA`);
generateCa('untrustedCA', `/C=IL/ST=Nowhere/L=Nowhere/O=HDP-PCM-Connectathon/CN=${teamId}-Untrusted-CA`);



generateCert('pcm-core', 'pcm-core', [args['pcm-api-host'], 'pcm-core']);
generateCert('presence-orchestrator', 'presence-orchestrator', ['presence-orchestrator']);
generateCert('sp-client', 'sp-client', [args['sp-host'], 'sp-client']);
generateCert('hospital-b-sp', 'hospital-b-sp', ['hospital-b-sp']);
generateCert('ds-gateway', 'ds-gateway', [args['ds-host'], 'ds-gateway', 'legacy-ds-gateway']);
generateCert('ds-fhir-server', 'ds-fhir-server', [args['ds-fhir-host'], 'ds-fhir-server']);
generateCert('untrusted-client', 'untrusted-client', ['untrusted-client'], 'untrustedCA');
// A separate P-256 key reaches the remote assertion boundary; it is never registered as trusted.
generateCert('untrusted-client-assertion', 'untrusted-client-assertion', [], 'untrustedCA', 'ec');
generateCert('sp-client-assertion-es384', 'sp-client-assertion-es384', [], 'rootCA', 'ec384');
generateCert('sp-client-assertion', 'sp-client-assertion', [], 'rootCA', 'ec');
try { generateCert('hospital-b-sp-assertion', 'hospital-b-sp-assertion', [], 'rootCA', 'ec384'); }
catch (error) { throw new Error(`${error.message}. Retained Doctor profiles require explicit preview/apply using migrate-doctor-profiles.js; provisioning changed no live files`); }
generateCert('ds-gateway-assertion', 'ds-gateway-assertion', [], 'rootCA', 'ec');
generateCert('presence-orchestrator-assertion', 'presence-orchestrator-assertion', [], 'rootCA', 'ec');
for (const role of ['authentication-orchestrator', 'discovery-orchestrator']) {
    generateCert(role, role, [role]);
    generateCert(`${role}-assertion`, `${role}-assertion`, [], 'rootCA', 'ec');
}

for (const hoId of ['ho-a', 'ho-b', 'ho-c']) {
    generateCert(`${hoId}-gateway`, `${hoId}-gateway`, [args[`${hoId}-host`], `${hoId}-gateway`]);
    generateCert(`${hoId}-gateway-mtls`, `${hoId}-gateway-mtls`, [`${hoId}-gateway-mtls`]);
    generateCert(`${hoId}-gateway-assertion`, `${hoId}-gateway-assertion`, [], 'rootCA', 'ec');
    // The same named-HO certificate is used by the short-lived private import
    // service, whose stable Compose alias must still pass TLS hostname checks.
    generateCert(`${hoId}-hapi`, `${hoId}-hapi`, [`${hoId}-hapi`, 'clinical-import-hapi']);
}

const thumbprints = {
    pcm: thumbprint('pcm-core.crt'),
    presenceOrchestrator: thumbprint('presence-orchestrator.crt'),
    presenceOrchestratorAssertion: thumbprint('presence-orchestrator-assertion.crt'),
    serviceProvider: thumbprint('sp-client-assertion.crt'),
    serviceProviderAssertion: thumbprint('sp-client-assertion.crt'),
    hospitalBServiceProviderAssertion: thumbprint('hospital-b-sp-assertion.crt'),
    referenceDataSource: thumbprint('ds-gateway.crt'),
    referenceDataSourceAssertion: thumbprint('ds-gateway-assertion.crt'),
    dsFhirServer: thumbprint('ds-fhir-server.crt'),
    untrustedClient: thumbprint('untrusted-client.crt')
};
for (const hoId of ['ho-a', 'ho-b', 'ho-c']) {
    thumbprints[hoId] = {
        gatewayServer: thumbprint(`${hoId}-gateway.crt`),
        gatewayMtls: thumbprint(`${hoId}-gateway-mtls.crt`),
        gatewayAssertion: thumbprint(`${hoId}-gateway-assertion.crt`),
        hapiServer: thumbprint(`${hoId}-hapi.crt`)
    };
}
writeJson(path.join(outDir, 'thumbprints.json'), thumbprints);

const material = {};
function collect(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = prefix + entry.name, filename = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(filename, name + '/');
        else if (entry.isFile()) {
            const bytes = fs.readFileSync(filename), previous = path.join(destination, name);
            if (!fs.existsSync(previous) || !fs.readFileSync(previous).equals(bytes)) material[name] = bytes;
        } else throw new Error('Credential inventory must contain regular files and directories');
    }
}
collect(outDir);
publishFiles(destination, material);
console.log(`Generated or validated demo certs in ${path.relative(root, destination)}`);
} finally { fs.rmSync(outDir, { recursive: true, force: true }); }
