/**
 * Tests for pcm-connectathon data-source and approved scope helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    DEFAULT_TOKEN_SCOPE,
    EXT_APPROVED_SCOPE,
    STRICT_SANDBOX_TOKEN_SCOPE,
    getApprovedTokenScope,
    getConfiguredDataSources,
    setApprovedTokenScope
} = require('../src/data-sources');

test('configured data sources always include built-in reference plus custom sources', () => {
    const sources = getConfiguredDataSources({
        organizations: {
            referenceDataSource: {
                id: 'org-reference',
                parentId: 'org-reference-parent',
                parentName: 'Reference Org',
                name: 'Reference Source',
                endpointId: 'endpoint-reference',
                endpoint: 'https://reference.example/fhir'
            },
            dataSources: [
                {
                    id: 'org-custom',
                    parentId: 'org-custom-parent',
                    parentName: 'Custom Org',
                    name: 'Custom Source',
                    endpointId: 'endpoint-custom',
                    endpoint: 'https://custom.example/fhir',
                    clientId: 'https://custom.example/oauth/client',
                    pcmClientAuth: {
                        cert: 'custom/org-custom.crt',
                        key: 'custom/org-custom.key',
                        certThumbprint: 'custom-client-thumb'
                    },
                    serverTrust: {
                        mode: 'custom-ca',
                        caCert: 'custom/custom-ca.crt',
                        certThumbprint: 'custom-server-thumb'
                    }
                }
            ]
        }
    });

    assert.deepEqual(sources.map(source => source.id), ['org-reference', 'org-custom']);
    assert.equal(sources[0].builtIn, true);
    assert.equal(sources[1].builtIn, false);
    assert.equal(sources[1].clientId, 'https://custom.example/oauth/client');
    assert.equal(sources[1].pcmClientAuth.cert, 'custom/org-custom.crt');
    assert.equal(sources[1].serverTrust.mode, 'custom-ca');
});

test('three-HO configuration produces three managed HAPIs plus the legacy compatibility source', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json'), 'utf8'));
    const sources = getConfiguredDataSources(config);

    assert.deepEqual(sources.map(source => source.healthOrganizationId), ['ho-a', 'ho-b', 'ho-c', 'legacy-ds']);
    assert.deepEqual(sources.slice(0, 3).map(source => source.endpoint), [
        'https://ho-a-gateway:8080/fhir',
        'https://ho-b-gateway:8080/fhir',
        'https://ho-c-gateway:8080/fhir'
    ]);
    assert.equal(new Set(sources.map(source => source.id)).size, 4);
    assert.equal(sources[3].compatibilityOnly, true);
    assert.equal(sources[3].managedHapi, false);
    assert.equal(new Set(sources.slice(0, 3).map(source => source.clientId)).size, 3);
    assert.equal(new Set(sources.slice(0, 3).map(source => source.pcmClientAuth.cert)).size, 3);
    assert.equal(new Set(sources.slice(0, 3).map(source => source.pcmClientAuth.mtlsCert)).size, 3);
});

test('three-HO configuration retains enabled custom sources after built-ins', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json'), 'utf8'));
    config.organizations.dataSources = [{
        id: 'org-custom',
        name: 'Custom Source',
        endpoint: 'https://custom.example/fhir',
        enabled: true
    }];

    const sources = getConfiguredDataSources(config);

    assert.deepEqual(sources.slice(0, 3).map(source => source.healthOrganizationId), ['ho-a', 'ho-b', 'ho-c']);
    assert.equal(sources[3].healthOrganizationId, 'legacy-ds');
    assert.equal(sources[4].id, 'org-custom');
    assert.equal(sources[4].builtIn, false);
});

test('public scope mutation rejects private drafts and non-string payloads without mutation', () => {
    const consent = { resourceType: 'Consent', id: 'consent-1', extension: [] };
    const selected = 'patient/Observation.rs?date=ge2024-01-01';

    assert.throws(() => setApprovedTokenScope(consent, selected), /private approval command/);
    assert.equal(getApprovedTokenScope(consent), '', 'legacy input is not an approval snapshot');

    assert.throws(() => setApprovedTokenScope(consent, STRICT_SANDBOX_TOKEN_SCOPE), /private approval command/);
    assert.equal(getApprovedTokenScope(consent), '');
    assert.ok(STRICT_SANDBOX_TOKEN_SCOPE.split(' ').includes('system/Observation.s?status=final'));

    const before = structuredClone(consent);
    assert.throws(() => setApprovedTokenScope(consent, ['patient/Observation.rs']));
    assert.deepEqual(consent, before);
});

test('public custom and empty scope injections cannot create stored authority', () => {
    for (const scope of ['patient/*.cruds', '  suspect scope  ', '', 'patient/Observation.rs?_filter=x']) {
        const consent = { extension: [] };
        assert.throws(() => setApprovedTokenScope(consent, scope), /private approval command/);
        assert.equal(getApprovedTokenScope(consent), '', 'no inferred authority without a snapshot');
        assert.equal(consent.extension.find(item => item.url === EXT_APPROVED_SCOPE), undefined);
        assert.match(require('../src/approval-scopes').approvedScopeOrigin(consent), /Missing legacy approval snapshot/);
    }
});
