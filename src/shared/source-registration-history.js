'use strict';
/** Validate irreversible custom-source identity reservations in the existing private config owner. */
const {isOpaqueClientId}=require('./pcm-contract');

/** Reject resurrection, identity reuse, malformed history and dropping a later removal on restore.
 * @param {object} config Candidate validated team configuration.
 * @param {object} [previous] Current configuration when publishing or restoring.
 * @returns {void} Throws if the candidate loses or conflicts with a reserved identity.
 */
function validateSourceRegistrationHistory(config, previous) {
    const history=config.organizations?.removedDataSourceRegistrations||[],ids=new Set(),clients=new Set();
    for(const entry of history){
        if(!/^[A-Za-z0-9.-]{1,64}$/.test(entry.id||'')||!/^[A-Za-z0-9.-]{1,64}$/.test(entry.endpointId||'')||!isOpaqueClientId(entry.clientId)||ids.has(entry.id)||clients.has(entry.clientId))throw new Error('Invalid or duplicate historical source registration');
        ids.add(entry.id);clients.add(entry.clientId);
    }
    const participants=[...(config.organizations?.dataSources||[]),...Object.values(config.organizations||{}).filter(value=>value&&!Array.isArray(value)),...Object.values(config.oauthClients||{})];
    for(const source of participants)if(ids.has(source.id)||clients.has(source.clientId))throw new Error('Historical source registration cannot be revived or its client identity reused');
    for(const entry of previous?.organizations?.removedDataSourceRegistrations||[])if(!history.some(value=>value.id===entry.id&&value.clientId===entry.clientId&&value.endpointId===entry.endpointId))throw new Error('Restore cannot discard a later source registration removal');
}
module.exports={validateSourceRegistrationHistory};
