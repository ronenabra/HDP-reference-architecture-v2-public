#!/usr/bin/env node
'use strict';

/** Explicit retained-workflow preview/apply over the existing protected local Admin listener. */
const fs = require('node:fs'), path = require('node:path');
const { parseArgs, readValidatedTeamConfig } = require('./lib');
const { readEnvironmentValue } = require('./team-credentials');
const { request } = require('./sanity-request');

/** Persist a reviewable non-secret source/Contract plan; apply only that unchanged reviewed revision. */
async function main(argv = process.argv) {
    const args = parseArgs(argv), configPath = path.resolve(args.config || 'team-config.json');
    const config = readValidatedTeamConfig(configPath);
    const environment = fs.readFileSync(path.resolve(args['team-env'] || path.join(path.dirname(configPath), '.env')), 'utf8');
    const password = process.env.TEAM_ADMIN_PASSWORD || readEnvironmentValue(environment, 'TEAM_ADMIN_PASSWORD');
    const headers = { Accept: 'application/json', 'x-admin-password': password };
    const base = config.publicBaseUrls.pcmUi;
    if (args.apply === true) {
        if (!args.review) throw new Error('--apply requires --review with the saved preview file');
        const plan = JSON.parse(fs.readFileSync(path.resolve(args.review), 'utf8'));
        if (plan.teamId !== config.teamId || plan.configPath !== configPath) throw new Error('Preview belongs to another team/configuration');
        const result = await request('POST', `${base}/admin/workflow-sources/apply`, { headers, json: {
            expectedRevision: plan.revision, versions: plan.versions, sources: plan.sources
        } });
        if (result.statusCode !== 200) throw new Error(result.json?.error || 'Workflow source reconciliation failed; no success is claimed');
        console.log(JSON.stringify(result.json));
    } else {
        const result = await request('GET', `${base}/admin/workflow-sources/preview`, { headers });
        if (result.statusCode !== 200) throw new Error(result.json?.error || `Workflow preview unavailable: HTTP ${result.statusCode || 'unavailable'}${result.error ? ` (${result.error})` : ''}`);
        const plan = { teamId: config.teamId, configPath, ...result.json };
        if (args.output) fs.writeFileSync(path.resolve(args.output), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify(plan, null, 2));
    }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
