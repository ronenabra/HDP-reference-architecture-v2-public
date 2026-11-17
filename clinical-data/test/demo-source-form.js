'use strict';
/** Extract source-change credentials from their own form, never from cancellation controls. */
function sourceChangeFields(html) {
    const form = html.match(/<form\b[^>]*\bdata-source-change(?:\s|=|>)[\s\S]*?<\/form>/i)?.[0];
    if (!form) throw new Error('Consent page has no source-change form');
    const fields = {};
    for (const name of ['expectedVersion', 'csrf']) {
        fields[name] = form.match(new RegExp(`name="${name}"\\s+value="([^"]+)"`))?.[1];
        if (!fields[name]) throw new Error(`Source-change form has no ${name}`);
    }
    return fields;
}
module.exports = { sourceChangeFields };
