#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot } = require('../../scripts/lib');
const {
    awsPortSet,
    deleteEcsService,
    generatedAwsConfigPath,
    parseTfvars,
    readJsonIfExists,
    rel,
    requireSafeTeamId,
    requireYes,
    run,
    teamConfigPath,
    terraform,
    terraformInit
} = require('./deploy-lib');

const args = parseArgs(process.argv);
const positionalAction = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const action = args.action || positionalAction || 'create';
const teamId = args['team-id'];
requireSafeTeamId(teamId);

const root = repoRoot();
const teamDir = path.join(root, 'pcm-connectathon', 'aws', 'terraform', 'team');
const tfvarsPath = path.join(teamDir, `${teamId}.tfvars`);
const awsConfigPath = generatedAwsConfigPath(teamId);
const configPath = teamConfigPath(teamId);
const dryRun = Boolean(args['dry-run']);

function tfvars() {
    const values = parseTfvars(tfvarsPath);
    if (!values.team_id) throw new Error(`${rel(tfvarsPath)} does not exist or is missing team_id`);
    return values;
}

function serviceName(values) {
    return `${values.service_prefix || 'hdp-pcm-connectathon'}-${teamId}`;
}

function baselineCluster(region) {
    const json = terraform(path.join(root, 'pcm-connectathon', 'aws', 'terraform', 'baseline'), ['output', '-raw', 'baseline_config_json'], {
        capture: true,
        dryRun
    });
    if (!json) return args.cluster || 'pcm-connectathon';
    const baseline = JSON.parse(json);
    return args.cluster || baseline.cluster || 'pcm-connectathon';
}

function terraformInitAndWorkspace() {
    terraformInit(teamDir, 'team', args, { dryRun });
    terraform(teamDir, ['workspace', 'select', teamId], { dryRun, allowFailure: true });
    if (!dryRun) {
        const selected = terraform(teamDir, ['workspace', 'show'], { capture: true }).trim();
        if (selected !== teamId) {
            terraform(teamDir, ['workspace', 'new', teamId], { dryRun });
        }
    }
}

function applyTeamTerraform() {
    terraformInitAndWorkspace();
    const planPath = args.plan || `/tmp/${teamId}.tfplan`;
    terraform(teamDir, ['plan', `-var-file=${teamId}.tfvars`, '-out', planPath], { dryRun });
    terraform(teamDir, ['apply', planPath], { dryRun });
}

function renderAwsConfig() {
    run('node', [
        'pcm-connectathon/aws/scripts/render-aws-config-from-terraform.js',
        '--team-id', teamId,
        '--terraform-dir', 'pcm-connectathon/aws/terraform/team',
        '--out', rel(awsConfigPath)
    ], { cwd: root, dryRun });
}

function createLocalConfig(values) {
    if (fs.existsSync(configPath) && !args.force && action === 'create') {
        console.log(`${rel(configPath)} already exists; keeping existing local team config`);
        return;
    }
    run('node', [
        'pcm-connectathon/scripts/create-team.js',
        '--teams-root', 'teams',
        '--team-id', teamId,
        '--sp-port', String(values.sp_ui_public_port),
        '--pcm-ui-port', String(values.pcm_ui_public_port),
        '--pcm-api-port', String(values.pcm_api_public_port),
        '--pcm-metadata-port', String(values.pcm_metadata_public_port),
        '--ds-port', String(values.ds_gateway_public_port)
    ], { cwd: root, dryRun });
}

function deployService() {
    run('node', [
        'pcm-connectathon/aws/scripts/deploy-team-environment.js',
        '--team-id', teamId,
        '--config', rel(configPath),
        '--aws-config', rel(awsConfigPath)
    ], { cwd: root, dryRun });
}

function createTfvars() {
    const cliArgs = [
        'pcm-connectathon/aws/scripts/create-team-tfvars.js',
        '--team-id', teamId
    ];
    const optionalArgs = [
        'region',
        'service-prefix',
        'port-index',
        'sp-ui-public-port',
        'pcm-ui-public-port',
        'pcm-api-public-port',
        'pcm-metadata-public-port',
        'ds-gateway-public-port',
        'team-admin-password'
    ];
    for (const name of optionalArgs) {
        if (args[name] !== undefined) cliArgs.push(`--${name}`, String(args[name]));
    }
    if (args.force || action === 'update') cliArgs.push('--force');
    if (args['skip-port-conflict-check']) cliArgs.push('--skip-port-conflict-check');
    run('node', cliArgs, { cwd: root, dryRun, forwardOutput: false });
}

try {
    function create() {
        createTfvars();
        const dryRunPorts = dryRun ? awsPortSet(args, Number(args['port-index'] || 0)) : null;
        const values = dryRun ? {
            sp_ui_public_port: dryRunPorts.spUiPublicPort,
            pcm_ui_public_port: dryRunPorts.pcmUiPublicPort,
            pcm_api_public_port: dryRunPorts.pcmApiPublicPort,
            pcm_metadata_public_port: dryRunPorts.pcmMetadataPublicPort,
            ds_gateway_public_port: dryRunPorts.dsGatewayPublicPort
        } : tfvars();
        applyTeamTerraform();
        renderAwsConfig();
        createLocalConfig(values);
        deployService();
    }

    function update() {
        if (args['refresh-tfvars']) createTfvars();
        const values = tfvars();
        if (!args['skip-terraform']) applyTeamTerraform();
        renderAwsConfig();
        if (args['recreate-local-config']) createLocalConfig(values);
        deployService();
    }

    function destroy() {
        requireYes(args, 'team delete');
        const values = tfvars();
        const region = args.region || values.region || 'il-central-1';
        const cluster = baselineCluster(region);
        deleteEcsService({
            region,
            cluster,
            serviceName: serviceName(values),
            dryRun
        });
        terraformInitAndWorkspace();
        terraform(teamDir, ['destroy', `-var-file=${teamId}.tfvars`, '-auto-approve'], { dryRun });
        if (args['delete-local'] && !dryRun) {
            fs.rmSync(awsConfigPath, { force: true });
            fs.rmSync(tfvarsPath, { force: true });
            fs.rmSync(path.join(root, 'teams', teamId), { recursive: true, force: true });
        }
    }

    switch (action) {
        case 'create':
            create();
            break;
        case 'update':
        case 'deploy':
            update();
            break;
        case 'delete':
        case 'destroy':
            destroy();
            break;
        default:
            throw new Error(`unknown action ${action}; use create, update, or delete`);
    }

    const awsConfig = readJsonIfExists(awsConfigPath);
    if (awsConfig?.publicBaseUrls) {
        console.log(JSON.stringify(awsConfig.publicBaseUrls, null, 2));
    }
} catch (err) {
    const message = String(err.message || err);
    console.error(message.startsWith('Error: ') ? message : `Error: ${message}`);
    process.exit(1);
}
