'use strict';

/** Explicit, leaf-only migration of the two configured Doctor profiles. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { generateLeaf, validatePair } = require('./role-credentials');
const { certificateConfirmation, jwkThumbprint, signingAlgorithm } = require('./assertion-keys');

/** Stage the bounded profile transition while preserving identities, redirects and clinical configuration. */
function prepareDoctorProfiles(config, directory) {
    const next = structuredClone(config), material = {}, entries = [];
    const read = name => fs.readFileSync(path.join(directory, name));
    const ca = read(config.certificates.rootCaCert);
    const primary = next.certificateRoles.serviceProvider.assertion;
    validatePair({ cert: read(primary.cert), key: read(primary.key), ca, assertion: true, algorithm: 'ES256', clientAuth: true });
    next.certificateRoles.serviceProvider.mtls = { ...primary };
    next.certificates.serviceProvider = { ...primary };
    const roles = next.certificateRoles.hospitalBServiceProvider;
    if (roles.mtls.cert === roles.assertion.cert || roles.mtls.key === roles.assertion.key) throw new Error('Hospital B migration requires distinct transport and signing files; review the existing role mapping first');
    validatePair({ cert: read(roles.mtls.cert), key: read(roles.mtls.key), ca, clientAuth: true });
    const current = validatePair({ cert: read(roles.assertion.cert), key: read(roles.assertion.key), ca, assertion: true });
    if (signingAlgorithm(current.cert) !== 'ES384') {
        const certificate = new crypto.X509Certificate(current.cert);
        const commonName = certificate.subject.match(/(?:^|\n)CN=([^\n]+)/)?.[1];
        const generated = generateLeaf({ ca, caKey: read('rootCA.key'), commonName, assertion: true, algorithm: 'ES384' });
        material[roles.assertion.cert] = generated.cert; material[roles.assertion.key] = generated.key;
        entries.push({ cert: roles.assertion.cert, roles: ['hospitalBServiceProvider.assertion'],
            before: certificateConfirmation(current.cert)['x5t#S256'], after: generated.thumbprint,
            oldKid: jwkThumbprint(current.cert), newKid: jwkThumbprint(generated.cert) });
    }
    const registration = next.organizations.hospitalBServiceProvider;
    if (registration.assertionCertificates) {
        for (const algorithm of Object.keys(registration.assertionCertificates)) {
            const retained = [].concat(registration.assertionCertificates[algorithm]).filter(file => file !== roles.assertion.cert);
            if (retained.length) registration.assertionCertificates[algorithm] = retained; else delete registration.assertionCertificates[algorithm];
        }
        registration.assertionCertificates.ES384 = [...new Set([roles.assertion.cert, ...[].concat(registration.assertionCertificates.ES384 || [])])];
    }
    const changed = Object.keys(material).length > 0 || JSON.stringify(next) !== JSON.stringify(config);
    if (changed) next.runtime = { ...next.runtime, revision: (next.runtime.revision || 0) + 1,
        certificateRevision: (next.runtime.certificateRevision || 0) + 1, lastChangeReason: 'doctor-certificate-profiles', updatedAt: new Date().toISOString() };
    return { config: next, material, entries, preserved: ['root CAs', 'clinical volumes', 'client and organization identities', 'OAuth redirects', 'source configuration'],
        scope: 'doctor-certificate-profiles', rootChanged: false, rotateKeys: entries.length > 0, changed };
}
module.exports = { prepareDoctorProfiles };
