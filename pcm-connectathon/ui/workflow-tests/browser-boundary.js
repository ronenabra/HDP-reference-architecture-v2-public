'use strict';
/** Direct workflow probes follow the page's actual HTTPS origin after strict navigation redirects. */
function workflowPostUrl(pageUrl, action) {
    const page = new URL(pageUrl);
    const paths = ['', 'start', 'local-sso', 'fixture-start', 'verify', 'resend', 'cancel', 'local-code', 'discover', 'presence', 'presence-dependents', 'select']
        .map(value => `/sandbox/authentication${value ? '/' + value : ''}`);
    if (!['http:', 'https:'].includes(page.protocol) || !paths.includes(page.pathname)
        || !['discover', 'local-code', 'verify'].includes(action) || page.username || page.password) throw new Error('Unexpected workflow browser boundary');
    return `${page.origin}/sandbox/authentication/${action}`;
}
/** Pick the CSRF token from the exact rendered form, even when SSO and HTEST forms coexist. */
function workflowCsrfSelector(action) {
    if (!['start', 'verify', 'local-code'].includes(action)) throw new Error('Unexpected workflow CSRF form');
    return `form[action="/sandbox/authentication/${action}"] input[name="csrf"]`;
}
module.exports = { workflowPostUrl, workflowCsrfSelector };
