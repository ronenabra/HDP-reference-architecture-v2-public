#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, repoRoot } = require('../../scripts/lib');

const args = parseArgs(process.argv);
const root = repoRoot();
const terraformDir = path.resolve(root, args['terraform-dir'] || 'pcm-connectathon/aws/terraform/team');
const outPath = path.resolve(root, args.out || `pcm-connectathon/aws/generated/${args['team-id'] || 'team-a'}-aws-env.json`);

const result = spawnSync('terraform', ['-chdir=' + terraformDir, 'output', '-raw', 'aws_config_json'], {
    encoding: 'utf8'
});

if (result.status !== 0) {
    throw new Error(result.stderr || 'terraform output failed');
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(JSON.parse(result.stdout), null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outPath)}`);
