'use strict';

/** Bounded, reviewed configuration update for existing Doctor callback registrations only. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { doctorBrowserBase, registeredCallbacks, withDoctorBrowserAddress } = require('../../shared/doctor-browser-address');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const maintenance = require('../../shared/migration-maintenance');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

/** Preview exact public changes and current Organization versions without creating or enabling any client. */
function doctorBrowserPlan(config, store, base, configBytes) {
    const doctorBase = doctorBrowserBase(base), next = withDoctorBrowserAddress(config, doctorBase);
    require('../../shared/team-config-validator').assertValidTeamConfig(next, { env: {} });
    const registrations = ['serviceProvider', 'hospitalBServiceProvider'].flatMap(role => {
        const before = config.organizations[role], after = next.organizations[role];
        if (!after?.redirectUris?.length || (role !== 'serviceProvider' && !before?.smartScopes?.length)) return [];
        const organization = store.get('Organization', before.id);
        if (require('./fhir/participant-lifecycle').organizationRole(organization) !== 'service-provider') throw new Error('Existing Doctor Organization registration is unavailable; no client was created');
        const identifier = require('./fhir/participant-lifecycle').officialOrganizationIdentifier(organization);
        if (identifier?.system !== before.businessIdentifier?.system || identifier?.value !== before.businessIdentifier?.value || (before.parentId && organization.partOf?.reference !== `Organization/${before.parentId}`)) throw new Error('Existing Doctor registration ownership does not match configuration');
        return [{ role, organizationId: before.id, clientId: before.clientId, version: organization.meta?.versionId,
            previous: registeredCallbacks(before), next: registeredCallbacks(after), metadataMatches: (organization.extension || []).filter(item => item.url === EXTENSIONS.oauthRedirectUri).length === 1 && organization.extension.find(item => item.url === EXTENSIONS.oauthRedirectUri)?.valueUrl === registeredCallbacks(after)[0] }];
    });
    const changes = config.publicBaseUrls.spClient !== doctorBase || registrations.some(item => JSON.stringify(item.previous) !== JSON.stringify(item.next) || !item.metadataMatches);
    const plan = { changes, teamId: config.teamId, revision: config.runtime.revision, doctorBase, previousBase: config.publicBaseUrls.spClient,
        registrations, outstandingTransactions: 'Restart pending SMART tests after this explicit registration change.' };
    return { ...plan, reviewDigest: digest(JSON.stringify({ ...plan, configHash: digest(configBytes) })) };
}

/** Apply an unchanged review under the existing config mutex and in-memory transaction; keep private exact backups. */
function applyDoctorBrowser({ store, configPath, stateDirectory, doctorBase, reviewDigest, publish = require('./team-config').publishTeamConfig }) {
    return maintenance.withConfigurationMutation(stateDirectory, () => {
        maintenance.assertAvailable(stateDirectory);
        const previousBytes = fs.readFileSync(configPath), config = require('../../shared/team-config-validator').assertValidTeamConfig(JSON.parse(previousBytes), { env: {} });
        const plan = doctorBrowserPlan(config, store, doctorBase, previousBytes);
        if (typeof reviewDigest !== 'string' || reviewDigest !== plan.reviewDigest) throw new Error('Doctor browser review is stale or does not match this address; preview again');
        if (!plan.changes) return { status: 'unchanged', doctorBase: plan.doctorBase, revision: config.runtime.revision, restartPendingTests: false };
        const directory = path.join(stateDirectory, 'doctor-browser-backups'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const backup = path.join(directory, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
        fs.writeFileSync(backup, JSON.stringify({ configText: previousBytes.toString('utf8'), organizations: plan.registrations.map(item => store.get('Organization', item.organizationId)) }), { flag: 'wx', mode: 0o600 });
        const next = withDoctorBrowserAddress(config, plan.doctorBase);
        next.runtime.revision = (Number(next.runtime.revision) || 0) + 1; next.runtime.updatedAt = new Date().toISOString(); next.runtime.lastChangeReason = 'doctor-browser-address';
        try {
            store.transaction(() => {
                for (const registration of plan.registrations) {
                    const organization = store.get('Organization', registration.organizationId);
                    organization.extension = (organization.extension || []).filter(item => item.url !== EXTENSIONS.oauthRedirectUri);
                    organization.extension.push({ url: EXTENSIONS.oauthRedirectUri, valueUrl: registration.next[0] });
                    store.update(organization);
                }
                // This construction changes no source/compiler input or client scope/certificate/ownership field.
                publish(next);
            });
        } catch (error) {
            try { fs.writeFileSync(configPath, previousBytes); }
            catch (restoreError) {
                fs.writeFileSync(maintenance.fencePath(stateDirectory), JSON.stringify({ reason: 'Doctor browser rollback failed', backup }), { flag: 'wx', mode: 0o600 });
                throw new Error(`Doctor browser publication and rollback failed; runtime fenced. Restore the private backup before recovery. ${restoreError.message}`);
            }
            throw error;
        }
        return { status: 'applied', doctorBase: plan.doctorBase, registrations: plan.registrations.map(({ organizationId, next }) => ({ organizationId, redirectUris: next })), revision: next.runtime.revision, restartPendingTests: true };
    });
}
module.exports = { doctorBrowserPlan, applyDoctorBrowser };
