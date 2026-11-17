#!/usr/bin/env node
'use strict';

/** Preview/apply only the existing Doctor browser-address option through protected configuration machinery. */
const fs = require('node:fs'), path = require('node:path');
const { parseArgs, readValidatedTeamConfig } = require('./lib');
const { readEnvironmentValue } = require('./team-credentials');
const { request } = require('./sanity-request');
async function main(argv = process.argv) {
    const args = parseArgs(argv), configPath = path.resolve(args.config || 'team-config.json');
    const config = readValidatedTeamConfig(configPath);
    const environment = fs.readFileSync(path.resolve(args['team-env'] || path.join(path.dirname(configPath), '.env')), 'utf8');
    const headers = { Accept: 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD || readEnvironmentValue(environment, 'TEAM_ADMIN_PASSWORD') };
    let doctorBase = args['doctor-base-url'], reviewDigest;
    if (args.apply === true) {
        if (!args.review) throw new Error('--apply requires the saved --review preview');
        const plan = JSON.parse(fs.readFileSync(path.resolve(args.review), 'utf8'));
        if (plan.teamId !== config.teamId || plan.configPath !== configPath || (doctorBase && doctorBase !== plan.doctorBase)) throw new Error('Review belongs to another team, configuration or address');
        doctorBase = plan.doctorBase; reviewDigest = plan.reviewDigest;
    }
    const response = await request('POST', `${config.publicBaseUrls.pcmUi}/admin/config/doctor-browser/${args.apply === true ? 'apply' : 'preview'}`, { headers, json: { doctorBase, ...(reviewDigest ? { reviewDigest } : {}) } });
    if (response.statusCode !== 200) throw new Error(response.json?.error || 'Doctor browser configuration failed; no success is claimed');
    const result = { configPath, ...response.json };
    if (args.output && args.apply !== true) fs.writeFileSync(path.resolve(args.output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
