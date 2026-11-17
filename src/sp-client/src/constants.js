/**
 * Shared constants for the SP client.
 */
const contract = require('../../shared/pcm-contract');

const EXT_PCM_SERVICE = contract.EXTENSIONS.pcmService;

module.exports = {
    ...contract,
    EXT_PCM_SERVICE
};
