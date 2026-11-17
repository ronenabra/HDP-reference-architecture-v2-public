'use strict';

/** Decode large, formatted JSON while respecting Node's single-string ceiling. */
const { constants } = require('buffer');
const { StringDecoder } = require('string_decoder');

/** Collapse whitespace outside strings, retaining token separators and every string byte.
 * @param {Buffer} buffer Original JSON bytes, unchanged for checksum and transmission.
 * @param {number} chunkBytes Maximum temporary output-buffer size.
 * @returns {string} JSON text with consecutive insignificant whitespace collapsed.
 */
function collapseJsonWhitespace(buffer, chunkBytes = 1024 * 1024) {
    const decoder = new StringDecoder('utf8');
    const parts = [];
    let output = Buffer.allocUnsafe(chunkBytes);
    let position = 0;
    let quoted = false;
    let escaped = false;
    let whitespace = false;
    for (let index = 0; index < buffer.length; index++) {
        const byte = buffer[index];
        if (!quoted && (byte === 32 || byte === 9 || byte === 10 || byte === 13)) {
            if (whitespace) continue;
            whitespace = true;
        } else {
            whitespace = false;
            if (quoted) {
                if (escaped) escaped = false;
                else if (byte === 92) escaped = true;
                else if (byte === 34) quoted = false;
            } else if (byte === 34) quoted = true;
        }
        output[position++] = byte;
        if (position === output.length) {
            parts.push(decoder.write(output));
            output = Buffer.allocUnsafe(chunkBytes);
            position = 0;
        }
    }
    parts.push(decoder.end(output.subarray(0, position)));
    return parts.join('');
}

/** Parse original JSON bytes, compacting only when the byte length exceeds the string ceiling. */
function parseJsonBuffer(buffer, maxStringLength = constants.MAX_STRING_LENGTH) {
    const text = buffer.length > maxStringLength ? collapseJsonWhitespace(buffer) : buffer.toString('utf8');
    return JSON.parse(text);
}

module.exports = { collapseJsonWhitespace, parseJsonBuffer };
