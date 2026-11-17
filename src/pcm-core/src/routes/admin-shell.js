'use strict';
/** Small server-rendered Admin address and template helpers. No mutation lives here. */
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const areas = Object.freeze([
    ['overview', 'Overview'], ['sources', 'Sources & data'], ['security', 'Security & access'],
    ['apps', 'Service providers & apps'], ['certificates', 'Certificates'],
    ['logs', 'Logs & diagnostics'], ['maintenance', 'Maintenance']
]);

/** Map old operation/result paths to their single owning area. */
function operationArea(route = '') {
    if (/^\/admin\/(?:api|workflow-sources|config\/(?:data-sources|fhir-servers|identity-mapping|ds-url|presence-limits|clinical-query-limits))/.test(route)) return 'sources';
    if (/^\/admin\/config\/(?:security|simulation|own-token|test-workflows)/.test(route)) return 'security';
    if (/^\/admin\/certs/.test(route)) return 'certificates';
    if (/^\/admin\/(?:logs|sanity-check)/.test(route)) return 'logs';
    if (/^\/admin\/(?:backup|restore|reset|migration)/.test(route)) return 'maintenance';
    if (/^\/admin\/(?:catalog|config\/doctor-browser)/.test(route)) return 'apps';
    return '';
}

/** Resolve section/source identity without substituting another target for stale links. */
function sectionState(req, sources = []) {
    const query = req?.query || {};
    const requested = typeof query.section === 'string' ? query.section : operationArea(req?.path);
    const selected = areas.some(([id]) => id === requested) ? requested : 'overview';
    const source = typeof query.source === 'string' ? query.source : '';
    return { selected, source: sources.some(item => item.id === source) ? source : '',
        error: requested && selected !== requested ? 'This Admin area is unavailable. Choose an area below.'
            : source && !sources.some(item => item.id === source) ? 'This source is no longer configured. Select a current source before editing.' : '' };
}

/** Build a local stable address; source identifiers are exact and never display names. */
function address(basePath, section = 'overview', source = '', view = '') {
    const query = new URLSearchParams({ section: areas.some(([id]) => id === section) ? section : 'overview' });
    if (source) query.set('source', source);
    if (section === 'sources' && (Object.hasOwn(require('./admin-source-model').views, view) || ['onboarding', 'defaults', 'workflows'].includes(view))) query.set('view', view);
    return `${basePath}/admin?${query}`;
}

/** Accept only this mount's Admin section addresses as return destinations. */
function safeReturn(value, basePath) {
    if (typeof value !== 'string' || /[\\\r\n]/.test(value)) return address(basePath);
    try {
        const url = new URL(value, 'http://admin.invalid');
        if (url.origin !== 'http://admin.invalid' || url.pathname !== `${basePath}/admin`) return address(basePath);
        const section = url.searchParams.get('section') || 'overview';
        const source = url.searchParams.get('source') || '';
        const destination = address(basePath, section, source, url.searchParams.get('view') || '');
        return section === 'certificates' && url.searchParams.has('owner') ? `${destination}&owner=${encodeURIComponent(url.searchParams.get('owner'))}` : destination;
    } catch { return address(basePath); }
}

/** Render a named bounded local template with the existing escaping model. */
function partial(name, context) {
    return ejs.render(fs.readFileSync(path.join(__dirname, '../views/admin', `${name}.ejs`), 'utf8'), context);
}

/** Render the common shell and exactly one owning area. */
function render(context) {
    const locals = { ...context, areas };
    locals.partial = (name, overrides = {}) => partial(name, { ...locals, ...overrides });
    return partial('shell', locals);
}
module.exports = { operationArea, areas, sectionState, address, safeReturn, partial, render };
