const fs = require('fs');
const path = require('path');
const { repoRoot, requireSafeTeamId, run, LOCAL_ONLY_ENV, assertLocalOnlyCommand, numberArg, portSet, assertUniquePorts } = require('../../scripts/lib');

function rel(filePath) {
    return path.relative(repoRoot(), filePath);
}

function terraform(chdir, args, options = {}) {
    return run('terraform', [`-chdir=${chdir}`, ...args], options);
}

function terraformBackendConfigPath(stack) {
    return path.join(repoRoot(), 'pcm-connectathon', 'aws', 'generated', `backend-${stack}.s3.hcl`);
}

function terraformInit(chdir, stack, args = {}, options = {}) {
    const backendConfig = terraformBackendConfigPath(stack);
    // Refuse a forbidden operation before looking for any retained backend input.
    assertLocalOnlyCommand('terraform', ['init', `-backend-config=${backendConfig}`], options.env || process.env);
    if (!fs.existsSync(backendConfig)) {
        throw new Error(`missing Terraform backend config ${rel(backendConfig)}; run node pcm-connectathon/aws/scripts/create-state-backend.js first`);
    }
    const initArgs = ['init', `-backend-config=${backendConfig}`];
    if (args['migrate-state']) initArgs.push('-migrate-state');
    if (args.reconfigure) initArgs.push('-reconfigure');
    return terraform(chdir, initArgs, options);
}

function aws(args, options = {}) {
    return run('aws', args, options);
}

function awsJson(args, options = {}) {
    const output = aws([...args, '--output', 'json'], { ...options, capture: true });
    if (!output) return {};
    return JSON.parse(output);
}

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseTfvars(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const values = {};
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        const trimmed = rawValue.trim();
        if (/^".*"$/.test(trimmed)) {
            values[key] = JSON.parse(trimmed);
        } else if (/^(true|false)$/.test(trimmed)) {
            values[key] = trimmed === 'true';
        } else if (/^-?\d+$/.test(trimmed)) {
            values[key] = Number(trimmed);
        } else {
            values[key] = trimmed;
        }
    }
    return values;
}

function awsPortSet(args, portIndex = 0) {
    if (!Number.isInteger(portIndex) || portIndex < 0 || portIndex > 99) {
        throw new Error('--port-index must be an integer from 0 to 99');
    }
    return {
        spUiPublicPort: numberArg(args, 'sp-ui-public-port', 3100 + (portIndex * 100)),
        pcmUiPublicPort: numberArg(args, 'pcm-ui-public-port', 4100 + (portIndex * 100)),
        pcmApiPublicPort: numberArg(args, 'pcm-api-public-port', 4101 + (portIndex * 100)),
        pcmMetadataPublicPort: numberArg(args, 'pcm-metadata-public-port', 4102 + (portIndex * 100)),
        dsGatewayPublicPort: numberArg(args, 'ds-gateway-public-port', 8180 + (portIndex * 100))
    };
}

function findTfvarsPortConflicts(tfvarsPath, namedPorts) {
    const dir = path.dirname(tfvarsPath);
    if (!fs.existsSync(dir)) return [];
    const current = path.resolve(tfvarsPath);
    const conflicts = [];
    for (const fileName of fs.readdirSync(dir)) {
        if (!fileName.endsWith('.tfvars')) continue;
        const candidatePath = path.resolve(dir, fileName);
        if (candidatePath === current) continue;
        const values = parseTfvars(candidatePath);
        const teamId = values.team_id || path.basename(fileName, '.tfvars');
        const existingPorts = {
            spUiPublicPort: values.sp_ui_public_port,
            pcmUiPublicPort: values.pcm_ui_public_port,
            pcmApiPublicPort: values.pcm_api_public_port,
            pcmMetadataPublicPort: values.pcm_metadata_public_port,
            dsGatewayPublicPort: values.ds_gateway_public_port
        };
        for (const [name, port] of Object.entries(namedPorts)) {
            for (const [existingName, existingPort] of Object.entries(existingPorts)) {
                if (port === existingPort) {
                    conflicts.push(`${name}=${port} conflicts with ${teamId}.${existingName}`);
                }
            }
        }
    }
    return conflicts;
}

function requireYes(args, action) {
    if (args['dry-run']) return;
    if (!args.yes) {
        throw new Error(`${action} is destructive; rerun with --yes after reviewing the plan`);
    }
}

function deleteEcsService({ region, cluster, serviceName, dryRun }) {
    if (dryRun) {
        aws([
            'ecs', 'update-service',
            '--region', region,
            '--cluster', cluster,
            '--service', serviceName,
            '--desired-count', '0'
        ], { dryRun });
        aws([
            'ecs', 'wait', 'services-stable',
            '--region', region,
            '--cluster', cluster,
            '--services', serviceName
        ], { dryRun });
        aws([
            'ecs', 'delete-service',
            '--region', region,
            '--cluster', cluster,
            '--service', serviceName,
            '--force'
        ], { dryRun });
        aws([
            'ecs', 'wait', 'services-inactive',
            '--region', region,
            '--cluster', cluster,
            '--services', serviceName
        ], { dryRun });
        return;
    }

    let described;
    try {
        described = awsJson([
            'ecs', 'describe-services',
            '--region', region,
            '--cluster', cluster,
            '--services', serviceName
        ], { dryRun });
    } catch (err) {
        if (String(err.message || err).includes('ClusterNotFoundException')) {
            console.log(`ECS cluster ${cluster} does not exist; skipping ECS service deletion`);
            return;
        }
        throw err;
    }
    const service = described.services?.find(item => item.serviceName === serviceName && item.status !== 'INACTIVE');
    if (!service) {
        console.log(`ECS service ${serviceName} is not active in cluster ${cluster}`);
        return;
    }

    aws([
        'ecs', 'update-service',
        '--region', region,
        '--cluster', cluster,
        '--service', serviceName,
        '--desired-count', '0'
    ], { dryRun });
    aws([
        'ecs', 'wait', 'services-stable',
        '--region', region,
        '--cluster', cluster,
        '--services', serviceName
    ], { dryRun });
    aws([
        'ecs', 'delete-service',
        '--region', region,
        '--cluster', cluster,
        '--service', serviceName,
        '--force'
    ], { dryRun });
    aws([
        'ecs', 'wait', 'services-inactive',
        '--region', region,
        '--cluster', cluster,
        '--services', serviceName
    ], { dryRun });
}

function generatedAwsConfigPath(teamId) {
    return path.join(repoRoot(), 'pcm-connectathon', 'aws', 'generated', `${teamId}-aws-env.json`);
}

function teamConfigPath(teamId) {
    return path.join(repoRoot(), 'teams', teamId, 'team-config.json');
}

module.exports = {
    LOCAL_ONLY_ENV,
    assertLocalOnlyCommand,
    aws,
    awsJson,
    awsPortSet,
    assertUniquePorts,
    deleteEcsService,
    findTfvarsPortConflicts,
    generatedAwsConfigPath,
    numberArg,
    parseTfvars,
    portSet,
    readJsonIfExists,
    rel,
    requireSafeTeamId,
    requireYes,
    run,
    teamConfigPath,
    terraform,
    terraformBackendConfigPath,
    terraformInit
};
