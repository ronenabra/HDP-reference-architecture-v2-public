'use strict';

/** Registered team-owned leaf inventory and offline renewal; issuers are preserved. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { generateLeaf, validatePair } = require('./role-credentials');
const { signingAlgorithm, jwkThumbprint } = require('./assertion-keys');

/** Resolve the registered role pairs, deduplicating shared aliases and preserving custom ownership. */
function certificateInventory(config, directory) {
    const pairs = new Map(), preserved = [];
    const add = (role, cert, key, assertion = false, algorithm) => {
        if (!cert || !key) throw new Error(`Incomplete certificate role ${role}`);
        const previous = pairs.get(cert);
        if (previous && previous.key !== key) throw new Error(`Conflicting key mappings for ${cert}`);
        if (previous) { previous.roles.push(role); previous.assertion ||= assertion; if (algorithm) previous.algorithms.push(algorithm); }
        else pairs.set(cert, { cert, key, roles: [role], assertion, algorithms: algorithm ? [algorithm] : [] });
    };
    for (const [participant, roles] of Object.entries(config.certificateRoles)) {
        if (participant === 'untrustedClient') { preserved.push({ role: participant, reason: 'negative-test issuer' }); continue; }
        for (const [purpose, pair] of Object.entries(roles)) add(`${participant}.${purpose}`, pair.cert, pair.key, purpose === 'assertion');
    }
    for (const [name, pair] of Object.entries(config.certificates)) {
        if (name !== 'untrustedClient' && pair && typeof pair === 'object' && pair.cert && pair.key) add(`certificates.${name}`, pair.cert, pair.key);
    }
    for (const ho of config.healthOrganizations) for (const prefix of ['gatewayServer', 'gatewayMtls', 'gatewayAssertion', 'hapiServer']) {
        add(`${ho.id}.${prefix}`, ho.certificates[`${prefix}Cert`], ho.certificates[`${prefix}Key`], prefix === 'gatewayAssertion');
    }
    for (const source of config.organizations.dataSources || []) {
        if (source.enabled === false || source.pcmClientAuth?.managedBy !== 'team') { preserved.push({ role: source.id, reason: 'participant or unknown credential ownership' }); continue; }
        const auth = source.pcmClientAuth;
        add(`${source.id}.assertion`, auth.cert, auth.key, true);
        if (auth.mtlsCert) add(`${source.id}.mtls`, auth.mtlsCert, auth.mtlsKey);
    }
    const registrations = [...Object.entries(config.organizations), ...Object.entries(config.oauthClients),
        ...config.healthOrganizations.map(ho => [ho.id, ho]),
        ...(config.organizations.dataSources || []).filter(source => source.pcmClientAuth?.managedBy === 'team').map(source => [source.id, source.pcmClientAuth])];
    for (const [owner, registration] of registrations) for (const [algorithm, names] of Object.entries(registration?.assertionCertificates || {})) {
        for (const cert of Array.isArray(names) ? names : [names]) {
            const key = cert.replace(/\.(crt|pem)$/, '.key');
            if (pairs.has(cert)) add(`${owner}.${algorithm}`, cert, pairs.get(cert).key, true, algorithm);
            else if (directory && !path.isAbsolute(cert) && !cert.split('/').includes('..') && key !== cert && fs.existsSync(path.join(directory, key))) {
                add(`${owner}.${algorithm}`, cert, key, true, algorithm);
            } else preserved.push({ role: `${owner}.${algorithm}`, reason: 'externally managed or public-only rollover registration' });
        }
    }
    for (const source of config.organizations.dataSources || []) {
        if (source.pcmClientAuth?.managedBy === 'team') continue;
        if ([source.pcmClientAuth?.cert, source.pcmClientAuth?.mtlsCert].some(cert => cert && pairs.has(cert))) {
            throw new Error(`Participant or unknown source ${source.id} shares a selected role file; resolve ownership before renewal`);
        }
    }
    return { pairs: [...pairs.values()], preserved };
}

/** Stage every affected leaf before stopping listeners or changing live files/configuration. */
function prepareRenewal(config, directory, { rotateKeys = false } = {}) {
    const inventory = certificateInventory(config, directory), material = {}, entries = [], next = structuredClone(config);
    const read = name => fs.readFileSync(path.join(directory, name));
    const caName = config.certificates.rootCaCert, ca = read(caName), caKey = read('rootCA.key');
    const issuer = new crypto.X509Certificate(ca);
    for (const pair of inventory.pairs) {
        const current = new crypto.X509Certificate(read(pair.cert));
        if (!current.checkIssued(issuer) || !current.verify(issuer.publicKey)) {
            inventory.preserved.push({ role: pair.roles.join(', '), reason: 'externally issued leaf' }); continue;
        }
        let algorithm = current.publicKey.asymmetricKeyType === 'rsa' ? 'RSA' : signingAlgorithm(current.publicKey);
        const legacyRs256 = pair.assertion && algorithm === 'RSA' && config.conformance.mode === 'connectathon'
            && config.conformance.compatibilityAdapters.includes('legacy-rs256-assertion');
        if (legacyRs256) algorithm = 'RS256';
        // Both current and new pairs are verified; an invalid graph is never partially repaired in place.
        validatePair({ cert: read(pair.cert), key: read(pair.key), ca, assertion: pair.assertion, algorithm, legacyRs256 });
        for (const registeredAlgorithm of pair.algorithms) if (registeredAlgorithm !== algorithm) throw new Error(`Registered assertion algorithm disagrees with role ${pair.roles.join(', ')}`);
        const commonName = current.subject.match(/(?:^|\n)CN=([^\n]+)/)?.[1];
        const sans = (current.subjectAltName || '').split(/,\s*/).filter(Boolean).map(value => value.replace(/^(?:DNS:|IP Address:)/, ''));
        const result = generateLeaf({ ca, caKey, commonName, sans, assertion: pair.assertion, algorithm, legacyRs256,
            ...(!rotateKeys ? { key: read(pair.key) } : {}) });
        material[pair.cert] = result.cert; material[pair.key] = result.key;
        entries.push({ ...pair, before: crypto.createHash('sha256').update(current.raw).digest('base64url'), after: result.thumbprint,
            oldKid: jwkThumbprint(current.publicKey), newKid: jwkThumbprint(result.cert) });
    }
    for (const source of next.organizations.dataSources || []) {
        const auth = source.pcmClientAuth;
        if (!auth || auth.managedBy !== 'team') continue;
        const transport = entries.find(entry => entry.cert === (auth.mtlsCert || auth.cert));
        if (!transport) continue;
        const previous = auth.certThumbprint; auth.certThumbprint = transport.after;
        if (source.serverTrust?.certThumbprint === previous) { source.serverTrust.certThumbprint = transport.after; source.certThumbprint = transport.after; }
    }
    next.runtime = { ...next.runtime, revision: (next.runtime.revision || 0) + 1,
        certificateRevision: (next.runtime.certificateRevision || 0) + 1,
        lastChangeReason: rotateKeys ? 'certificate-key-rotation' : 'certificate-renewal', updatedAt: new Date().toISOString() };
    return { config: next, material, entries, preserved: inventory.preserved, scope: 'registered-team-owned-leaves', rootChanged: false, rotateKeys };
}
module.exports = { certificateInventory, prepareRenewal };
