'use strict';

/** Read-only Admin inventory and bound public download. Facts omit PEM; downloads emit only a public certificate. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { signingAlgorithm } = require('../../shared/assertion-keys');

/** Read only regular files contained by the backend certificate directory. */
function readMaterial(directory, name) {
    if (typeof name !== 'string' || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw Error('Unavailable material');
    const target = fs.realpathSync(path.join(directory, name)), base = fs.realpathSync(directory);
    if (!target.startsWith(base + path.sep) || !fs.statSync(target).isFile()) throw Error('Unavailable material');
    return fs.readFileSync(target);
}

/** Project configured owner/role bindings and current files, independently of listener adoption.
 * @param {object} config Validated team configuration.
 * @param {string} directory Backend certificate directory.
 * @param {object} options Exact normalized sources, current client registrations and inspection time.
 * @returns {object} Detached public facts, owners, revision and check time; no private material.
 */
function inventory(config, directory, { sources = [], clients = [], now = Date.now(), files = [] } = {}) {
    const bindings = [], owners = new Map();
    const owner = (id, name, kind, context, clientId, enabled = true) => {
        const value = { id, name: name || id, kind, context, clientId, enabled };
        owners.set(id, value); return value;
    };
    const add = (who, role, pair = {}, registration = {}, algorithm) => bindings.push({ owner: who, role, cert: pair.cert, key: pair.key, registration, requestedAlgorithm: algorithm });
    const rollover = (who, registration, defaultCert) => {
        for (const [algorithm, names] of Object.entries(registration.assertionCertificates || {})) for (const cert of Array.isArray(names) ? names : [names]) {
            if (cert !== defaultCert) add(who, 'assertion rollover', { cert }, registration, algorithm);
        }
    };
    for (const [role, roles] of Object.entries(config.certificateRoles || {})) {
        if (role === 'referenceDataSource' && sources.some(source => source.compatibilityOnly || source.id === config.organizations.referenceDataSource?.id)) continue;
        const registration = config.organizations?.[role] || config.oauthClients?.[role] || {};
        const kind = role === 'untrustedClient' ? 'Negative fixture' : config.oauthClients?.[role] ? 'System client' : /serviceprovider/i.test(role) ? 'SP app' : role === 'pcm' ? 'PCM' : role === 'dsFhirServer' || role === 'referenceDataSource' ? 'Infrastructure' : 'Unknown owner';
        const who = owner(registration.id || registration.clientId || `role:${role}`, registration.name || role, kind,
            kind === 'SP app' ? { section: 'apps', providerRole: role } : null, registration.clientId);
        for (const [purpose, pair] of Object.entries(roles)) add(who, purpose, pair, registration,
            Object.entries(registration.assertionCertificates || {}).find(([, names]) => (Array.isArray(names) ? names : [names]).includes(pair.cert))?.[0]);
        rollover(who, registration, roles.assertion?.cert);
    }
    for (const source of sources) {
        const auth = source.pcmClientAuth || {}, ho = config.healthOrganizations?.find(item => item.id === source.healthOrganizationId);
        const who = owner(source.id, source.name, source.compatibilityOnly ? 'Legacy source' : 'Source', { section: 'sources', source: source.id, view: 'credentials' }, source.clientId, source.enabled !== false);
        who.ownership = source.builtIn ? 'team' : auth.managedBy || 'unknown';
        add(who, 'mtls', { cert: auth.mtlsCert || auth.cert, key: auth.mtlsKey || auth.key }, auth);
        add(who, 'assertion', { cert: auth.cert, key: auth.key }, auth,
            Object.entries(auth.assertionCertificates || {}).find(([, names]) => (Array.isArray(names) ? names : [names]).includes(auth.cert))?.[0]);
        if (ho) for (const prefix of ['gatewayServer', 'hapiServer']) add(who, `${prefix} server`, { cert: ho.certificates?.[`${prefix}Cert`], key: ho.certificates?.[`${prefix}Key`] });
        else if (source.compatibilityOnly) add(who, 'server', config.certificateRoles.referenceDataSource.server);
        else add(who, 'Remote HTTPS server');
        rollover(who, auth, auth.cert);
    }
    const rootOwner = owner('authority:pcm', 'PCM root authority', 'Protected authority');
    add(rootOwner, 'CA trust', { cert: config.certificates.rootCaCert });
    // Historical aliases and unassigned files remain inspectable, without inventing ownership.
    const assigned = new Set(bindings.map(binding => binding.cert));
    for (const [alias, pair] of Object.entries(config.certificates || {})) if (pair?.cert && !assigned.has(pair.cert)) {
        add(owner(`alias:${alias}`, alias, alias === 'untrustedClient' ? 'Negative fixture' : 'Unknown owner'), 'legacy alias', pair); assigned.add(pair.cert);
    }
    for (const cert of files.filter(name => /\.(crt|pem)$/.test(name))) if (!assigned.has(cert)) {
        add(owner(`file:${cert}`, cert, cert === 'untrustedCA.crt' ? 'Negative fixture' : 'Unknown owner'),
            cert === 'untrustedCA.crt' ? 'negative-test CA trust' : 'unassigned certificate', { cert }); assigned.add(cert);
    }
    const rows = bindings.map(binding => {
        const { owner: who, role, cert, key, registration, requestedAlgorithm } = binding;
        const row = { owner: who, role, file: cert || 'Not configured', algorithm: 'Unknown', issuer: 'Unknown', validFrom: 'Unknown', validTo: 'Unknown', fingerprint: '', validity: 'Unknown', material: 'Missing certificate', registration: 'Not checked', loaded: 'Unknown — listener adoption not checked', profile: 'Separate or public-only role' };
        row.profile = bindings.some(other => other !== binding && other.owner.id === who.id && other.cert === cert && cert) ? 'Shared certificate across roles' : row.profile;
        if (role === 'Remote HTTPS server') return { ...row, file: 'Remote server — no local leaf configured', material: 'Remote server certificate not observed', registration: 'Not applicable — server trust is separate from client registration' };
        try {
            const certificate = new crypto.X509Certificate(readMaterial(directory, cert));
            row.fingerprint = crypto.createHash('sha256').update(certificate.raw).digest('base64url');
            row.issuer = certificate.issuer; row.validFrom = certificate.validFrom; row.validTo = certificate.validTo;
            row.validity = now < Date.parse(certificate.validFrom) ? 'Not yet valid' : now >= Date.parse(certificate.validTo) ? 'Expired' : 'Current';
            try { row.algorithm = signingAlgorithm(certificate.publicKey); }
            catch { row.algorithm = certificate.publicKey.asymmetricKeyType === 'rsa' ? 'RSA (transport/CA)' : 'Unsupported key algorithm'; }
            row.material = 'Certificate file parsed; key pair not checked';
            if (key) {
                try { row.material = certificate.checkPrivateKey(crypto.createPrivateKey(readMaterial(directory, key))) ? 'Certificate and key match' : 'Certificate/key mismatch'; }
                catch { row.material = 'Private key missing or invalid'; }
            }
            if (role.startsWith('assertion')) {
                if (row.algorithm === 'RSA (transport/CA)') row.algorithm = requestedAlgorithm === 'RS256' && config.conformance.compatibilityAdapters.includes('legacy-rs256-assertion') ? 'RS256 (registered compatibility exception)' : 'Unsupported RSA assertion';
                if (requestedAlgorithm && !row.algorithm.startsWith(requestedAlgorithm)) row.material = 'Registered algorithm mismatch';
            }
            const matches = clients.filter(client => client.clientId === who.clientId);
            if (!who.enabled) row.registration = 'Disabled — not an active client';
            else if (matches.length > 1) row.registration = 'Unknown — ambiguous client identity';
            else if (matches.length === 1 && role.startsWith('assertion')) {
                const approved = Object.values(matches[0].assertionKeyPaths || {}).flat();
                row.registration = approved.includes(path.resolve(directory, cert)) ? 'Matches current PCM client resolver' : 'Not registered for assertions by current PCM resolver';
            }
            else if (matches.length === 1 && role === 'mtls') {
                const observed = matches[0][role === 'mtls' ? 'mtlsThumbprint' : 'assertionThumbprint'];
                row.registration = observed ? observed === row.fingerprint ? 'Matches current PCM client resolver' : 'PCM client registration mismatch' : 'Unknown — no registered fingerprint';
            } else row.registration = who.clientId ? 'Not checked for this role' : 'Not applicable to OAuth client registration';
            if (role === 'mtls' && registration.certThumbprint && registration.certThumbprint !== row.fingerprint) row.registration += '; saved transport fingerprint mismatch';
        } catch { /* Missing or invalid material is one row, never a broken whole inventory. */ }
        return row;
    });
    return { rows, owners: [...owners.values()], checkedAt: new Date(now).toISOString(), revision: config.runtime?.revision || 0 };
}
/** Resolve one inventory-bound role and emit only the parsed public leaf, never appended key bytes.
 * @param {string} directory Protected certificate root.
 * @param {object} facts Current registered inventory.
 * @param {object} selection Exact owner, role and observed fingerprint; paths are not accepted.
 * @returns {string} PEM public certificate only.
 */
function publicCertificate(directory, facts, selection) {
    if (!selection || Object.keys(selection).some(key => !['owner','role','fingerprint'].includes(key))
        || ['owner','role','fingerprint'].some(key => typeof selection[key] !== 'string' || !selection[key])) {
        throw Object.assign(Error('Select a registered certificate owner, role and fingerprint only.'), { statusCode: 400 });
    }
    const rows = facts.rows.filter(row => row.owner.id === selection.owner && row.role === selection.role
        && row.fingerprint === selection.fingerprint && row.owner.kind !== 'Unknown owner'
        && !row.owner.id.startsWith('file:'));
    if (rows.length !== 1) throw Object.assign(Error('Public certificate material is unavailable for this registered owner and role. Refresh the inventory.'), { statusCode: 404 });
    try {
        const certificate = new crypto.X509Certificate(readMaterial(directory, rows[0].file));
        if (crypto.createHash('sha256').update(certificate.raw).digest('base64url') !== selection.fingerprint) throw Error('Certificate changed');
        return certificate.toString();
    } catch { throw Object.assign(Error('Public certificate material changed or is unavailable. Refresh the inventory.'), { statusCode: 404 }); }
}
module.exports = { publicCertificate, inventory };
