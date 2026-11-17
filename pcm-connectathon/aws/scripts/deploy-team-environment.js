#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { parseArgs, readJson } = require('../../scripts/lib');

const args = parseArgs(process.argv);
if (!args['team-id'] || !args.config || !args['aws-config']) {
    throw new Error('usage: deploy-team-environment.js --team-id team-a --config teams/team-a/team-config.json --aws-config pcm-connectathon/aws/example-aws-env.json [--dry-run]');
}

const teamId = args['team-id'];
const dryRun = Boolean(args['dry-run']);
const teamConfig = readJson(args.config);
const awsConfig = readJson(args['aws-config']);
const region = awsConfig.region || process.env.AWS_REGION || 'us-east-1';
const serviceName = `${awsConfig.servicePrefix || 'pcm-connectathon'}-${teamId}`;
const family = serviceName;

function aws(service, operation, params = {}) {
    const cliArgs = [service, operation, '--region', region, '--output', 'json'];
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === false) continue;
        cliArgs.push(`--${key}`);
        if (value !== true) cliArgs.push(typeof value === 'string' ? value : JSON.stringify(value));
    }

    if (dryRun) {
        console.log(`[dry-run] aws ${cliArgs.join(' ')}`);
        return {};
    }

    const result = spawnSync('aws', cliArgs, { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(result.stderr || `aws ${cliArgs.join(' ')} failed`);
    }
    return result.stdout ? JSON.parse(result.stdout) : {};
}

function maybeDescribeService() {
    const response = aws('ecs', 'describe-services', {
        cluster: awsConfig.cluster,
        services: serviceName
    });
    return response.services?.find(service => service.serviceName === serviceName && service.status !== 'INACTIVE') || null;
}

function ensureAccessPoint() {
    if (awsConfig.efsAccessPointId) return awsConfig.efsAccessPointId;
    if (!awsConfig.efsFileSystemId) return null;
    const existing = aws('efs', 'describe-access-points', {
        'file-system-id': awsConfig.efsFileSystemId
    }).AccessPoints?.find(ap => (ap.Tags || []).some(tag => tag.Key === 'Name' && tag.Value === serviceName));
    if (existing) return existing.AccessPointId;

    const created = aws('efs', 'create-access-point', {
        'file-system-id': awsConfig.efsFileSystemId,
        'posix-user': { Uid: 1000, Gid: 1000 },
        'root-directory': {
            Path: `/teams/${teamId}`,
            CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '0755' }
        },
        tags: [{ Key: 'Name', Value: serviceName }, { Key: 'TeamId', Value: teamId }]
    });
    return created.AccessPointId;
}

function container(name, image, port, env, logName, extra = {}) {
    const ports = Array.isArray(port) ? port : (port ? [port] : []);
    return {
        name,
        image,
        essential: extra.essential !== undefined ? extra.essential : true,
        portMappings: ports.map(containerPort => ({ containerPort, protocol: 'tcp' })),
        environment: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })),
        command: extra.command,
        dependsOn: extra.dependsOn,
        logConfiguration: awsConfig.logGroup ? {
            logDriver: 'awslogs',
            options: {
                'awslogs-group': awsConfig.logGroup,
                'awslogs-region': region,
                'awslogs-stream-prefix': `${teamId}/${logName || name}`
            }
        } : undefined,
        mountPoints: [{ sourceVolume: 'runtime', containerPath: '/runtime', readOnly: false }]
    };
}

