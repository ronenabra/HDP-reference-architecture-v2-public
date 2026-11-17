#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot, requireSafeTeamId } = require('../../scripts/lib');
const { awsJson, rel, terraform } = require('./deploy-lib');

const BASELINE_DEFAULTS = {
    region: 'il-central-1',
    project_name: 'hdp-pcm-connectathon',
    vpc_cidr: '10.70.0.0/16',
    public_subnet_cidrs: ['10.70.0.0/20', '10.70.16.0/20', '10.70.32.0/20'],
    image_tag: '0.1.2'
};

const TEAM_DEFAULTS = {
    region: 'il-central-1',
    baseline_state_path: '../baseline/terraform.tfstate',
    service_prefix: 'hdp-pcm-connectathon',
    cpu: 1024,
    memory: 2048,
    desired_count: 1,
    team_admin_password: 'change-me'
};

const SERVICE_REPOSITORIES = {
    pcm_core: 'pcm-core',
    sp_client: 'sp-client',
    ds_gateway: 'ds-gateway',
    ds_auth_adapter: 'ds-auth-adapter',
    ds_fhir_server: 'ds-fhir-server'
};

function parseTfvarsContent(content) {
    const values = {};
    for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
        if (!match) continue;

        const [, key, rawValue] = match;
        const value = rawValue.trim();
        if (/^".*"$/.test(value)) {
            values[key] = JSON.parse(value);
        } else if (/^\[.*\]$/.test(value)) {
            values[key] = JSON.parse(value);
        } else if (/^(true|false)$/.test(value)) {
            values[key] = value === 'true';
        } else if (/^-?\d+$/.test(value)) {
            values[key] = Number(value);
        } else {
            values[key] = value;
        }
    }
    return values;
}

