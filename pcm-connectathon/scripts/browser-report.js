'use strict';

/** Flatten nested Playwright suites into stable file/title/project identities. */
function reportTests(report) {
    const entries = [];
    const walk = suite => {
        for (const spec of suite.specs || []) for (const test of spec.tests || []) entries.push({
            key: `${spec.file}|${spec.title}|${test.projectName}`, spec, test
        });
        for (const child of suite.suites || []) walk(child);
    };
    for (const suite of report.suites || []) walk(suite);
    return entries;
}

module.exports = { reportTests };