function registerTaskDefinition(accessPointId) {
    const images = awsConfig.images || {};
    const publicBaseUrls = awsConfig.publicBaseUrls || {};
    const hostFromUrl = value => {
        try {
            return value ? new URL(value).hostname : '';
        } catch (err) {
            return '';
        }
    };
    const common = {
        TEAM_ID: teamId,
        PCM_CONFORMANCE_MODE: teamConfig.conformance?.mode || 'connectathon',
        TEAM_ADMIN_PASSWORD: awsConfig.teamAdminPassword || process.env.TEAM_ADMIN_PASSWORD || '',
        TEAM_CONFIG_PATH: '/runtime/team-config.json',
        CERTS_DIR: '/runtime/certs',
        PCM_API_CLIENT_AUTH_MODE: teamConfig.security?.pcmApi?.clientAuth || 'mtls',
        DS_GATEWAY_CLIENT_AUTH_MODE: teamConfig.security?.dataSourceGateway?.clientAuth || 'mtls',
        SP_DS_VERIFY_SERVER_CERTIFICATE: teamConfig.security?.serviceProviderToDataSource?.verifyServerCertificate || false,
        DS_FHIR_UPSTREAM_PROTOCOL: teamConfig.security?.dsGatewayToFhirServer?.protocol || 'http',
        DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE: teamConfig.security?.dsGatewayToFhirServer?.verifyServerCertificate || false,
        FHIR_SERVER_TLS: teamConfig.security?.dsGatewayToFhirServer?.protocol === 'https',
        LOCAL_JWT_ISSUER: awsConfig.localJwtIssuer || (publicBaseUrls.referenceDataSource || teamConfig.publicBaseUrls?.referenceDataSource || '').replace(/\/fhir\/?$/, ''),
        LOCAL_JWT_SIGNING_KEY_PATH: awsConfig.localJwtSigningKeyPath || '/runtime/certs/ds-gateway.key',
        LOCAL_JWT_KEY_ID: awsConfig.localJwtKeyId || ''
    };
    const seedEnv = {
        ...common,
        RUNTIME_DIR: '/runtime',
        PUBLIC_SP_CLIENT_URL: publicBaseUrls.spClient || teamConfig.publicBaseUrls?.spClient || '',
        PUBLIC_PCM_UI_URL: publicBaseUrls.pcmUi || teamConfig.publicBaseUrls?.pcmUi || '',
        PUBLIC_PCM_API_URL: publicBaseUrls.pcmApi || teamConfig.publicBaseUrls?.pcmApi || '',
        PUBLIC_PCM_METADATA_URL: publicBaseUrls.pcmMetadata || teamConfig.publicBaseUrls?.pcmMetadata || '',
        PUBLIC_REFERENCE_DS_URL: publicBaseUrls.referenceDataSource || teamConfig.publicBaseUrls?.referenceDataSource || '',
        PUBLIC_DS_METADATA_URL: publicBaseUrls.dataSourceMetadata || teamConfig.publicBaseUrls?.dataSourceMetadata || '',
        PUBLIC_SP_CLIENT_HOST: hostFromUrl(publicBaseUrls.spClient || teamConfig.publicBaseUrls?.spClient),
        PUBLIC_PCM_API_HOST: hostFromUrl(publicBaseUrls.pcmApi || teamConfig.publicBaseUrls?.pcmApi),
        PUBLIC_REFERENCE_DS_HOST: hostFromUrl(publicBaseUrls.referenceDataSource || teamConfig.publicBaseUrls?.referenceDataSource)
    };
    const waitForSeed = [{ containerName: 'runtime-seed', condition: 'SUCCESS' }];

    const task = aws('ecs', 'register-task-definition', {
        family,
        'network-mode': 'awsvpc',
        'requires-compatibilities': ['FARGATE'],
        cpu: String(awsConfig.cpu || 1024),
        memory: String(awsConfig.memory || 2048),
        'execution-role-arn': awsConfig.taskExecutionRoleArn,
        'task-role-arn': awsConfig.taskRoleArn,
        volumes: [{
            name: 'runtime',
            efsVolumeConfiguration: {
                fileSystemId: awsConfig.efsFileSystemId,
                transitEncryption: 'ENABLED',
                authorizationConfig: accessPointId ? { accessPointId, iam: 'ENABLED' } : undefined
            }
        }],
        'container-definitions': [
            container('runtime-seed', images.pcmCore, null, seedEnv, 'runtime-seed', { essential: false, command: ['node', '/workspace/pcm-connectathon/aws/scripts/seed-runtime.js'] }),
            container('pcm-core', images.pcmCore, [3000, 3001, 3005], { ...common, PORT: 3000, UI_PORT: 3001, METADATA_PORT: 3005, LOG_DIR: '/runtime/logs/pcm-core', SHARED_LOGS_DIR: '/runtime/logs', SANITY_SP_BASE_URL: 'http://localhost:3002', SANITY_PCM_UI_BASE_URL: 'http://localhost:3001', SANITY_REFERENCE_DS_BASE_URL: 'https://localhost:8080/fhir', SANITY_REFERENCE_DS_HEALTH_URL: 'http://localhost:8081/healthz' }, 'pcm-core', { dependsOn: waitForSeed }),
            container('sp-client', images.spClient, 3002, { ...common, PORT: 3002, PCM_AUTH_URL: 'https://localhost:3000/api/fhir-service/r4', PCM_FHIR_URL: 'https://localhost:3000/api/fhir-service/r4', DS_GATEWAY_URL: 'https://localhost:8080/fhir', LOG_DIR: '/runtime/logs/sp-client' }, 'sp-client', { dependsOn: waitForSeed }),
            container('ds-gateway', images.dsGateway, [8080, 8081], { ...common, DS_GATEWAY_PORT: 8080, DS_GATEWAY_HTTP_PORT: 8081, DS_GATEWAY_CERT: '/runtime/certs/ds-gateway.crt', DS_GATEWAY_KEY: '/runtime/certs/ds-gateway.key', ROOT_CA_CERT: '/runtime/certs/rootCA.crt', DS_AUTH_ADAPTER_HOST: '127.0.0.1', DS_AUTH_ADAPTER_PORT: 3003, DS_FHIR_SERVER_HOST: '127.0.0.1', DS_FHIR_SERVER_PORT: 3004 }, 'ds-gateway', { dependsOn: waitForSeed }),
            container('ds-auth-adapter', images.dsAuthAdapter, 3003, { ...common, PORT: 3003, PCM_AUTH_URL: 'https://localhost:3000/api/fhir-service/r4', PCM_FHIR_URL: 'https://localhost:3000/api/fhir-service/r4', LOG_DIR: '/runtime/logs/ds-auth-adapter' }, 'ds-auth-adapter', { dependsOn: waitForSeed }),
            container('ds-fhir-server', images.dsFhirServer, 3004, { ...common, PORT: 3004, DS_AUTH_ADAPTER_URL: 'http://127.0.0.1:3003', LOCAL_JWT_AUTHORIZATION_SERVER_METADATA_URL: 'http://127.0.0.1:3003/.well-known/oauth-authorization-server', FHIR_SERVER_CERT: '/runtime/certs/ds-fhir-server.crt', FHIR_SERVER_KEY: '/runtime/certs/ds-fhir-server.key', LOG_DIR: '/runtime/logs/ds-fhir-server' }, 'ds-fhir-server', { dependsOn: waitForSeed })
        ]
    });
    return task.taskDefinition?.taskDefinitionArn || `${family}:dry-run`;
}