function readTfvars(filePath, defaults = {}) {
    if (!fs.existsSync(filePath)) return { ...defaults };
    return {
        ...defaults,
        ...parseTfvarsContent(fs.readFileSync(filePath, 'utf8'))
    };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function targetGroupPrefix(name) {
    return `${name.slice(0, 20)}-${crypto.createHash('md5').update(name).digest('hex').slice(0, 6)}`;
}

function truncateLoadBalancerName(name) {
    return name.slice(0, 32);
}

function filter(name, values) {
    return `Name=${name},Values=${[].concat(values).join(',')}`;
}

function tryAwsJson(args, fallback = {}) {
    try {
        return awsJson(args);
    } catch (err) {
        return fallback;
    }
}

function first(items) {
    return Array.isArray(items) && items.length > 0 ? items[0] : null;
}

function importAddressForEcr(key) {
    return `aws_ecr_repository.service["${key}"]`;
}

class ImportPlan {
    constructor({ execute, allowMissing }) {
        this.execute = execute;
        this.allowMissing = allowMissing;
        this.items = [];
        this.missing = [];
    }

    add(address, id, description) {
        if (!id) {
            this.missing.push({ address, description });
            return;
        }
        this.items.push({ address, id, description });
    }

    printImports(terraformDir, extraArgs = []) {
        for (const item of this.items) {
            const args = [`-chdir=${terraformDir}`, 'import', ...extraArgs, item.address, item.id];
            console.log(`terraform ${args.map(shellQuote).join(' ')}`);
        }
    }

    importAll(terraformDir, extraArgs = []) {
        if (!this.execute) {
            this.printImports(terraformDir, extraArgs);
            return;
        }

        const existing = new Set((terraform(terraformDir, ['state', 'list'], {
            capture: true,
            allowFailure: true
        }) || '').split(/\r?\n/).filter(Boolean));

        for (const item of this.items) {
            if (existing.has(item.address)) {
                console.log(`Already in state: ${item.address}`);
                continue;
            }
            console.log(`Importing ${item.address} (${item.description})`);
            terraform(terraformDir, ['import', ...extraArgs, item.address, item.id]);
        }
    }

    assertComplete(scope) {
        if (this.missing.length === 0 || this.allowMissing) return;
        const lines = this.missing.map(item => `- ${item.address}: ${item.description}`);
        throw new Error(`Could not discover all ${scope} resources:\n${lines.join('\n')}\nRerun with --allow-missing to import only the resources that were found.`);
    }

    isComplete() {
        return this.missing.length === 0;
    }
}

function findVpc(region, projectName, namePrefix, cidr) {
    const output = tryAwsJson([
        'ec2', 'describe-vpcs',
        '--region', region,
        '--filters',
        filter('tag:Project', projectName),
        filter('tag:Scope', 'shared'),
        filter('tag:Name', `${namePrefix}-vpc`),
        filter('cidr', cidr)
    ], { Vpcs: [] });
    return first(output.Vpcs);
}

function findInternetGateway(region, vpcId) {
    const output = tryAwsJson([
        'ec2', 'describe-internet-gateways',
        '--region', region,
        '--filters',
        filter('attachment.vpc-id', vpcId)
    ], { InternetGateways: [] });
    return first(output.InternetGateways);
}

function findSubnet(region, vpcId, name) {
    const output = tryAwsJson([
        'ec2', 'describe-subnets',
        '--region', region,
        '--filters',
        filter('vpc-id', vpcId),
        filter('tag:Name', name)
    ], { Subnets: [] });
    return first(output.Subnets);
}

function findRouteTable(region, vpcId, name) {
    const output = tryAwsJson([
        'ec2', 'describe-route-tables',
        '--region', region,
        '--filters',
        filter('vpc-id', vpcId),
        filter('tag:Name', name)
    ], { RouteTables: [] });
    return first(output.RouteTables);
}

function routeTableAssociationId(routeTable, subnetId) {
    return routeTable?.RouteTableId && subnetId ? `${subnetId}/${routeTable.RouteTableId}` : '';
}

function findSecurityGroup(region, vpcId, groupName) {
    const output = tryAwsJson([
        'ec2', 'describe-security-groups',
        '--region', region,
        '--filters',
        filter('vpc-id', vpcId),
        filter('group-name', groupName)
    ], { SecurityGroups: [] });
    return first(output.SecurityGroups);
}

function findEfsFileSystem(region, creationToken) {
    const output = tryAwsJson([
        'efs', 'describe-file-systems',
        '--region', region,
        '--creation-token', creationToken
    ], { FileSystems: [] });
    return first(output.FileSystems);
}

function findEfsMountTarget(region, fileSystemId, subnetId) {
    const output = tryAwsJson([
        'efs', 'describe-mount-targets',
        '--region', region,
        '--file-system-id', fileSystemId
    ], { MountTargets: [] });
    return output.MountTargets?.find(item => item.SubnetId === subnetId);
}

function findEfsAccessPoint(region, fileSystemId, teamId) {
    const output = tryAwsJson([
        'efs', 'describe-access-points',
        '--region', region,
        '--file-system-id', fileSystemId
    ], { AccessPoints: [] });
    return output.AccessPoints?.find(item => item.RootDirectory?.Path === `/teams/${teamId}`);
}

function findLoadBalancer(region, name) {
    const output = tryAwsJson([
        'elbv2', 'describe-load-balancers',
        '--region', region,
        '--names', name
    ], { LoadBalancers: [] });
    return first(output.LoadBalancers);
}

function findTargetGroup(region, name) {
    const output = tryAwsJson([
        'elbv2', 'describe-target-groups',
        '--region', region,
        '--names', name
    ], { TargetGroups: [] });
    return first(output.TargetGroups);
}

function findListener(region, loadBalancerArn, port) {
    if (!loadBalancerArn || !port) return null;
    const output = tryAwsJson([
        'elbv2', 'describe-listeners',
        '--region', region,
        '--load-balancer-arn', loadBalancerArn
    ], { Listeners: [] });
    return output.Listeners?.find(item => item.Port === Number(port));
}

function repositoryExists(region, name) {
    const output = tryAwsJson([
        'ecr', 'describe-repositories',
        '--region', region,
        '--repository-names', name
    ], { repositories: [] });
    return first(output.repositories);
}

function iamRoleExists(name) {
    const output = tryAwsJson(['iam', 'get-role', '--role-name', name], {});
    return Boolean(output.Role);
}

function iamRolePolicyExists(roleName, policyName) {
    const output = tryAwsJson(['iam', 'list-role-policies', '--role-name', roleName], { PolicyNames: [] });
    return output.PolicyNames?.includes(policyName);
}

function iamRolePolicyAttachmentExists(roleName, policyArn) {
    const output = tryAwsJson(['iam', 'list-attached-role-policies', '--role-name', roleName], { AttachedPolicies: [] });
    return output.AttachedPolicies?.some(item => item.PolicyArn === policyArn);
}

function cloudWatchLogGroupExists(region, name) {
    const output = tryAwsJson([
        'logs', 'describe-log-groups',
        '--region', region,
        '--log-group-name-prefix', name
    ], { logGroups: [] });
    return output.logGroups?.some(item => item.logGroupName === name);
}

function ecsClusterExists(region, name) {
    const output = tryAwsJson([
        'ecs', 'describe-clusters',
        '--region', region,
        '--clusters', name
    ], { clusters: [] });
    return output.clusters?.some(item => item.clusterName === name && item.status !== 'INACTIVE');
}

function discoverBaseline({ baselineDir, execute, allowMissing }) {
    const vars = readTfvars(path.join(baselineDir, 'terraform.tfvars'), BASELINE_DEFAULTS);
    const region = vars.region;
    const prefix = vars.project_name;
    const accountId = tryAwsJson(['sts', 'get-caller-identity'], {}).Account;
    const plan = new ImportPlan({ execute, allowMissing });

    const vpc = findVpc(region, vars.project_name, prefix, vars.vpc_cidr);
    plan.add('aws_vpc.this', vpc?.VpcId, `${prefix} VPC`);

    const igw = vpc && findInternetGateway(region, vpc.VpcId);
    plan.add('aws_internet_gateway.this', igw?.InternetGatewayId, `${prefix} internet gateway`);

    const subnets = vars.public_subnet_cidrs.map((_, index) => {
        const subnet = vpc && findSubnet(region, vpc.VpcId, `${prefix}-public-${index + 1}`);
        plan.add(`aws_subnet.public[${index}]`, subnet?.SubnetId, `${prefix} public subnet ${index + 1}`);
        return subnet;
    });

    const routeTable = vpc && findRouteTable(region, vpc.VpcId, `${prefix}-public`);
    plan.add('aws_route_table.public', routeTable?.RouteTableId, `${prefix} public route table`);
    subnets.forEach((subnet, index) => {
        plan.add(
            `aws_route_table_association.public[${index}]`,
            routeTableAssociationId(routeTable, subnet?.SubnetId),
            `${prefix} route table association ${index + 1}`
        );
    });

    const webAlbSg = vpc && findSecurityGroup(region, vpc.VpcId, `${prefix}-web-alb`);
    const taskSg = vpc && findSecurityGroup(region, vpc.VpcId, `${prefix}-task`);
    const efsSg = vpc && findSecurityGroup(region, vpc.VpcId, `${prefix}-efs`);
    plan.add('aws_security_group.web_alb', webAlbSg?.GroupId, `${prefix} web ALB security group`);
    plan.add('aws_security_group.task', taskSg?.GroupId, `${prefix} task security group`);
    plan.add('aws_security_group.efs', efsSg?.GroupId, `${prefix} EFS security group`);

    const fileSystem = findEfsFileSystem(region, `${prefix}-runtime`);
    plan.add('aws_efs_file_system.runtime', fileSystem?.FileSystemId, `${prefix} runtime EFS`);
    subnets.forEach((subnet, index) => {
        const mountTarget = fileSystem && subnet && findEfsMountTarget(region, fileSystem.FileSystemId, subnet.SubnetId);
        plan.add(`aws_efs_mount_target.runtime[${index}]`, mountTarget?.MountTargetId, `${prefix} EFS mount target ${index + 1}`);
    });

    plan.add('aws_ecs_cluster.this', ecsClusterExists(region, prefix) ? prefix : '', `${prefix} ECS cluster`);
    plan.add('aws_cloudwatch_log_group.ecs', cloudWatchLogGroupExists(region, `/ecs/${prefix}`) ? `/ecs/${prefix}` : '', `${prefix} ECS log group`);

    const webLb = findLoadBalancer(region, truncateLoadBalancerName(`${prefix}-web`));
    const mtlsLb = findLoadBalancer(region, truncateLoadBalancerName(`${prefix}-mtls`));
    plan.add('aws_lb.web', webLb?.LoadBalancerArn, `${prefix} shared web ALB`);
    plan.add('aws_lb.mtls', mtlsLb?.LoadBalancerArn, `${prefix} shared mTLS NLB`);

    for (const [key, serviceName] of Object.entries(SERVICE_REPOSITORIES)) {
        const repositoryName = `${prefix}-${serviceName}`;
        plan.add(importAddressForEcr(key), repositoryExists(region, repositoryName)?.repositoryName, `${repositoryName} ECR repository`);
    }

    const executionRoleName = `${prefix}-ecs-execution`;
    const taskRoleName = `${prefix}-ecs-task`;
    const taskEfsPolicyName = `${prefix}-efs-client`;
    const executionPolicyArn = 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy';
    plan.add('aws_iam_role.task_execution', iamRoleExists(executionRoleName) ? executionRoleName : '', `${executionRoleName} IAM role`);
    plan.add('aws_iam_role_policy_attachment.task_execution', iamRolePolicyAttachmentExists(executionRoleName, executionPolicyArn) ? `${executionRoleName}/${executionPolicyArn}` : '', `${executionRoleName} managed policy attachment`);
    plan.add('aws_iam_role.task', iamRoleExists(taskRoleName) ? taskRoleName : '', `${taskRoleName} IAM role`);
    plan.add('aws_iam_role_policy.task_efs', iamRolePolicyExists(taskRoleName, taskEfsPolicyName) ? `${taskRoleName}:${taskEfsPolicyName}` : '', `${taskRoleName} inline EFS policy`);

    return {
        accountId,
        efsFileSystemId: fileSystem?.FileSystemId,
        mtlsLoadBalancerArn: mtlsLb?.LoadBalancerArn,
        plan,
        region,
        vpcId: vpc?.VpcId,
        webLoadBalancerArn: webLb?.LoadBalancerArn
    };
}

function teamTfvarsFiles(teamDir, requestedTeamId = '') {
    if (requestedTeamId) {
        requireSafeTeamId(requestedTeamId);
        return [path.join(teamDir, `${requestedTeamId}.tfvars`)];
    }
    return fs.readdirSync(teamDir)
        .filter(fileName => fileName.endsWith('.tfvars') && !fileName.endsWith('.tfvars.example'))
        .sort()
        .map(fileName => path.join(teamDir, fileName));
}

function discoverTeam({ baseline, execute, allowMissing, teamDir, tfvarsPath }) {
    const vars = readTfvars(tfvarsPath, TEAM_DEFAULTS);
    if (!vars.team_id) throw new Error(`${rel(tfvarsPath)} is missing team_id`);
    requireSafeTeamId(vars.team_id);

    const serviceName = `${vars.service_prefix}-${vars.team_id}`;
    const tgPrefix = targetGroupPrefix(serviceName);
    const plan = new ImportPlan({ execute, allowMissing });
    const targetGroups = {
        sp_client: `${tgPrefix}-sp`,
        pcm_ui: `${tgPrefix}-ui`,
        pcm_api: `${tgPrefix}-api`,
        pcm_metadata: `${tgPrefix}-meta`,
        ds_gateway: `${tgPrefix}-ds`
    };
    const listeners = {
        sp_client: { loadBalancerArn: baseline.webLoadBalancerArn, port: vars.sp_ui_public_port },
        pcm_ui: { loadBalancerArn: baseline.webLoadBalancerArn, port: vars.pcm_ui_public_port },
        pcm_api: { loadBalancerArn: baseline.mtlsLoadBalancerArn, port: vars.pcm_api_public_port },
        pcm_metadata: { loadBalancerArn: baseline.mtlsLoadBalancerArn, port: vars.pcm_metadata_public_port },
        ds_gateway: { loadBalancerArn: baseline.mtlsLoadBalancerArn, port: vars.ds_gateway_public_port }
    };

    const accessPoint = baseline.efsFileSystemId && findEfsAccessPoint(baseline.region, baseline.efsFileSystemId, vars.team_id);
    plan.add('aws_efs_access_point.team', accessPoint?.AccessPointId, `${vars.team_id} EFS access point`);

    for (const [addressName, targetGroupName] of Object.entries(targetGroups)) {
        const targetGroup = findTargetGroup(baseline.region, targetGroupName);
        plan.add(`aws_lb_target_group.${addressName}`, targetGroup?.TargetGroupArn, `${vars.team_id} target group ${targetGroupName}`);
    }

    for (const [addressName, listenerConfig] of Object.entries(listeners)) {
        const listener = findListener(baseline.region, listenerConfig.loadBalancerArn, listenerConfig.port);
        plan.add(`aws_lb_listener.${addressName}`, listener?.ListenerArn, `${vars.team_id} listener port ${listenerConfig.port}`);
    }

    return { plan, teamId: vars.team_id, tfvarsPath, terraformDir: teamDir };
}

function ensureTerraformReady(terraformDir, execute) {
    if (execute) terraform(terraformDir, ['init']);
    else console.log(`terraform ${shellQuote(`-chdir=${terraformDir}`)} init`);
}

function ensureTeamWorkspace(terraformDir, teamId, execute) {
    if (!execute) {
        console.log(`terraform ${shellQuote(`-chdir=${terraformDir}`)} workspace select ${shellQuote(teamId)} || terraform ${shellQuote(`-chdir=${terraformDir}`)} workspace new ${shellQuote(teamId)}`);
        return;
    }
    terraform(terraformDir, ['workspace', 'select', teamId], { allowFailure: true });
    const selected = terraform(terraformDir, ['workspace', 'show'], { capture: true, allowFailure: true }).trim();
    if (selected !== teamId) terraform(terraformDir, ['workspace', 'new', teamId]);
}

function refreshOnly(terraformDir, execute, extraArgs = []) {
    const args = ['apply', '-refresh-only', '-auto-approve', ...extraArgs];
    if (!execute) {
        console.log(`terraform ${[`-chdir=${terraformDir}`, ...args].map(shellQuote).join(' ')}`);
        return;
    }
    terraform(terraformDir, args);
}

function runRecovery(args) {
    const root = repoRoot();
    const baselineDir = path.join(root, 'pcm-connectathon', 'aws', 'terraform', 'baseline');
    const teamDir = path.join(root, 'pcm-connectathon', 'aws', 'terraform', 'team');
    const execute = Boolean(args.execute);
    const allowMissing = Boolean(args['allow-missing']);
    const teamId = args['team-id'] || '';
    const scope = args.scope || 'all';
    if (!['baseline', 'teams', 'all'].includes(scope)) {
        throw new Error('--scope must be baseline, teams, or all');
    }
    const recoverBaseline = scope !== 'teams';
    const recoverTeams = scope !== 'baseline';

    const baseline = discoverBaseline({ baselineDir, execute, allowMissing });
    if (recoverBaseline) {
        console.log(`\n# Baseline imports (${rel(baselineDir)})`);
        baseline.plan.assertComplete('baseline');
        ensureTerraformReady(baselineDir, execute);
        baseline.plan.importAll(baselineDir);
        if (baseline.plan.isComplete()) {
            refreshOnly(baselineDir, execute);
        } else {
            console.log('Skipping baseline refresh-only because some baseline imports were missing.');
        }
    }

    if (!recoverTeams) return;
    if (!baseline.vpcId || !baseline.efsFileSystemId || !baseline.webLoadBalancerArn || !baseline.mtlsLoadBalancerArn) {
        throw new Error('Cannot recover teams until the baseline VPC, EFS file system, web ALB, and mTLS NLB are discoverable.');
    }

    ensureTerraformReady(teamDir, execute);
    for (const tfvarsPath of teamTfvarsFiles(teamDir, teamId)) {
        if (!fs.existsSync(tfvarsPath)) throw new Error(`${rel(tfvarsPath)} does not exist`);
        const team = discoverTeam({ baseline, execute, allowMissing, teamDir, tfvarsPath });
        console.log(`\n# Team imports: ${team.teamId} (${rel(tfvarsPath)})`);
        team.plan.assertComplete(`team ${team.teamId}`);
        ensureTeamWorkspace(teamDir, team.teamId, execute);
        team.plan.importAll(teamDir, [`-var-file=${path.basename(tfvarsPath)}`]);
        if (team.plan.isComplete()) {
            refreshOnly(teamDir, execute, [`-var-file=${path.basename(tfvarsPath)}`]);
        } else {
            console.log(`Skipping ${team.teamId} refresh-only because some team imports were missing.`);
        }
    }
}

function printUsage() {
    console.log(`Usage:
  node pcm-connectathon/aws/scripts/recover-terraform-state.js [options]

Options:
  --execute        Run terraform import and refresh-only. Without this, only print commands.
  --team-id ID     Recover one team instead of every concrete *.tfvars team.
  --scope SCOPE    baseline, teams, or all. Default: all.
  --allow-missing  Import discovered resources even if some expected resources are missing.

Examples:
  node pcm-connectathon/aws/scripts/recover-terraform-state.js
  node pcm-connectathon/aws/scripts/recover-terraform-state.js --team-id team-tani
  node pcm-connectathon/aws/scripts/recover-terraform-state.js --execute
`);
}

if (require.main === module) {
    const args = parseArgs(process.argv);
    try {
        if (args.help) {
            printUsage();
            process.exit(0);
        }
        runRecovery(args);
        const mode = args.execute ? 'Import complete' : 'Dry run complete; rerun with --execute to import state';
        console.log(`\n${mode}. Run terraform plan afterward and stop if Terraform proposes replacements.`);
    } catch (err) {
        const message = String(err.message || err);
        console.error(message.startsWith('Error: ') ? message : `Error: ${message}`);
        process.exit(1);
    }
}

module.exports = {
    parseTfvarsContent,
    targetGroupPrefix,
    teamTfvarsFiles,
    truncateLoadBalancerName
};
