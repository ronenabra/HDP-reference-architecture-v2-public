#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot } = require('../../scripts/lib');
const { aws, awsJson, rel } = require('./deploy-lib');

const args = parseArgs(process.argv);
const root = repoRoot();
const region = args.region || 'il-central-1';
const projectName = args['project-name'] || 'pcm-connectathon';
const dryRun = Boolean(args['dry-run']);
const generatedDir = path.join(root, 'pcm-connectathon', 'aws', 'generated');
const metaPath = path.join(generatedDir, 'terraform-state-backend.json');
const baselineBackendPath = path.join(generatedDir, 'backend-baseline.s3.hcl');
const teamBackendPath = path.join(generatedDir, 'backend-team.s3.hcl');

function sanitizeBucketPart(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function hclString(value) {
    return JSON.stringify(String(value));
}

function writeFile(filePath, content) {
    if (dryRun) {
        console.log(`[dry-run] write ${rel(filePath)}`);
        return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function bucketExists(bucket) {
    if (dryRun) return false;
    try {
        aws(['s3api', 'head-bucket', '--bucket', bucket], { dryRun, capture: true });
        return true;
    } catch (err) {
        return false;
    }
}

function createBucket(bucket) {
    if (bucketExists(bucket)) {
        console.log(`S3 bucket ${bucket} already exists`);
    } else {
        const createArgs = ['s3api', 'create-bucket', '--bucket', bucket, '--region', region];
        if (region !== 'us-east-1') {
            createArgs.push('--create-bucket-configuration', `LocationConstraint=${region}`);
        }
        aws(createArgs, { dryRun });
        console.log(`Created S3 bucket ${bucket}`);
    }

    aws([
        's3api', 'put-public-access-block',
        '--bucket', bucket,
        '--public-access-block-configuration',
        'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
    ], { dryRun });
    aws(['s3api', 'put-bucket-versioning', '--bucket', bucket, '--versioning-configuration', 'Status=Enabled'], { dryRun });
    aws([
        's3api', 'put-bucket-encryption',
        '--bucket', bucket,
        '--server-side-encryption-configuration',
        '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
    ], { dryRun });
}

function backendHcl({ bucket, key, workspaceKeyPrefix }) {
    const lines = [
        `bucket         = ${hclString(bucket)}`,
        `key            = ${hclString(key)}`,
        `region         = ${hclString(region)}`,
        'encrypt        = true'
    ];
    if (workspaceKeyPrefix) {
        lines.push(`workspace_key_prefix = ${hclString(workspaceKeyPrefix)}`);
    }
    return `${lines.join('\n')}\n`;
}

function main() {
    const account = args.account || awsJson(['sts', 'get-caller-identity'], { dryRun }).Account || '000000000000';
    const bucket = args.bucket || `${sanitizeBucketPart(projectName)}-terraform-state-${account}-${sanitizeBucketPart(region)}`;
    const baselineKey = args['baseline-key'] || `${projectName}/baseline/terraform.tfstate`;
    const teamKey = args['team-key'] || `${projectName}/team/terraform.tfstate`;
    const teamWorkspaceKeyPrefix = args['team-workspace-key-prefix'] || `${projectName}/team-workspaces`;

    createBucket(bucket);

    writeFile(baselineBackendPath, backendHcl({ bucket, key: baselineKey }));
    writeFile(teamBackendPath, backendHcl({
        bucket,
        key: teamKey,
        workspaceKeyPrefix: teamWorkspaceKeyPrefix
    }));
    writeFile(metaPath, `${JSON.stringify({
        region,
        bucket,
        baselineKey,
        teamKey,
        teamWorkspaceKeyPrefix
    }, null, 2)}\n`);

    console.log(`Terraform backend config written under ${rel(generatedDir)}`);
    console.log(`S3 bucket: ${bucket}`);
}

try {
    main();
} catch (err) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
}
