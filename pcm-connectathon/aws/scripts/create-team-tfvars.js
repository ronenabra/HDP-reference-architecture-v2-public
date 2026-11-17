#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot, requireSafeTeamId } = require('../../scripts/lib');
const { awsPortSet, assertUniquePorts, findTfvarsPortConflicts, parseTfvars, readJsonIfExists, rel } = require('./deploy-lib');

const args = parseArgs(process.argv);
const teamId = args['team-id'];
try {
    requireSafeTeamId(teamId);
} catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
}

const root = repoRoot();
const outPath = path.resolve(root, args.out || `pcm-connectathon/aws/terraform/team/${teamId}.tfvars`);
const existing = parseTfvars(outPath);
const backendMeta = readJsonIfExists(path.join(root, 'pcm-connectathon', 'aws', 'generated', 'terraform-state-backend.json'));
const portIndex = Number(args['port-index'] || 0);

function hclString(value) {
    return JSON.stringify(String(value));
}

const portArgs = {
    ...args,
    'sp-ui-public-port': args['sp-ui-public-port'] || existing.sp_ui_public_port,
    'pcm-ui-public-port': args['pcm-ui-public-port'] || existing.pcm_ui_public_port,
    'pcm-api-public-port': args['pcm-api-public-port'] || existing.pcm_api_public_port,
    'pcm-metadata-public-port': args['pcm-metadata-public-port'] || existing.pcm_metadata_public_port,
    'ds-gateway-public-port': args['ds-gateway-public-port'] || existing.ds_gateway_public_port
};
const ports = awsPortSet(portArgs, portIndex);

const config = {
    region: args.region || existing.region || 'il-central-1',
    baselineStatePath: args['baseline-state-path'] || existing.baseline_state_path || '../baseline/terraform.tfstate',
    baselineStateBackend: args['baseline-state-backend'] || existing.baseline_state_backend || (backendMeta ? 's3' : 'local'),
    baselineStateBucket: args['baseline-state-bucket'] || existing.baseline_state_bucket || backendMeta?.bucket || '',
    baselineStateKey: args['baseline-state-key'] || existing.baseline_state_key || backendMeta?.baselineKey || 'pcm-connectathon/baseline/terraform.tfstate',
    baselineStateRegion: args['baseline-state-region'] || existing.baseline_state_region || backendMeta?.region || args.region || 'il-central-1',
    servicePrefix: args['service-prefix'] || existing.service_prefix || 'hdp-pcm-connectathon',
    teamId,
    teamAdminPassword: args['team-admin-password'] || existing.team_admin_password || `change-me-${teamId}`,
    ...ports
};

try {
    assertUniquePorts({
        sp_ui_public_port: config.spUiPublicPort,
        pcm_ui_public_port: config.pcmUiPublicPort,
        pcm_api_public_port: config.pcmApiPublicPort,
        pcm_metadata_public_port: config.pcmMetadataPublicPort,
        ds_gateway_public_port: config.dsGatewayPublicPort
    });

    if (!args['skip-port-conflict-check']) {
        const conflicts = findTfvarsPortConflicts(outPath, {
            sp_ui_public_port: config.spUiPublicPort,
            pcm_ui_public_port: config.pcmUiPublicPort,
            pcm_api_public_port: config.pcmApiPublicPort,
            pcm_metadata_public_port: config.pcmMetadataPublicPort,
            ds_gateway_public_port: config.dsGatewayPublicPort
        });
        if (conflicts.length) {
            throw new Error(`public port conflicts found:\n- ${conflicts.join('\n- ')}\nChoose another --port-index or explicit ports. Pass --skip-port-conflict-check only if the listed team was deleted and its tfvars is stale.`);
        }
    }

    if (config.baselineStateBackend === 's3' && !config.baselineStateBucket) {
        throw new Error('baseline_state_backend is s3 but no baseline_state_bucket is configured; run create-state-backend.js or pass --baseline-state-bucket');
    }

    const content = `region                 = ${hclString(config.region)}
baseline_state_backend = ${hclString(config.baselineStateBackend)}
baseline_state_path    = ${hclString(config.baselineStatePath)}
baseline_state_bucket  = ${hclString(config.baselineStateBucket)}
baseline_state_key     = ${hclString(config.baselineStateKey)}
baseline_state_region  = ${hclString(config.baselineStateRegion)}
service_prefix         = ${hclString(config.servicePrefix)}
team_id                = ${hclString(config.teamId)}

team_admin_password = ${hclString(config.teamAdminPassword)}

sp_ui_public_port        = ${config.spUiPublicPort}
pcm_ui_public_port       = ${config.pcmUiPublicPort}
pcm_api_public_port      = ${config.pcmApiPublicPort}
pcm_metadata_public_port = ${config.pcmMetadataPublicPort}
ds_gateway_public_port   = ${config.dsGatewayPublicPort}
`;

    if (fs.existsSync(outPath) && !args.force) {
        throw new Error(`${rel(outPath)} already exists; pass --force to overwrite`);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);

    console.log(`Wrote ${rel(outPath)}`);
    console.log(`Ports: SP ${config.spUiPublicPort}, PCM UI ${config.pcmUiPublicPort}, PCM API ${config.pcmApiPublicPort}, PCM metadata ${config.pcmMetadataPublicPort}, DS ${config.dsGatewayPublicPort}`);
} catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
}
