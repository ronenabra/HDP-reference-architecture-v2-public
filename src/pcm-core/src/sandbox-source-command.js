'use strict';
/** Private Admin command, with version-bound CSRF protection and server-derived audit identity. */
const crypto = require('crypto');
const { previewSourceChange, simulateSourceChange, sourceChangeView, sandboxEnabled } = require('./fhir/sandbox-source-change');
const secret = crypto.randomBytes(32);
/** Bind a displayed command to its Consent and server version; restart requires refreshing the page. */
function csrf(id, version) { return crypto.createHmac('sha256', secret).update(JSON.stringify([id, version])).digest('base64url'); }
/** Compare opaque tokens without leaking comparison prefixes. */
function matches(left, right) {
    return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
/** Build a protected Express handler; the caller must mount this beneath existing Admin authentication. */
function handler({ store, getConfig, audit }) {
    return (req, res) => {
        const config = getConfig(), consentId = req.params.id;
        try {
            if (!sandboxEnabled(config)) return res.status(403).json({ error: 'Source simulation is unavailable in strict' });
            const body = req.body;
            if (!body || Array.isArray(body) || Object.keys(body).some(key => !['expectedVersion', 'sourceIds', 'action', 'csrf'].includes(key))
                || !['preview', 'apply', 'cancel'].includes(body.action) || !Array.isArray(body.sourceIds) || typeof body.expectedVersion !== 'string' || typeof body.csrf !== 'string') return res.status(400).json({ error: 'Invalid source command' });
            // The configured public UI origin supports trusted TLS termination without trusting forwarded headers.
            const origins = new Set([`${req.protocol}://${req.get('host')}`, new URL(config.publicBaseUrls.pcmUi).origin]);
            if ((req.get('origin') && !origins.has(req.get('origin')))
                || !matches(body.csrf, csrf(consentId, body.expectedVersion))) return res.status(403).json({ error: 'Refresh this page and use the same-origin source form' });
            const options = { store, config, consentId, expectedVersion: body.expectedVersion, sourceOrganizationIds: body.sourceIds };
            const preview = previewSourceChange(options);
            if (body.action === 'cancel') return res.json({ state: 'cancelled', before: preview.before, after: preview.before });
            if (body.action === 'preview') return res.json({ state: 'preview', before: preview.before, after: preview.after, added: preview.added, removed: preview.removed });
            const session = req.get('cookie') || req.get('x-admin-password') || `${req.ip}|${req.get('user-agent') || ''}`;
            const result = simulateSourceChange({ ...options, actor: process.env.TEAM_ADMIN_PASSWORD ? 'team-admin' : 'sandbox-operator',
                sessionId: crypto.createHmac('sha256', secret).update(session).digest('hex').slice(0, 24), audit });
            return res.json({ state: result.state, before: result.before, after: result.after, audit: result.audit });
        } catch (error) {
            const current = store.get('Consent', consentId);
            return res.status(error.status || 400).json({ error: error.message, ...(error.status === 409 && current ? {
                current: sourceChangeView({ store, config, consent: current }), csrf: csrf(consentId, current.meta?.versionId)
            } : {}) });
        }
    };
}
module.exports = { csrf, handler };
