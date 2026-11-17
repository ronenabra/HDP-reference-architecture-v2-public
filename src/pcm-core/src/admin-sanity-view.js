'use strict';
/** Present recorded smoke checks without turning unmet prerequisites into success.
 * @param {object|null} output Existing completed runner report and process outcome.
 * @returns {object|null} Display-only status, rows and next step; never an execution decision.
 */
function sanityView(output) {
    if (!output) return null;
    const checks = Array.isArray(output.result?.checks) ? output.result.checks : [];
    const status = output.ok === false && output.result?.status === 'pass' ? 'fail' : ['pass', 'fail', 'incomplete'].includes(output.result?.status) ? output.result.status : output.ok === false ? 'fail' : 'unknown';
    const title = { pass: 'Passed — recorded smoke checks completed', fail: 'Failed — review the checks below', incomplete: 'Incomplete — some checks need verified prerequisites', unknown: 'Unknown — no complete check result was recorded' }[status];
    const rows = checks.map(check => {
        const unexercised = check.executed === false || ['skip','skipped','not-exercised'].includes(check.status) || check.name === 'doctor-flow-not-applicable-without-verified-fixture';
        return { name: check.name || 'Unnamed check', status: unexercised ? 'Not exercised' : ({pass:'Passed', fail:'Failed', incomplete:'Incomplete'})[check.status] || 'Unknown',
            detail: [check.reason, check.error, check.state && `Dataset / prerequisite: ${check.state}`, check.httpStatus !== undefined && `HTTP ${check.httpStatus}`].filter(Boolean).join(' · ') || 'See technical details for the recorded evidence.' };
    });
    const incomplete = rows.some(row => row.status === 'Incomplete');
    return { status, title, rows, next: incomplete ? 'Verify the intended test dataset on each named source, then run the checks again. Gateway responses alone do not verify patient fixtures.' : status === 'fail' ? 'Review the failed checks and related diagnostics before retrying. A successful gateway response does not prove the clinical flow ran.' : status === 'unknown' ? 'Review the runner error and diagnostics before retrying.' : 'This smoke result is not conformance certification.' };
}
module.exports = { sanityView };
