'use strict';

/** Browser binding for the local PCM identity provider; never an OAuth authorization input. */
const crypto = require('crypto');
const BINDING_COOKIE = 'pcmSystemBrowser';
const FLOW_COOKIE = 'pcmSystemFlow';

/** Read one unambiguous cookie without accepting malformed encodings or duplicate names. */
function cookie(req, name) {
    const matches = String(req?.headers?.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
    if (matches.length !== 1) return null;
    try { return decodeURIComponent(matches[0].slice(name.length + 1)); } catch (_) { return null; }
}

/** Return only an authenticated flow owned by the current browser. */
function authenticatedFlow(req, flows) {
    try { return flows.browserFlow(cookie(req, FLOW_COOKIE), cookie(req, BINDING_COOKIE), 'authenticated'); }
    catch (_) { return null; }
}

/** Bind every browser mutation to a token that another site cannot derive. */
function csrf(binding) {
    return crypto.createHash('sha256').update(`pcm-system-browser:${binding}`).digest('base64url');
}

module.exports = { BINDING_COOKIE, FLOW_COOKIE, authenticatedFlow, cookie, csrf };