function upsertService(taskDefinitionArn) {
    const networkConfiguration = {
        awsvpcConfiguration: {
            subnets: awsConfig.subnets,
            securityGroups: awsConfig.securityGroups,
            assignPublicIp: awsConfig.assignPublicIp === false ? 'DISABLED' : 'ENABLED'
        }
    };
    const loadBalancers = (awsConfig.loadBalancers || []).map(lb => ({
        targetGroupArn: lb.targetGroupArn,
        containerName: lb.containerName,
        containerPort: lb.containerPort
    }));

    const existing = maybeDescribeService();
    if (existing) {
        aws('ecs', 'update-service', {
            cluster: awsConfig.cluster,
            service: serviceName,
            'task-definition': taskDefinitionArn,
            'desired-count': awsConfig.desiredCount || 1,
            'load-balancers': loadBalancers.length ? loadBalancers : undefined,
            'force-new-deployment': true
        });
        return 'updated';
    }

    aws('ecs', 'create-service', {
        cluster: awsConfig.cluster,
        'service-name': serviceName,
        'task-definition': taskDefinitionArn,
        'desired-count': awsConfig.desiredCount || 1,
        'launch-type': 'FARGATE',
        'network-configuration': networkConfiguration,
        'load-balancers': loadBalancers.length ? loadBalancers : undefined,
        tags: [{ key: 'TeamId', value: teamId }, { key: 'PCM Connectathon', value: 'pcm' }]
    });
    return 'created';
}

function main() {
    for (const key of ['cluster', 'subnets', 'securityGroups', 'efsFileSystemId', 'taskExecutionRoleArn', 'images']) {
        if (!awsConfig[key]) throw new Error(`aws config missing ${key}`);
    }
    for (const imageKey of ['pcmCore', 'spClient', 'dsGateway', 'dsAuthAdapter', 'dsFhirServer']) {
        if (!awsConfig.images[imageKey]) throw new Error(`aws config images missing ${imageKey}`);
    }

    const accessPointId = ensureAccessPoint();
    const taskDefinitionArn = registerTaskDefinition(accessPointId);
    const serviceStatus = upsertService(taskDefinitionArn);

    console.log(JSON.stringify({
        status: dryRun ? 'dry-run' : 'ok',
        teamId,
        serviceName,
        serviceStatus,
        accessPointId,
        taskDefinitionArn
    }, null, 2));
}

main();
