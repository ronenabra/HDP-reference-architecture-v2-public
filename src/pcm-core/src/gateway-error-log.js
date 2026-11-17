/**
 * Parser for NGINX DS Gateway error_log lines.
 */
const { randomUUID: uuidv4 } = require('crypto');

function parseNginxTimestamp(datePart, timePart) {
    const normalized = `${datePart.replace(/\//g, '-')}T${timePart}.000Z`;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function levelFromNginx(level) {
    if (['error', 'crit', 'alert', 'emerg'].includes(String(level || '').toLowerCase())) return 'ERROR';
    if (String(level || '').toLowerCase() === 'warn') return 'WARN';
    return 'INFO';
}

function extractQuotedField(message, name) {
    const match = String(message || '').match(new RegExp(`${name}: "([^"]*)"`));
    return match ? match[1] : '';
}

function extractField(message, name) {
    const match = String(message || '').match(new RegExp(`${name}: ([^,]+)`));
    return match ? match[1].trim() : '';
}

function parseNginxRequest(request = '') {
    const match = String(request).match(/^([A-Z]+)\s+(\S+)/);
    return match ? { method: match[1], url: match[2] } : {};
}

function upstreamAddr(upstream = '') {
    try {
        const parsed = new URL(upstream);
        return parsed.host;
    } catch (err) {
        return '';
    }
}

function parseGatewayErrorLine(line, options = {}) {
    const raw = String(line || '');
    const match = raw.match(/^(\d{4}\/\d{2}\/\d{2}) (\d{2}:\d{2}:\d{2}) \[(\w+)\] (\d+)#(\d+): (.*)$/);
    const level = match ? levelFromNginx(match[3]) : 'ERROR';
    const message = match ? match[6] : raw;
    const request = extractQuotedField(message, 'request');
    const parsedRequest = parseNginxRequest(request);
    const upstream = extractQuotedField(message, 'upstream');
    return {
        id: options.id || uuidv4(),
        timestamp: match ? parseNginxTimestamp(match[1], match[2]) : new Date().toISOString(),
        level,
        message: `Gateway Error: ${message}`,
        details: {
            type: 'GATEWAY_ERROR',
            category: 'system',
            visibility: 'default',
            nginxLevel: match ? match[3] : undefined,
            process: match ? `${match[4]}#${match[5]}` : undefined,
            method: parsedRequest.method,
            url: parsedRequest.url,
            originalUrl: parsedRequest.url,
            client: extractField(message, 'client'),
            request,
            upstream,
            upstreamAddr: upstreamAddr(upstream),
            host: extractQuotedField(message, 'host'),
            raw
        }
    };
}

module.exports = {
    parseGatewayErrorLine
};
