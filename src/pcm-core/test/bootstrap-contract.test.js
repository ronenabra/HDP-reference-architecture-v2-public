const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { buildSeedResources } = require('../src/bootstrap');
const defaultConfig = require('../../../test-support/team-config').buildTeamConfig();
const {
    CANONICAL_BASE,
    CODE_SYSTEMS,
    IDENTIFIER_SYSTEMS,
    PROFILES,
    validateSeedResource
} = require('../../shared/pcm-contract');

const importedResourceDir = path.resolve(__dirname, '..', '..', '..', 'vendor', 'pcm-ig', '0.3.2', 'fhir', 'resources');

test('every bootstrap resource satisfies pinned profile fixed values and identity rules', () => {
    const resources = buildSeedResources(defaultConfig, {
        pcm: 'A'.repeat(43),
        serviceProvider: 'B'.repeat(43),
        hospitalB: 'C'.repeat(43)
    });
    const importedProfiles = new Map(
        fs.readdirSync(importedResourceDir)
            .filter(name => name.startsWith('StructureDefinition-'))
            .map(name => {
                const profile = JSON.parse(fs.readFileSync(path.join(importedResourceDir, name), 'utf8'));
                return [profile.url, profile];
            })
    );

    assert.ok(resources.length >= 7);
    for (const resource of resources) {
        assert.deepEqual(validateSeedResource(resource), [], `${resource.resourceType}/${resource.id}`);
        for (const profileUrl of resource.meta?.profile || []) {
            assert.ok(importedProfiles.has(profileUrl), profileUrl);
            const fixedContract = JSON.stringify(importedProfiles.get(profileUrl).differential);
            if (resource.resourceType === 'Organization') {
                assert.match(fixedContract, /pcm-org-type/);
            } else if (resource.resourceType === 'Endpoint') {
                assert.match(fixedContract, /hl7-fhir-rest/);
            } else if (resource.resourceType === 'HealthcareService') {
                assert.match(fixedContract, /pcm-healthcareservice-(catalog|instance)-id/);
            }
        }
        if (resource.resourceType === 'Organization') {
            const identifier = resource.identifier.find(item => item.system === (resource.meta.profile[0] === PROFILES.organizationSystem
                ? 'http://institutions.health.gov.il/Institutions'
                : IDENTIFIER_SYSTEMS.organization));
            assert.ok(identifier);
            assert.notEqual(identifier.value, resource.id);
            assert.ok(resource.type.some(type => type.coding.some(coding => coding.system === CODE_SYSTEMS.organizationType)));
        }
    }
    const service = resources.find(resource => resource.resourceType === 'HealthcareService'
        && resource.id === defaultConfig.service.id);
    assert.equal(service.providedBy.reference, `Organization/${defaultConfig.organizations.serviceProvider.id}`);
});

test('changing bootstrap operational host changes Endpoint address only, never canonical identity', () => {
    const config = JSON.parse(JSON.stringify(defaultConfig));
    config.contract.operational.fhirBase = 'https://localhost:9443/team/r4';
    const resources = buildSeedResources(config);
    const endpoint = resources.find(resource => resource.resourceType === 'Endpoint');

    assert.equal(endpoint.address, 'https://localhost:9443/team/r4');
    assert.equal(endpoint.meta.profile[0], PROFILES.endpointSystem);
    assert.ok(endpoint.meta.profile[0].startsWith(CANONICAL_BASE));
    for (const organization of resources.filter(resource => resource.resourceType === 'Organization')) {
        assert.equal(
            organization.identifier[0].system,
            organization.meta.profile[0] === PROFILES.organizationSystem
                ? 'http://institutions.health.gov.il/Institutions'
                : IDENTIFIER_SYSTEMS.organization
        );
    }
});
