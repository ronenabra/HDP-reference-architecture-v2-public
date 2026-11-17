#!/usr/bin/env node
'use strict';

/** Export the public, secret-free interface consumed by standalone PCM testers. */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, readValidatedTeamConfig, repoRoot } = require('./lib');
const { buildEffectivePolicy } = require('../../src/shared/conformance-policy');
const { ENVIRONMENTS, LOGGING_EXCEPTION } = require('../../src/shared/pcm-environment');
const { PCM_IG } = require('../../src/shared/pcm-contract');

const SCHEMA_VERSION = '4.0';
const REQUIRED_IMAGE_SERVICES = Object.freeze(['pcm-core', 'sp-client', 'ho-a-adapter', 'ho-b-adapter', 'ho-c-adapter', 'ho-a-hapi', 'ho-b-hapi', 'ho-c-hapi', 'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway']);
const LEGACY_IMAGE_SERVICES = Object.freeze(['legacy-ds-adapter', 'legacy-ds-fhir', 'legacy-ds-gateway']);
const COMPOSE_SERVICE_BY_IMAGE = Object.freeze({
    ...Object.fromEntries(REQUIRED_IMAGE_SERVICES.map(service => [service, service])),
    'legacy-ds-adapter': 'ds-auth-adapter',
    'legacy-ds-fhir': 'ds-fhir-server',
    'legacy-ds-gateway': 'ds-gateway'
});

function configuredImages(version = process.env.VERSION || '0.1.2') {
    const app = service => `ghcr.io/ronenabra/hdp-reference-architecture-v2-public-${service}:${version}`;
    return {
        'pcm-core': app('pcm-core'),
        'sp-client': app('sp-client'),
        'ho-a-adapter': app('ds-auth-adapter'),
        'ho-b-adapter': app('ds-auth-adapter'),
        'ho-c-adapter': app('ds-auth-adapter'),
        'ho-a-hapi': `pcm-ho-fhir:${process.env.PCM_HAPI_VERSION || PCM_IG.version}`,
        'ho-b-hapi': `pcm-ho-fhir:${process.env.PCM_HAPI_VERSION || PCM_IG.version}`,
        'ho-c-hapi': `pcm-ho-fhir:${process.env.PCM_HAPI_VERSION || PCM_IG.version}`,
        'ho-a-gateway': app('ds-gateway'),
        'ho-b-gateway': app('ds-gateway'),
        'ho-c-gateway': app('ds-gateway'),
        'legacy-ds-adapter': app('ds-auth-adapter'),
        'legacy-ds-fhir': app('ds-fhir-server'),
        'legacy-ds-gateway': app('ds-gateway')
    };
}

function repositoryCommit(root = repoRoot()) {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout.trim())) {
        throw new Error('could not resolve the sandbox repository commit');
    }
    return result.stdout.trim();
}

function descriptorFromTeam(team, commit = repositoryCommit(), options = {}) {
    if (!team || !Array.isArray(team.healthOrganizations) || team.healthOrganizations.length !== 3) {
        throw new TypeError('team config must contain exactly three Health Organizations');
    }
    const policy = buildEffectivePolicy(team, {});
    return {
        schemaVersion: SCHEMA_VERSION,
        pcmIg: {
            version: team.contract.pcmIgVersion,
            commit: team.contract.pcmIgCommit
        },
        target: {
            mode: team.conformance.mode,
            preset: team.conformance.preset,
            simulationControls: policy.simulation.controls,
            perSourceSimulation: policy.simulation.perSource,
            awsCredentialIsolation: true,
            pcmOAuthBaseUrl: team.publicBaseUrls.pcmApi,
            contractEnvironment: team.contract.environment,
            logicalIssuer: team.contract.operational.oauthBase,
            tokenMaximumSeconds: policy.token.accessTokenExpiresInSeconds,
            conformanceExceptions: policy.conformanceExceptions,
            pcmFhirBaseUrl: team.publicBaseUrls.pcmApi
        },
        healthOrganizations: team.healthOrganizations.map(organization => ({
            name: organization.id,
            baseUrl: team.publicBaseUrls.healthOrganizations[organization.id],
            audience: organization.endpoint,
            organizationId: organization.dataSourceOrganization.id,
            endpointId: organization.endpointId,
            clinicalData: {
                managed: organization.clinicalData.managed,
                serverId: organization.clinicalData.serverId,
                bootstrapPolicy: organization.clinicalData.bootstrap.policy,
                expectedSource: organization.clinicalData.bootstrap.expectedSource || null,
                limits: organization.clinicalData.limits
            },
            capabilities: ['clinical', 'online-presence', 'batch-presence', 'fake-time']
        })),
        legacyDataSource: {
            id: team.legacyDataSource.id,
            enabled: team.legacyDataSource.enabled,
            compatibilityOnly: true,
            managedHapi: false,
            baseUrl: team.legacyDataSource.publicFhirBaseUrl,
            capabilities: ['clinical-mock', 'fixture-reset']
        },
        runtime: {
            repositoryCommit: commit,
            sandboxRelease: options.sandboxRelease || process.env.VERSION || '0.1.2',
            images: Object.fromEntries(Object.entries(options.configuredImages || configuredImages(options.version)).map(([service, configured]) => [
                service,
                { configured, immutable: options.runtimeImages?.[service] || null }
            ]))
        }
    };
}

