const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
    parseTfvarsContent,
    targetGroupPrefix,
    teamTfvarsFiles,
    truncateLoadBalancerName
} = require('../aws/scripts/recover-terraform-state');

test('recovery script parses simple Terraform tfvars values', () => {
    const values = parseTfvarsContent(`
region = "il-central-1"
public_subnet_cidrs = ["10.70.0.0/20", "10.70.16.0/20"]
desired_count = 2
enabled = true
`);

    assert.strictEqual(values.region, 'il-central-1');
    assert.deepStrictEqual(values.public_subnet_cidrs, ['10.70.0.0/20', '10.70.16.0/20']);
    assert.strictEqual(values.desired_count, 2);
    assert.strictEqual(values.enabled, true);
});

test('recovery script matches Terraform team target group naming', () => {
    assert.strictEqual(
        targetGroupPrefix('hdp-pcm-connectathon-team-tani'),
        'hdp-pcm-connectathon-204841'
    );
});

test('recovery script truncates shared load balancer names like Terraform', () => {
    assert.strictEqual(
        truncateLoadBalancerName('very-long-connectathon-prefix-web'),
        'very-long-connectathon-prefix-we'
    );
    assert.strictEqual(
        truncateLoadBalancerName('very-long-connectathon-prefix-name-web'),
        'very-long-connectathon-prefix-na'
    );
});

test('recovery script discovers concrete team tfvars and excludes examples', () => {
    const dir = fs.mkdtempSync(path.join('/tmp', 'recover-state-test-'));
    fs.writeFileSync(path.join(dir, 'team-a.tfvars'), 'team_id = "team-a"\n');
    fs.writeFileSync(path.join(dir, 'team-b.tfvars.example'), 'team_id = "team-b"\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');

    assert.deepStrictEqual(
        teamTfvarsFiles(dir).map(filePath => path.basename(filePath)),
        ['team-a.tfvars']
    );
});
