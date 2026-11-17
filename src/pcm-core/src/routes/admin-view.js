'use strict';
/** Build the Admin view model. Rendering performs no configuration write or clinical lookup. */
module.exports = function renderAdminHtml(req, options = {}, dependencies) {
    const { loadTeamConfig, applicationPath, getEffectiveConformancePolicy, getCertificateThumbprints, browserNavigation, getPublicBaseUrls, buildDeploymentEndpoints, getConfiguredDataSources, SIMULATION_CONTROLS, PRESETS, presetSimulationDefaults, presetSourceDefaults, managedFhirServers, confirmationToken, getDataOperationRegistry, escapeHtml, formatByteLimit, operationSummary, parseBusinessIdentifier, CONNECTATHON_REPO_URL } = dependencies;
    const config = loadTeamConfig();
    const basePath = applicationPath(config.publicBaseUrls.pcmUi).replace(/\/$/, '');
    const policy = getEffectiveConformancePolicy(config);
    const ownInspection = require('../../../shared/conformance-policy').serviceProviderOwnTokenIntrospection(config);
    const thumbprints = getCertificateThumbprints();
    const urls = browserNavigation(getPublicBaseUrls(), req, 'pcmUi');
    const deploymentEndpoints = buildDeploymentEndpoints(req);
    const configuredSources = getConfiguredDataSources(config, { includeDisabled: true });
    const identityMappings = config.identityMapping?.businessIdOverrides || {};
    const dsGatewaySecurity = config.security?.dsGatewayToFhirServer || {};
    const dsFhirServerSecurity = config.security?.dsFhirServer || {};
    const simulationControls = policy.simulation.controls;
    const draft = (formPath, field, fallback) => require('./admin-draft').draftValue(req, options, formPath, field, fallback);
    const draftChecked = (formPath, field, fallback) => require('./admin-draft').draftChecked(req, options, formPath, field, fallback);
    // Failed commands return only to their route-owned source and view. The route
    // target wins over untrusted query state; navigation itself never submits drafts.
    const sourceModel = require('./admin-source-model');
    if (/^\/admin\/workflow-sources/.test(req?.path || '')) req = { ...req, path: req.path, query: { section: 'sources', view: 'workflows' } };
    const routeServerId = req?.params?.serverId || getDataOperationRegistry().get(req?.params?.operationId)?.serverId;
    const routeSource = configuredSources.find(source => (req?.params?.id && source.id === req.params.id) || (req?.path === '/admin/config/data-sources/remove' && source.id === req.body?.id) || (routeServerId && source.healthOrganizationId === config.healthOrganizations.find(ho => ho.clinicalData?.serverId === routeServerId)?.id));
    const legacy = configuredSources.find(source => source.compatibilityOnly || (source.builtIn && !source.healthOrganizationId));
    let operationView = '', operationSource;
    if (/^\/admin\/config\/identity-mapping\//.test(req?.path || '')) { operationView = 'mappings'; operationSource = legacy; }
    else if (req?.body?.adminForm === 'legacy-upstream') { operationView = 'upstream'; operationSource = legacy; }
    else if (['/admin/config/presence-limits', '/admin/config/clinical-query-limits'].includes(req?.path)) { req = { ...req, path: req.path, query: { section: 'sources', view: 'defaults' } }; }
    else if (routeSource) { operationSource = routeSource; operationView = /\/(?:limits|clinical-query-limits)$/.test(req.path) ? 'limits' : /fhir-servers|data-operations/.test(req.path) ? 'data' : /server-trust/.test(req.path) ? 'trust' : /cert|client-bundle/.test(req.path) ? 'credentials' : 'registration'; }
    if (options.adminError && req?.body?.adminForm === 'simulation') req = { ...req, path: req.path, query: { ...req.query, section: 'security', source: req.body.sourceId || '' } };
    const failedSourceId = req?.params?.id || (req?.path === '/admin/config/data-sources/remove' ? req.body?.id : '');
    if (options.adminError && failedSourceId && /^\/admin\/config\/data-sources\//.test(req?.path || '') && !operationSource) req = {
        ...req, path: req.path, query: { ...req.query, source: failedSourceId, view: /\/(?:limits|clinical-query-limits)$/.test(req.path) ? 'limits' : /server-trust/.test(req.path) ? 'trust' : /cert|client-bundle/.test(req.path) ? 'credentials' : 'registration' }
    };
    if (options.adminError && req?.path === '/admin/config/data-sources/add') req = { ...req, path: req.path, query: { ...req.query, source: '', view: 'onboarding' } };
    if (options.adminError && operationView) req = { ...req, path: req.path, query: { ...req.query, source: operationSource?.id || '', view: operationView } };

    const sourceDirectory = sourceModel.sourceDirectory(configuredSources, managedFhirServers(config));
    const workspace = sourceModel.sourceWorkspace(req, sourceDirectory);
    const managedServerBlocks = require('./admin-data-view')({ config, selectedServerId: workspace.selected?.server?.id || '', basePath, managedFhirServers, confirmationToken, getDataOperationRegistry, escapeHtml, formatByteLimit, operationSummary, draft });
    const adminError = options.adminError;
    const adminErrorAlert = adminError ? `
      <div id="admin-error-summary" class="alert alert-danger" data-help-key="common.feedback">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
          <div>
            <strong data-help-key="common.feedback">Could not complete admin action</strong>
            <div class="small mt-1">${escapeHtml(adminError.message || 'The admin request failed.')}</div>
          </div>
          <span class="badge bg-danger">${escapeHtml(String(adminError.statusCode || 400))}</span>
        </div>
        ${adminError.details && Object.keys(adminError.details).length ? `
          <details class="mt-2">
            <summary data-help-key="common.details">Details</summary>
            <pre class="small bg-light border rounded p-2 mt-2 mb-0">${escapeHtml(JSON.stringify(adminError.details, null, 2))}</pre>
          </details>
        ` : ''}
      </div>
    ` : '';
    const sanityView = require('../admin-sanity-view').sanityView(options.sanityResult);
    const identityMappingRows = Object.entries(identityMappings).map(([businessId, internalId]) => {
        const parsed = parseBusinessIdentifier(businessId);
        return `
          <tr>
            <td data-label="Naming system" data-help-key="admin.mapping-system" class="font-monospace small">${escapeHtml(parsed?.system || '')}</td>
            <td data-label="Business value" data-help-key="admin.mapping-business" class="font-monospace small">${escapeHtml(parsed?.value || businessId)}</td>
            <td data-label="Local identifier" data-help-key="admin.mapping-internal" class="font-monospace small">${escapeHtml(internalId)}</td>
            <td data-label="Action" class="text-end">
              <form method="post" action="${escapeHtml(basePath)}/admin/config/identity-mapping/remove" class="d-inline">
                <input type="hidden" name="adminForm" value="legacy-mapping"><input type="hidden" name="expectedRevision" value="${Number(config.runtime.revision) || 0}"><input type="hidden" name="businessId" value="${escapeHtml(businessId)}">
                <button data-help-key="admin.mapping-remove" class="btn btn-sm btn-outline-danger" title="Remove this explicit business-to-internal identity mapping.">Remove</button>
              </form>
            </td>
          </tr>
    `;
    }).join('') || '<tr><td data-help-key="admin.mapping-empty" colspan="4" class="text-muted">No explicit overrides configured.</td></tr>';

    const shell = require('./admin-shell');
    const state = shell.sectionState(options.section ? { ...req, query: { ...req?.query, section: options.section } } : req, configuredSources);
    const context = { ...dependencies, draft, draftChecked, req, options, config, basePath, policy, ownInspection, thumbprints, urls,
        deploymentEndpoints, configuredSources, identityMappings, dsGatewaySecurity, dsFhirServerSecurity,
        simulationControls, securityModel: require('../admin-security'), managedServerBlocks, adminErrorAlert, sanityView,
        identityMappingRows, sourceDirectory, workspace, sourceModel, state, shell, require };
    return shell.render(context);
};
