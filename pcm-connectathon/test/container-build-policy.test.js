'use strict';

/** Regression checks for deterministic Node 24 services and private utilities. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const nodeBase = 'node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53';
const nginxBase = 'nginx:1.28.3@sha256:146adea4768b83c607d0bdfa4188464e3da6e0a3ad4475db1d1d8f64f27c29cc';

function read(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const services = [
    'pcm-core',
    'sp-client',
    'ds-auth-adapter',
    'ds-fhir-server'
];

test('Node service and rollback images use immutable Node 24 plus service-local npm locks', () => {
    const rootLock = JSON.parse(read('package-lock.json'));
    for (const service of services) {
        const manifest = JSON.parse(read(`src/${service}/package.json`));
        const lock = JSON.parse(read(`src/${service}/package-lock.json`));
        assert.strictEqual(lock.lockfileVersion, 3, `${service} lockfile version`);
        assert.strictEqual(lock.name, manifest.name, `${service} lock name`);
        assert.strictEqual(lock.version, manifest.version, `${service} lock version`);
        assert.deepStrictEqual(lock.packages[''].dependencies, manifest.dependencies, `${service} declared ranges`);

        for (const [packagePath, lockedPackage] of Object.entries(lock.packages)) {
            if (!packagePath.startsWith('node_modules/')) continue;
            const rootPackage = rootLock.packages[packagePath];
            assert.ok(rootPackage, `${service} ${packagePath} must come from the reviewed root lock`);
            assert.strictEqual(lockedPackage.version, rootPackage.version, `${service} ${packagePath} version`);
            assert.strictEqual(lockedPackage.integrity, rootPackage.integrity, `${service} ${packagePath} integrity`);
        }

        for (const dockerfile of [
            `src/${service}/Dockerfile`,
            `pcm-connectathon/aws/dockerfiles/${service}.Dockerfile`
        ]) {
            const source = read(dockerfile);
            assert.match(source, new RegExp(`^FROM ${nodeBase}$`, 'm'), dockerfile);
            assert.match(source, /RUN npm ci --omit=dev/, dockerfile);
            assert.doesNotMatch(source, /\bnpm\s+install\b/, dockerfile);
            assert.match(source, new RegExp(`COPY .*${service}/package\\.json .*${service}/package-lock\\.json|COPY package\\.json package-lock\\.json`), dockerfile);
        }
    }

    const loader = read('clinical-data/Dockerfile');
    assert.match(loader, new RegExp(`^FROM ${nodeBase}$`, 'm'));
    assert.doesNotMatch(loader, /\bnpm\s+(?:install|ci)\b/);
});

test('gateway and HAPI Dockerfiles retain immutable bases and carry the generated SBOM', () => {
    for (const dockerfile of [
        'src/ds-gateway/Dockerfile',
        'pcm-connectathon/aws/dockerfiles/ds-gateway.Dockerfile'
    ]) {
        const source = read(dockerfile);
        assert.match(source, new RegExp(`^FROM ${nginxBase}$`, 'm'), dockerfile);
        assert.match(source, /apt-get install -y --no-install-recommends/, dockerfile);
    }

    const hapiDockerfile = read('src/ho-fhir-server/Dockerfile');
    const baseLines = hapiDockerfile.match(/^FROM .+$/gm) || [];
    assert.strictEqual(baseLines.length, 3);
    assert.ok(baseLines.slice(0, 2).every(line => line.includes('@sha256:')), baseLines.join('\n'));
    assert.equal(baseLines[2], 'FROM scratch', 'published layers cannot inherit the upstream test private key');
    assert.match(hapiDockerfile, /SanitizePublicWar\.java upstream\.war main\.war sanitized\.war sanitization\.json/);
    assert.match(hapiDockerfile, /cp target\/bom\.json \/runtime-root\/app\/sbom\/pcm-ho-fhir\.cdx\.json/);
    const finalStage = hapiDockerfile.split('FROM scratch')[1];
    assert.match(finalStage, /COPY --from=build \/runtime-root\/ \//);
    assert.doesNotMatch(finalStage, /COPY --from=upstream/);

    const pom = read('src/ho-fhir-server/pom.xml');
    assert.match(pom, /<artifactId>cyclonedx-maven-plugin<\/artifactId>/);
    assert.match(pom, /<includeTestScope>false<\/includeTestScope>/);
    assert.match(pom, /<phase>package<\/phase>[\s\S]*<goal>makeBom<\/goal>/);

    const wrapper = read('src/ho-fhir-server/mvnw');
    assert.match(wrapper, /CONTAINER_REPOSITORY=.*WRAPPER_ROOT.*repository/);
    assert.doesNotMatch(wrapper, /CONTAINER_REPOSITORY=.*PROJECT_DIR.*target/);
});

test('Compose and generic AWS templates use the stable 0.1.2 default without rewriting generated teams', () => {
    for (const composeFile of ['docker-compose.yml', 'pcm-connectathon/compose.ho.yaml']) {
        const source = read(composeFile);
        assert.doesNotMatch(source, /\$\{VERSION:-latest\}/, composeFile);
        for (const match of source.matchAll(/\$\{VERSION:-([^}]+)\}/g)) {
            assert.strictEqual(match[1], '0.1.2', `${composeFile} application image default`);
        }
    }

    const genericAwsFiles = [
        'pcm-connectathon/aws/example-aws-env.json',
        'pcm-connectathon/aws/ecs-task-definition.example.json',
        'pcm-connectathon/aws/scripts/recover-terraform-state.js',
        'pcm-connectathon/aws/terraform/baseline/variables.tf',
        'pcm-connectathon/aws/terraform/baseline/terraform.tfvars.example'
    ];
    for (const file of genericAwsFiles) {
        const source = read(file);
        assert.doesNotMatch(source, /(?:[:'\"]|image_tag\s*=\s*['\"])latest\b/, file);
        assert.match(source, /0\.1\.2/, file);
    }
});

/** Active tools must share the service baseline; old evidence is never rewritten. */
test('Node 24 pin includes private import, reset, mount repair and host CI tools', () => {
    const compose = read('pcm-connectathon/compose.ho.yaml');
    for (const service of ['clinical-loader', 'ho-reset-helper']) {
        const block = compose.split(`  ${service}:`)[1]?.split(/\n  [a-z][a-z-]+:/)[0];
        assert.ok(block, `${service} definition exists`);
        assert.ok(block.includes(`image: ${nodeBase}`), `${service} uses the reviewed Node baseline`);
        assert.doesNotMatch(block, /node:(?:18|20|22|latest)(?:-|@|\s)/);
    }
    const { REPAIR_IMAGE } = require('../scripts/runtime-mount-preflight');
    assert.strictEqual(REPAIR_IMAGE, nodeBase);
    assert.strictEqual(read('.nvmrc').trim(), '24.22.1');
    const ciPins = [...read('.github/workflows/connectathon-verification.yml').matchAll(/node-version: '([^']+)'/g)];
    assert.strictEqual(ciPins.length, 2);
    assert.ok(ciPins.every(pin => pin[1] === '24.22.1'), 'fast and full host runners use the selected patch');
    assert.match(nodeBase, /^node:24\.22\.1-alpine3\.24@sha256:[a-f0-9]{64}$/);
});
