'use strict';

/** Render Admin with isolated synthetic configuration for browser component tests. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../../test-support/team-config').installTestRuntime();
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'help-admin-fixture-'));
process.env.LOG_DIR = path.join(runtime, 'logs');
process.env.STATE_DIR = path.join(runtime, 'state');
try {
    if (process.argv[3] === 'recovery') {
        const { DataOperationRegistry } = require('../../src/pcm-core/src/data-operations');
        const registry = new DataOperationRegistry();
        const uncertain = registry.create('ho-a', 'import');
        registry.transition(uncertain.id, 'failed', { mutationSubmitted: true, needsReconciliation: true });
    }
    fs.writeFileSync(process.argv[2], require('../../src/pcm-core/src/routes/ui')._test.renderAdminHtml());
} finally {
    fs.rmSync(runtime, { recursive: true, force: true });
}
process.exit(0);
