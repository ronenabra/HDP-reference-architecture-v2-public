#!/usr/bin/env node
'use strict';
/** Render the maintained Doctor fixture and run only offline Help regressions in the pinned browser. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { parseArgs, repoRoot } = require('../../scripts/lib');
const { render } = require('../../../test-support/doctor-ux-render');
const args = parseArgs(process.argv), root = repoRoot(), output = path.resolve(args.output || '');
assert.ok(args.image && args.output && !fs.existsSync(output), 'use a pinned --image and new --output');
fs.mkdirSync(output, { recursive: true, mode: 0o755 });
const fixtures = path.join(output, 'fixtures'), artifacts = path.join(output, 'artifacts');
fs.mkdirSync(fixtures, { mode: 0o755 }); fs.mkdirSync(artifacts, { mode: 0o777 }); fs.chmodSync(artifacts, 0o777);
const services = require('../../../config/demo-services.json').clinicalServices.map((service, index) => ({ id: `owned-help-${index}`, name: service.name,
    available: true, signature: 'unit-render-only', purpose: 'Offline Help fixture', readiness: 'Ready',
    permissions: { usable: true, authoring: false, defaultLabel: 'Saved default', origin: 'service', ceiling: 'patient/Patient.rs', actions: [], scope: 'patient/Patient.rs', options: [] } }));
assert.equal(services.length, 5);
const html = render(null, 'active', { services, selectedServiceId: services[0].id }).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('</head>', '<script defer src="/help-copy.js"></script><script defer src="/help.js"></script><script defer src="/doctor-tools.js"></script></head>');
fs.writeFileSync(path.join(fixtures, 'doctor.html'), html);
const imageId = execFileSync('docker', ['image', 'inspect', args.image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
const command = ['run', '--rm', '--init', '--network', 'none', '-v', `${fixtures}:/fixtures:ro`, '-v', `${artifacts}:/artifacts`,
    '-v', `${root}/src/shared/ui:/ui-assets:ro`, '-v', `${root}/pcm-connectathon/ui/doctor-help.config.js:/suite/doctor-help.config.js:ro`,
    '-v', `${root}/pcm-connectathon/ui/offline-tests:/suite/offline-tests:ro`, '-v', `${root}/pcm-connectathon/ui/tests/helpers/help-bindings.js:/suite/tests/helpers/help-bindings.js:ro`,
    imageId, '--config', '/suite/doctor-help.config.js'];
const result = spawnSync('docker', command, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
fs.writeFileSync(path.join(output, 'stdout.log'), result.stdout || ''); fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr || '');
fs.writeFileSync(path.join(output, 'command.json'), JSON.stringify({ command: ['docker', ...command], imageTag: args.image, imageId, exitCode: result.status,
    runtimeStarted: false, browserOnlyNetworkNone: true, node: process.version }, null, 2) + '\n');
console.log(JSON.stringify({ exitCode: result.status, imageId, output, liveApplicationRuntime: false })); process.exitCode = result.status ?? 1;
