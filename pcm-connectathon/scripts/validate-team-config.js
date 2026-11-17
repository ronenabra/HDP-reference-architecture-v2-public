#!/usr/bin/env node
const { parseArgs, readJson } = require('./lib');
const path = require('path');
const { validateTeamConfig } = require('../../src/shared/team-config-validator');
const { buildEffectivePolicy, effectivePolicyReport } = require('../../src/shared/conformance-policy');

const args = parseArgs(process.argv);
const configPath = args.config;
if (!configPath) throw new Error('usage: validate-team-config.js --config teams/team-a/team-config.json');

const config = readJson(configPath);
const result = validateTeamConfig(config, {
    schemaPath: path.resolve(__dirname, '..', 'team-config.schema.json'),
    checkFiles: args['check-files'] === true,
    certsDir: args['certs-dir'] ? path.resolve(args['certs-dir']) : path.join(path.dirname(path.resolve(configPath)), 'certs')
});
const errors = result.errors;

if (errors.length) {
    console.error(JSON.stringify({ status: 'fail', errors }, null, 2));
    process.exit(1);
}

const effectivePolicy = buildEffectivePolicy(config, {});
console.log(JSON.stringify({ status: 'pass', teamId: config.teamId, effectivePolicy: effectivePolicyReport(effectivePolicy) }, null, 2));
