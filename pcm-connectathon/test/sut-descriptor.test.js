'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const { descriptorFromTeam } = require('../scripts/export-sut-descriptor');
const { validateDescriptor } = require('../scripts/export-sut-descriptor');

test('descriptor validation rejects mixed environment, overlong lifetime and hidden exception', () => {
    const team = require('../../test-support/team-config').buildTeamConfig();
    const descriptor = descriptorFromTeam(team, 'a'.repeat(40));
    assert.doesNotThrow(() => validateDescriptor(descriptor));
    for (const change of [{ contractEnvironment: 'production' }, { tokenMaximumSeconds: 86401 }, { conformanceExceptions: [] }]) {
        assert.throws(() => validateDescriptor({ ...descriptor, target: { ...descriptor.target, ...change } }), /invalid/);
    }
});

test('SUT descriptor exports exactly three public HOs without secrets', () => {
    const team = JSON.parse(fs.readFileSync(path.join(root, 'pcm-connectathon/example-team-config.json'), 'utf8'));
    const descriptor = descriptorFromTeam(team, 'a'.repeat(40));

    assert.strictEqual(descriptor.schemaVersion, '4.0');
    assert.strictEqual(descriptor.pcmIg.version, require('../../src/shared/pcm-contract').PCM_IG.version);
    assert.deepStrictEqual(descriptor.healthOrganizations.map(item => item.name), ['ho-a', 'ho-b', 'ho-c']);
    assert.strictEqual(descriptor.healthOrganizations[0].audience, 'https://ho-a-gateway:8080/fhir');
    assert.strictEqual(descriptor.healthOrganizations[0].clinicalData.managed, true);
    assert.strictEqual(descriptor.target.preset, 'connectathon-easy');
    assert.strictEqual(descriptor.target.awsCredentialIsolation, true);
    assert.strictEqual(descriptor.legacyDataSource.compatibilityOnly, true);
    assert.strictEqual(descriptor.runtime.repositoryCommit, 'a'.repeat(40));
    assert.strictEqual(descriptor.runtime.images['pcm-core'].configured, `ghcr.io/ronenabra/hdp-reference-architecture-v2-public-pcm-core:${process.env.VERSION || '0.1.2'}`);
    assert.strictEqual(descriptor.runtime.images['pcm-core'].immutable, null);
    assert.doesNotMatch(descriptor.runtime.images['pcm-core'].configured, /:0\.3\.2$/);
    const serialized = JSON.stringify(descriptor);
    assert.doesNotMatch(serialized, /"(?:password|privateKey|accessToken|clientAssertion)"\s*:/i);
});

test('SUT descriptor rejects an incomplete topology', () => {
    const team = JSON.parse(fs.readFileSync(path.join(root, 'pcm-connectathon/example-team-config.json'), 'utf8'));
    team.healthOrganizations.pop();
    assert.throws(() => descriptorFromTeam(team, 'a'.repeat(40)), /exactly three/);
});
