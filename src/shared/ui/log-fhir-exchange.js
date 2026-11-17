'use strict';
/** Pure, bounded projection of one selected HTTP log record; no I/O or persistence. */
(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PCM_LOG_FHIR = api;
})(typeof window === 'object' ? window : globalThis, function createFhirExchange() {
    const LIMITS = Object.freeze({ visits: 4000, depth: 12, candidates: 16, valueChars: 131072, inputChars: 262144, outputChars: 524288, pairs: 200 });
    // Explicit emitter directions. Unknown business events never enter discovery.
    const EVENTS = Object.freeze({ REQUEST: 'request', OUTGOING_REQUEST: 'request', SYSTEM_WORKFLOW_REQUEST: 'request', HAPI_REQUEST: 'request', GATEWAY_REQUEST: 'request',
        RESPONSE: 'response', OUTGOING_RESPONSE: 'response', SYSTEM_WORKFLOW_RESPONSE: 'response', HAPI_RESPONSE: 'response', GATEWAY_RESPONSE: 'response',
        OUTGOING_ERROR: 'error', HAPI_ERROR: 'error', ROUTE_ERROR: 'error' });
    const RESOURCES = new Set('Patient RelatedPerson Consent Contract Observation Condition AllergyIntolerance MedicationRequest MedicationStatement MedicationAdministration MedicationDispense Medication DiagnosticReport Procedure Encounter Immunization DocumentReference CarePlan CareTeam Goal ServiceRequest Specimen Organization Practitioner PractitionerRole Location HealthcareService Endpoint Bundle Parameters OperationOutcome'.split(' '));
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const own = (value, key) => object(value) && Object.hasOwn(value, key);
    const missing = 'Not recorded in this event';

    /** Inspect explicit URL path boundaries, excluding OAuth even under a FHIR base. */
    function route(value) {
        if (typeof value !== 'string') return { fhir: false, oauth: false };
        let pathname;
        try { pathname = new URL(value, 'https://record.invalid/').pathname; } catch (_) { return { fhir: false, oauth: false }; }
        const segments = pathname.split('/').filter(Boolean);
        const oauth = segments.some(segment => /^(token|introspect)$/i.test(segment));
        return { oauth, fhir: !oauth && (/(?:^|\/)fhir(?:\/|$)/i.test(pathname)
            || /(?:^|\/)api\/fhir-service\/r4(?:\/|$)/i.test(pathname) || RESOURCES.has(segments[0])) };
    }
    /** Budget serialization before calling JSON.stringify, preventing deep indentation growth. */
    function bounded(value, pretty = true) {
        const pending = [{ value, depth: 0 }]; let visits = 0, chars = 0;
        while (pending.length) {
            const item = pending.pop();
            if (++visits > LIMITS.visits || item.depth > LIMITS.depth) return null;
            if (item.value !== null && typeof item.value === 'object') {
                for (const key of Object.keys(item.value)) {
                    chars += key.length + 8;
                    if (chars > LIMITS.valueChars || pending.length >= LIMITS.visits) return null;
                    pending.push({ value: item.value[key], depth: item.depth + 1 });
                }
            } else chars += String(item.value).length + 8;
            if (chars > LIMITS.valueChars) return null;
        }
        const text = typeof value === 'string' && !pretty ? value : JSON.stringify(value, null, pretty ? 2 : undefined);
        return typeof text === 'string' && text.length <= LIMITS.valueChars ? text : null;
    }
    /** Preserve ordered repeated/empty query or form values and each encoded original. */
    function pairs(encoded) {
        const values = encoded === '' ? [] : encoded.split('&', LIMITS.pairs + 1);
        return { limited: values.length > LIMITS.pairs, values: values.slice(0, LIMITS.pairs).map(raw => {
            const decoded = [...new URLSearchParams(raw)][0] || ['', ''];
            return { raw, name: decoded[0], value: decoded[1] };
        }) };
    }
    /** Identify a recorded content type without normalizing its original spelling/value. */
    function contentType(headers) {
        return object(headers) ? Object.keys(headers).filter(key => key.toLowerCase() === 'content-type').map(key => headers[key]).join('; ') : '';
    }
    /** Parse only bounded JSON strings; malformed values remain exact recorded text. */
    function parsedBody(value) {
        if (typeof value !== 'string' || value.length > LIMITS.inputChars) return value;
        try { return JSON.parse(value); } catch (_) { return value; }
    }
    function resource(value) { return own(value, 'resourceType') && typeof value.resourceType === 'string' && /^[A-Z][A-Za-z]+$/.test(value.resourceType); }

    /** Extract explicit flat and shallow HTTP envelopes; retain conflicting bodies independently.
     * @param {object} record Complete selected normalized event.
     * @returns {object} Eligible candidate evidence, original references and limit notices.
     */
    function extract(record) {
        const details = record?.details, direction = own(EVENTS, details?.type) ? EVENTS[details.type] : null;
        const result = { request: [], response: [], notices: [] };
        if (!direction || !object(details)) return result;
        const topUrls = ['url', 'requestPath', 'path'].filter(key => own(details, key));
        if (topUrls.some(key => route(details[key]).oauth)) return result;
        const seen = new Map();
        function add(side, envelope, path, bodyKeys, headerKeys, inheritedFhir = false) {
            const fields = [];
            for (const key of ['method', 'url', 'requestPath', 'path']) if (own(envelope, key)) fields.push({ label: key === 'method' ? 'Method' : 'URL / path', path: [...path, key], value: envelope[key] });
            if (side === 'response') for (const key of ['status', 'statusCode']) if (own(envelope, key)) fields.push({ label: 'Status', path: [...path, key], value: envelope[key] });
            for (const key of ['truncated', 'redacted', 'bodyTruncated', 'bodyRedacted', side + 'BodyTruncated', side + 'BodyRedacted']) if (own(envelope, key)) fields.push({ label: 'Capture marker', path: [...path, key], value: envelope[key] });
            for (const key of headerKeys) if (own(envelope, key)) fields.push({ label: 'Headers', path: [...path, key], value: envelope[key] });
            if (fields.some(field => field.label === 'URL / path' && route(field.value).oauth)) return;
            const media = fields.filter(field => field.label === 'Headers').map(field => contentType(field.value)).join('; ');
            const bodies = bodyKeys.filter(key => own(envelope, key));
            const urls = fields.filter(field => field.label === 'URL / path');
            const routeKnown = urls.some(field => route(field.value).fhir) || (!urls.length && inheritedFhir);
            const isFhir = routeKnown || /application\/fhir\+json/i.test(media)
                || (side === 'response' && bodies.some(key => resource(parsedBody(envelope[key]))));
            if (!isFhir) return;
            for (const key of bodies.length ? bodies : [null]) {
                if (result.request.length + result.response.length >= LIMITS.candidates) {
                    if (!result.notices.length) result.notices.push('Candidate limit reached. Inspect JSON / Structured record for additional evidence.');
                    return;
                }
                const candidate = { fields, media, body: key === null ? null : { path: [...path, key], value: envelope[key] }, paths: [path], side };
                // Equal values with equal HTTP context collapse; aliases retain their attribution.
                const signature = bounded([side, fields.map(field => [field.label, field.value]), key === null ? ['missing'] : [envelope[key]]], false);
                if (signature && seen.has(signature)) {
                    const previous = seen.get(signature); previous.paths.push(path);
                    if (candidate.body) (previous.body.aliases ||= []).push(candidate.body.path);
                } else { result[side].push(candidate); if (signature) seen.set(signature, candidate); }
            }
        }
        if (direction === 'request') add('request', details, ['details'], ['data', 'body'], ['headers']);
        else {
            // Method/URL in a response are request context recorded in this very event.
            if (topUrls.length || own(details, 'requestBody') || own(details, 'requestHeaders')) add('request', details, ['details'], ['requestBody'], ['requestHeaders']);
            if (direction !== 'error' || ['data', 'body', 'responseBody', 'responseHeaders'].some(key => own(details, key)) || details.status != null || details.statusCode != null) add('response', details, ['details'], direction === 'error' ? ['data', 'body', 'responseBody'] : ['data', 'body'], direction === 'error' ? ['responseHeaders'] : ['headers']);
        }
        // Finite paths only: never walk resource contents, saved grants or arbitrary subtrees.
        for (const prefix of [[], ['error'], ['data'], ['body']]) {
            const wrapper = prefix.length ? details[prefix[0]] : details;
            if (!object(wrapper) || own(wrapper, 'resourceType')) continue;
            for (const side of ['request', 'response']) {
                const envelope = wrapper[side];
                if (!object(envelope)) continue;
                const http = ['method', 'url', 'path', 'requestPath', 'status', 'statusCode', 'headers'].some(key => own(envelope, key))
                    || (side === 'response' && ['body', 'data'].some(key => resource(parsedBody(envelope[key]))));
                if (http) add(side, envelope, ['details', ...prefix, side], ['body', 'data', side + 'Body'], ['headers'], topUrls.some(key => route(details[key]).fhir));
            }
        }
        return result;
    }

    /** Format one captured value, retaining exact copy bytes separately from presentation. */
    function bodyView(candidate) {
        if (!candidate.body) return { label: candidate.side === 'request' && candidate.fields.some(field => field.label === 'Method' && /^GET$/i.test(field.value)) ? 'No request body recorded (GET)' : missing, text: '', exact: null };
        const value = candidate.body.value;
        const exact = bounded(value, false);
        if (exact === null) return { label: 'Display limit reached; use JSON / Structured record or the existing full export', text: '', exact: null };
        if (typeof value === 'string' && /application\/x-www-form-urlencoded/i.test(candidate.media)) {
            const form = pairs(value);
            return { label: 'Recorded form body' + (form.limited ? ' · first 200 pairs; exact copy retains all pairs' : ''),
                text: form.values.map(pair => `${pair.name} = ${pair.value}\n  Encoded: ${pair.raw}`).join('\n'), exact };
        }
        const parsed = parsedBody(value), text = bounded(parsed);
        const label = value === '' ? 'Recorded empty string' : value === null ? 'Recorded null' : resource(parsed) ? `Recorded FHIR ${parsed.resourceType}`
            : typeof parsed === 'string' ? 'Recorded text (not valid FHIR JSON; may be incomplete, truncated or redacted)' : 'Recorded JSON (no FHIR resource type)';
        return { label: text === null ? 'Formatted display limit reached; exact value remains copyable' : label, text: text === null ? '' : typeof parsed === 'string' ? value : text, exact };
    }

    /** Render recorded headers as readable HTTP lines, without changing their values. */
    function headerView(value) {
        if (!object(value)) return bounded(value, false);
        if (bounded(value, false) === null) return null;
        return Object.entries(value).flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value]).map(item => `${name}: ${typeof item === 'string' ? item : JSON.stringify(item)}`)).join('\n');
    }

    /** Format one request while retaining original body bytes in the copy contract. */
    function requestView(candidate) {
        const values = label => candidate.fields.filter(field => field.label === label).map(field => bounded(field.value, false));
        const methods = values('Method'), urls = [...new Set(values('URL / path'))];
        const headers = candidate.fields.filter(field => field.label === 'Headers').map(field => headerView(field.value));
        const view = bodyView(candidate);
        if ([...methods, ...urls, ...headers].includes(null) || (candidate.body && view.exact === null))
            return { text: '', exact: null, method: methods.length > 0, urls: urls.filter(value => value !== null), notice: 'Display limit reached; use JSON / Structured record.' };
        const line = [...methods, ...urls].join(' ');
        const exact = [line, ...headers].filter(Boolean).join('\n') + (candidate.body ? '\n\n' + view.exact : '');
        // Only the content type is needed beside the body; other headers have a disclosure.
        const bodyText = /application\/x-www-form-urlencoded/i.test(candidate.media) && typeof candidate.body?.value === 'string'
            ? view.exact.replace(/&/g, '\n&') : view.text;
        const text = [line, candidate.body && candidate.media ? `Content-Type: ${candidate.media}` : ''].filter(Boolean).join('\n')
            + (candidate.body ? '\n\n' + bodyText : '');
        return { text, exact: exact || null, method: methods.length > 0, urls, notice: candidate.body && !/^Recorded FHIR|^Recorded JSON|^Recorded form/.test(view.label) ? view.label : '' };
    }

    /** Build compact safe DOM lazily. Original paths remain in the generic record tabs. */
    function mount(host, evidence, { copy = () => {} } = {}) {
        host.replaceChildren(); const document = host.ownerDocument; let remaining = LIMITS.outputChars;
        const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
        const action = (label, value) => { const button = node('button', label); button.type = 'button'; button.className = 'btn'; button.dataset.helpKey = 'logs.fhir-copy'; button.addEventListener('click', () => copy(value)); return button; };
        const note = (parent, text) => { const p = node('p', text); p.className = 'fhir-note'; parent.append(p); };
        const textBlock = (parent, text, label) => {
            if (text.length > remaining) { note(parent, 'Formatted output limit reached. Use JSON / Structured record for the original.'); return; }
            remaining -= text.length; const pre = node('pre', text); pre.tabIndex = 0; pre.setAttribute('aria-label', label); parent.append(pre);
        };
        const disclosure = (parent, title, text, label) => {
            const details = node('details'); details.append(node('summary', title)); textBlock(details, text, label); parent.append(details); return details;
        };
        const parameters = (parent, title, encoded, label) => {
            const parsed = pairs(encoded);
            return disclosure(parent, `${title} · ${parsed.values.length}${parsed.limited ? ' (first 200)' : ''}`,
                parsed.values.map(pair => `${pair.name} = ${pair.value}`).join('\n'), label);
        };
        for (const side of ['request', 'response']) {
            const title = side === 'request' ? 'Request' : 'Response';
            if (!evidence[side].length) {
                const section = node('section'); section.className = 'fhir-candidate'; section.append(node('h3', title)); note(section, missing); host.append(section); continue;
            }
            evidence[side].forEach((candidate, index) => {
                const section = node('section'); section.className = 'fhir-candidate';
                const heading = node('div'); heading.className = 'fhir-heading';
                heading.append(node('h3', title + (evidence[side].length > 1 ? ` ${index + 1}` : ''))); section.append(heading);
                const view = bodyView(candidate);
                if (side === 'request') {
                    const request = requestView(candidate);
                    if (request.exact !== null) heading.append(action('Copy request', request.exact));
                    if (request.text) textBlock(section, request.text, 'Request');
                    if (!request.method) note(section, 'Method not recorded.');
                    if (!request.urls.length) note(section, 'URL not recorded.');
                    if (request.notice) note(section, request.notice);
                    if (!candidate.body && candidate.fields.some(field => field.label === 'Method' && !/^GET$/i.test(field.value))) note(section, 'Request body not recorded.');
                    for (const url of request.urls) {
                        const start = url.indexOf('?');
                        if (start >= 0) {
                            const details = parameters(section, 'Query parameters', url.slice(start + 1).split('#')[0], 'Request query parameters');
                            details.append(action('Copy request URL', url));
                        }
                    }
                    if (candidate.body && /application\/x-www-form-urlencoded/i.test(candidate.media) && typeof candidate.body.value === 'string' && view.exact !== null) {
                        const details = parameters(section, 'Decoded form parameters', candidate.body.value, 'Decoded form parameters');
                        details.append(action('Copy request body', view.exact));
                    } else if (view.exact !== null) section.append(action('Copy request body', view.exact));
                } else {
                    for (const field of candidate.fields.filter(field => field.label === 'Status')) {
                        const status = bounded(field.value, false);
                        if (status !== null) { const badge = node('span', status); badge.className = Number(status) >= 400 ? 'fhir-status fhir-error' : 'fhir-status'; heading.append(badge); }
                    }
                    if (view.exact !== null) heading.append(action(/^Recorded FHIR|^Recorded JSON/.test(view.label) ? 'Copy JSON' : 'Copy response body', view.exact));
                    if (view.text !== '') textBlock(section, view.text, 'Response body');
                    if (!/^Recorded FHIR|^Recorded JSON/.test(view.label)) note(section, view.label);
                }
                for (const field of candidate.fields.filter(field => field.label === 'Headers')) {
                    const text = headerView(field.value);
                    if (text === null) { note(section, 'Header display limit reached; use JSON / Structured record.'); continue; }
                    disclosure(section, `${title} headers${object(field.value) ? ` · ${Object.keys(field.value).length}` : ''}`, text, `${title} headers`);
                }
                // False markers are ordinary capture metadata, while affirmative markers matter here.
                for (const field of candidate.fields.filter(field => field.label === 'Capture marker' && field.value !== false && field.value !== null && field.value !== '')) {
                    const value = bounded(field.value, false);
                    note(section, `Capture ${/redact/i.test(field.path.at(-1)) ? 'redacted' : 'truncated'}${value && value !== 'true' ? `: ${value}` : '.'}`);
                }
                host.append(section);
            });
        }
        for (const notice of evidence.notices) note(host, notice);
    }
    return { LIMITS, EVENTS, route, pairs, extract, bodyView, headerView, requestView, mount };
});
