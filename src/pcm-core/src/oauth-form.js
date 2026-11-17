'use strict';

/** Bounded OAuth wire decoding before generic application body parsers run. */
const express = require('express');
const { transportLimits } = require('../../shared/presence-limits');
const { parseForm } = require('./rar-request');

/** Return middleware which accepts exactly one UTF-8 URL-encoded OAuth body. */
function createOAuthFormParser(getConfig = () => ({})) {
    return (req, res, next) => {
        if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'OAuth requires a UTF-8 encoded form' });
        }
        const limits = transportLimits(getConfig());
        const read = express.raw({ type: () => true, limit: limits.maxEncodedFormBytes, inflate: false });
        read(req, res, error => {
            if (error) return res.status(400).json({ error: 'invalid_request', error_description: 'OAuth body encoding or size is invalid' });
            try {
                const raw = req.body;
                req.body = parseForm(raw, limits);
                req.oauthFormBytes = { encoded: Buffer.byteLength(raw), decoded: Object.entries(req.body).reduce((bytes, [name, value], index) =>
                    bytes + Buffer.byteLength(name) + Buffer.byteLength(value) + 1 + (index ? 1 : 0), 0) };
            }
            catch (failure) {
                return res.status(400).json({ error: failure.code || 'invalid_request', error_description: failure.message });
            }
            next();
        });
    };
}

module.exports = { createOAuthFormParser };
