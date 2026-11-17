#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot } = require('../../scripts/lib');
const { awsJson, readJsonIfExists, rel, terraform } = require('./deploy-lib');

const args = parseArgs(process.argv);
const root = repoRoot();
const region = args.region || 'il-central-1';
const servicePrefix = args['service-prefix'] || 'hdp-pcm-connectathon';
const outPath = path.resolve(root, args.out || 'pcm-connectathon/aws/generated/aws-team-connections.md');
const generatedDir = path.join(root, 'pcm-connectathon', 'aws', 'generated');
const dryRun = Boolean(args['dry-run']);

function baseline() {
    const json = terraform(path.join(root, 'pcm-connectathon', 'aws', 'terraform', 'baseline'), ['output', '-raw', 'baseline_config_json'], {
        capture: true,
        dryRun
    });
    return json ? JSON.parse(json) : { cluster: args.cluster || 'pcm-connectathon' };
}

function activeServices(cluster) {
    if (args['from-generated-only']) return [];
    const listed = awsJson([
        'ecs', 'list-services',
        '--region', region,
        '--cluster', cluster
    ], { dryRun });
    const arns = listed.serviceArns || [];
    if (!arns.length) return [];

    const described = awsJson([
        'ecs', 'describe-services',
        '--region', region,
        '--cluster', cluster,
        '--services', ...arns
    ], { dryRun });
    return (described.services || [])
        .filter(service => service.status !== 'INACTIVE')
        .filter(service => service.serviceName.startsWith(`${servicePrefix}-`));
}

function configsByTeam() {
    const configs = new Map();
    if (!fs.existsSync(generatedDir)) return configs;
    for (const fileName of fs.readdirSync(generatedDir)) {
        if (!fileName.endsWith('-aws-env.json')) continue;
        const teamId = fileName.replace(/-aws-env\.json$/, '');
        const config = readJsonIfExists(path.join(generatedDir, fileName));
        if (config) configs.set(teamId, config);
    }
    return configs;
}

function mdLink(value) {
    return value ? `[open](${value})` : '';
}

function tableCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|');
}

const base = baseline();
const services = activeServices(base.cluster);
const configs = configsByTeam();

for (const service of services) {
    const teamId = service.serviceName.slice(`${servicePrefix}-`.length);
    if (!configs.has(teamId)) configs.set(teamId, {});
    configs.get(teamId).__service = service;
}

const rows = [...configs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([teamId, config]) => {
        const service = config.__service;
        const urls = config.publicBaseUrls || {};
        return [
            teamId,
            service?.status || (args['from-generated-only'] ? 'not checked' : 'missing service'),
            service ? `${service.runningCount}/${service.desiredCount}` : '',
            config.teamAdminPassword || '',
            mdLink(urls.spClient),
            mdLink(urls.pcmUi),
            mdLink(urls.pcmApi),
            mdLink(urls.pcmMetadata),
            mdLink(urls.referenceDataSource),
            mdLink(urls.dataSourceMetadata)
        ];
    });

const lines = [
    '# AWS PCM Connectathon Team Connections',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Region: ${region}`,
    `Cluster: ${base.cluster || ''}`,
    `Service prefix: ${servicePrefix}`,
    '',
    '> This file contains admin passwords. Keep it out of source control.',
    '',
    '| Team | ECS status | Running/desired | Admin password | SP UI | PCM UI | PCM API | PCM metadata | Reference DS FHIR | DS metadata |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.map(tableCell).join(' | ')} |`),
    ''
];

if (dryRun) {
    console.log(lines.join('\n'));
} else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join('\n'));
    console.log(`Wrote ${rel(outPath)}`);
}
