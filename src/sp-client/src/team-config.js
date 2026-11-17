const { browserNavigation } = require('../../shared/browser-navigation');
/**
 * Minimal team configuration loader for Doctor's Portal navigation links.
 */
const fs = require('fs');
const path = require('path');
const { IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');
const { assertValidTeamConfig } = require('../../shared/team-config-validator');
const { buildEffectivePolicy } = require('../../shared/conformance-policy');

const CONFIG_PATHS = [
    '/runtime/team-config.json',
    path.join(process.cwd(), 'team-config.json')
].filter(Boolean);

/** Read the selected team file; configuration errors never select another team. */
function loadTeamConfig() {
    const filePath = process.env.TEAM_CONFIG_PATH || CONFIG_PATHS.find(candidate => fs.existsSync(candidate));
    if (!filePath) throw new Error('A complete team configuration is required; set TEAM_CONFIG_PATH');
    // Doctor owns transport/navigation configuration, not PCM catalog grant validation.
    return assertValidTeamConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')), { env: process.env });
}

function loadPublicBaseUrls(req) {
    return browserNavigation(loadTeamConfig().publicBaseUrls, req, 'spClient');
}

function loadTeamId() {
    return loadTeamConfig().teamId;
}

function loadEffectivePolicy() {
    return buildEffectivePolicy(loadTeamConfig(), process.env);
}

function loadPatients() {
    return [];
}

function choosePatientId(preferredPatientId, patients = loadPatients()) {
    const preferred = String(preferredPatientId || '').trim();
    if (preferred) return preferred;
    const patient = patients[0];
    return patient?.idSystem && patient?.idValue ? `${patient.idSystem}|${patient.idValue}` : (patient?.idValue || '');
}

/** Resolve one explicitly named participant certificate role to disk. */
function certificateRolePath(participant, purpose, field, config = loadTeamConfig()) {
    const fileName = config.certificateRoles?.[participant]?.[purpose]?.[field];
    if (!fileName) throw new Error(`Missing certificate role ${participant}.${purpose}.${field}`);
    const certsDir = process.env.CERTS_DIR || config.runtime?.certsDir || '/runtime/certs';
    return path.join(certsDir, fileName);
}

module.exports = {
    choosePatientId,
    certificateRolePath,
    loadEffectivePolicy,
    loadTeamConfig,
    loadPublicBaseUrls,
    loadPatients,
    loadTeamId
};