function firstImageIdentity(output) {
    const text = String(output || '');
    const qualified = text.match(/sha256:[a-f0-9]{64}/)?.[0];
    if (qualified) return qualified;
    const bare = text.match(/(?:^|\s)([a-f0-9]{64})(?=$|\s)/)?.[1];
    return bare ? `sha256:${bare}` : null;
}

function resolveRuntimeImages(project, envPath, root = repoRoot()) {
    const identities = {};
    // Inspect optional legacy services as well as the mandatory managed-HAPI
    // topology. Missing containers are ignored, while a running legacy stack
    // is represented with the same immutable-image fidelity as the three HOs.
    for (const [imageService, composeService] of Object.entries(COMPOSE_SERVICE_BY_IMAGE)) {
        const ps = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml', '--env-file', envPath, '-p', project, 'ps', '-q', composeService], { cwd: root, encoding: 'utf8' });
        for (const container of ps.stdout.trim().split(/\s+/).filter(Boolean)) {
            const inspected = spawnSync('docker', ['inspect', container, '--format', '{{.Image}}'], { cwd: root, encoding: 'utf8' });
            const identity = inspected.status === 0 ? firstImageIdentity(inspected.stdout) : null;
            if (identity) {
                identities[imageService] = identity;
                break;
            }
        }
        if (!identities[imageService]) {
            // Compose can omit a just-reloaded gateway from `ps` briefly. Its
            // service image remains resolvable from the same project config.
            const image = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml', '--env-file', envPath, '-p', project, 'images', '-q', composeService], { cwd: root, encoding: 'utf8' });
            const identity = image.status === 0 ? firstImageIdentity(image.stdout) : null;
            if (identity) identities[imageService] = identity;
        }
    }
    return identities;
}

function validateDescriptor(descriptor, options = {}) {
    const errors = [];
    if (descriptor.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
    if (descriptor.pcmIg?.version !== PCM_IG.version || descriptor.pcmIg?.commit !== PCM_IG.commit) errors.push('pcmIg must match the active locked release');
    const environment = ENVIRONMENTS[descriptor.target?.contractEnvironment];
    if (!environment || descriptor.target?.logicalIssuer !== environment.base) errors.push('target logical issuer must match its contract environment');
    if (!Number.isSafeInteger(descriptor.target?.tokenMaximumSeconds) || descriptor.target.tokenMaximumSeconds < 1
        || descriptor.target.tokenMaximumSeconds > (environment?.tokenMaximumSeconds || 0)) errors.push('target lifetime exceeds its environment maximum');
    if (JSON.stringify(descriptor.target?.conformanceExceptions) !== JSON.stringify([LOGGING_EXCEPTION])) errors.push('target must disclose the diagnostic logging exception');
    if (!/^[a-f0-9]{40}$/.test(descriptor.runtime?.repositoryCommit || '')) errors.push('runtime.repositoryCommit must be a full Git commit');
    if (new Set(descriptor.healthOrganizations?.map(ho => ho.name)).size !== 3) errors.push('Health Organization names must be unique');
    for (const service of REQUIRED_IMAGE_SERVICES) {
        const image = descriptor.runtime?.images?.[service];
        if (!image?.configured) errors.push(`runtime.images.${service}.configured is required`);
        if (options.releaseGrade && !/^sha256:[a-f0-9]{64}$/.test(image?.immutable || '')) errors.push(`runtime.images.${service}.immutable is required for release-grade evidence`);
    }
    if (descriptor.legacyDataSource?.enabled) {
        for (const service of LEGACY_IMAGE_SERVICES) {
            const image = descriptor.runtime?.images?.[service];
            if (!image?.configured) errors.push(`runtime.images.${service}.configured is required`);
            if (options.releaseGrade && !/^sha256:[a-f0-9]{64}$/.test(image?.immutable || '')) errors.push(`runtime.images.${service}.immutable is required for release-grade evidence`);
        }
    }
    const prohibited = /"(?:password|privateKey|accessToken|clientAssertion)"\s*:/i;
    if (prohibited.test(JSON.stringify(descriptor))) errors.push('descriptor contains a prohibited secret/identity field');
    if (errors.length) throw new TypeError(`SUT descriptor is invalid: ${errors.join('; ')}`);
    return descriptor;
}

function writeDescriptor(teamConfigPath, outputPath, root = repoRoot(), options = {}) {
    const descriptor = validateDescriptor(descriptorFromTeam(readValidatedTeamConfig(teamConfigPath), repositoryCommit(root), options), options);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
    return descriptor;
}

function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (!args['team-config'] || !args.output) {
        throw new TypeError('--team-config and --output are required');
    }
    const root = repoRoot();
    const runtimeImages = args.project && args['env-file'] ? resolveRuntimeImages(args.project, path.resolve(args['env-file']), root) : {};
    writeDescriptor(path.resolve(args['team-config']), path.resolve(args.output), root, {
        version: args.version,
        runtimeImages,
        releaseGrade: Boolean(args['release-grade'])
    });
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { COMPOSE_SERVICE_BY_IMAGE, LEGACY_IMAGE_SERVICES, REQUIRED_IMAGE_SERVICES, SCHEMA_VERSION, configuredImages, descriptorFromTeam, firstImageIdentity, repositoryCommit, resolveRuntimeImages, validateDescriptor, writeDescriptor };
