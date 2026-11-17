'use strict';
/** Repository-owned browser framing; protocol responses and renderer documents stay unchanged. */
const template = require('node:path').join(__dirname, 'views/browser-page.ejs');
const { browserNavigation, applicationPath } = require('./browser-navigation');

/** Build navigation from configured application bases, never a request URL or query.
 * @param {object} config Current validated team configuration.
 * @param {object} req Express browser request.
 * @param {string} ownKey spClient or pcmUi.
 * @returns {object} Safe shared-template context.
 */
function pageContext(config, req, ownKey) {
    const urls = browserNavigation(config.publicBaseUrls, req, ownKey);
    const basePath = applicationPath(config.publicBaseUrls[ownKey]).replace(/\/$/, '');
    return { teamId: config.teamId, basePath, urls, ownKey, reference: null,
        returnTo: ownKey === 'spClient' ? `${basePath}/` : `${basePath}/ui` };
}

/** Frame an explicit browser error while preserving its status and excluding technical details.
 * @param {object} req Express request.
 * @param {object} res Express response.
 * @param {object} context Configured page context and optional controlled message.
 * @returns {void} Rendered HTML error.
 */
function sendBrowserError(req, res, context) {
    res.status(context.status).render(template, { title: 'Request could not be completed', message: 'Return to the application and try again.', ...context });
}

/** Whether a native UI request explicitly asks for HTML rather than a protocol response. */
function browserRequest(req) {
    return String(req.get('accept') || '').includes('text/html') && !/^\/(?:api|assets|healthz)(?:\/|$)/.test(req.path);
}

/** Bind UI rendering before body parsing; the shared logger still records each error first.
 * @param {object} app Express UI application.
 * @param {Function} context Current configured page-context callback.
 * @returns {void} Installs a request-local presentation callback, without changing APIs.
 */
function prepareBrowserErrors(app, context) {
    app.use((req, res, next) => {
        if (browserRequest(req)) res.locals.renderBrowserError = error => {
            const candidate = error.status || error.statusCode;
            const status = candidate >= 400 && candidate < 500 ? candidate : 500;
            sendBrowserError(req, res, { ...context(req), status, message: status === 400 ? 'The request could not be read. Check the form and try again.' : 'This request could not be completed. Return to the application and try again.' });
        };
        next();
    });
}

/** Frame missing browser pages after existing routes; non-HTML clients keep Express's handler.
 * @param {object} app Express UI application.
 * @param {Function} context Current configured page-context callback.
 * @returns {void} Installs only the final browser 404 handler.
 */
function installBrowserErrors(app, context) {
    app.use((req, res, next) => {
        if (!browserRequest(req)) return next();
        sendBrowserError(req, res, { ...context(req), status: 404, title: 'Page unavailable', message: 'This page could not be found. Use the application navigation to continue.' });
    });
}
module.exports = { template, pageContext, sendBrowserError, prepareBrowserErrors, installBrowserErrors };
