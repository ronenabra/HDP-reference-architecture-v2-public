package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.interceptor.consent.ConsentInterceptor;

import java.util.Map;
import java.util.Set;

/** Closes HAPI's public surface to the bounded PCM read-side sandbox contract. */
public final class PcmRoutePolicyInterceptor {
    private static final Set<RestOperationTypeEnum> ALLOWED = Set.of(
            RestOperationTypeEnum.METADATA, RestOperationTypeEnum.READ, RestOperationTypeEnum.VREAD,
            RestOperationTypeEnum.SEARCH_TYPE, RestOperationTypeEnum.GET_PAGE,
            RestOperationTypeEnum.HISTORY_INSTANCE, RestOperationTypeEnum.HISTORY_TYPE);
    private final SignedRequestContextVerifier verifier;
    private final PatientPresenceCounter presenceCounter;
    private PcmRuntimeObservability observations;

    /** Optional observer uses the final existing route outcome. */
    PcmRoutePolicyInterceptor observeWith(PcmRuntimeObservability value) { observations = value; return this; }

    public PcmRoutePolicyInterceptor(SignedRequestContextVerifier verifier) {
        this(verifier, (identifier, request) -> 0);
    }

    public PcmRoutePolicyInterceptor(SignedRequestContextVerifier verifier, PatientPresenceCounter presenceCounter) {
        this.verifier = verifier;
        this.presenceCounter = presenceCounter;
    }

    /** Reject unadvertised methods, routes and deferred query forms. */
    @Hook(Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLED)
    public void enforce(RequestDetails requestDetails, RestOperationTypeEnum operation) {
        try {
            enforceObserved(requestDetails, operation);
            if (observations != null) observations.decision(requestDetails, "HAPI_ADMISSION", "pass", "ADMISSION_ALLOWED", Map.of("stage", "route"));
        } catch (RuntimeException rejected) {
            if (observations != null) observations.decision(requestDetails, "HAPI_ADMISSION", "fail", "ROUTE_DENIED", Map.of("stage", "route"));
            throw rejected;
        }
    }

    private void enforceObserved(RequestDetails requestDetails, RestOperationTypeEnum operation) {
        final PcmRequestContext context;
        try {
            context = verifier.verify(requestDetails);
        } catch (RuntimeException rejected) {
            throw denied();
        }
        if (context.importAccess()) {
            // The verified maintenance credential already allows the complete target.
            // Filtering every candidate would materialize large searches unnecessarily.
            ConsentInterceptor.skipAllConsentForRequest(requestDetails);
            return;
        }
        if (PcmEverythingPolicy.target(requestDetails) != null) return;
        if (context.kind() == PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE) {
            if (operation != RestOperationTypeEnum.SEARCH_TYPE || !"Patient".equals(requestDetails.getResourceName())
                    || containsOperationPath(requestDetails.getRequestPath())) throw denied();
            PcmSandboxSamplePolicy.validate(requestDetails.getParameters());
            ConsentInterceptor.skipAllConsentForRequest(requestDetails);
            return;
        }
        if (context.kind() == PcmRequestContext.Kind.PATIENT_AUTHENTICATION
                || context.kind() == PcmRequestContext.Kind.DEPENDENT_DISCOVERY) {
            if (context.kind() == PcmRequestContext.Kind.DEPENDENT_DISCOVERY
                    && operation == RestOperationTypeEnum.TRANSACTION && requestDetails.getResourceName() == null) return;
            if (operation == RestOperationTypeEnum.GET_PAGE) return;
            if (operation != RestOperationTypeEnum.SEARCH_TYPE
                    || containsOperationPath(requestDetails.getRequestPath())) throw denied();
            PcmSystemSearchPolicy.validate(context, requestDetails.getResourceName(), requestDetails.getParameters());
            return;
        }
        if (context.kind() == PcmRequestContext.Kind.ONLINE_PRESENCE) {
            if (operation == RestOperationTypeEnum.TRANSACTION && requestDetails.getResourceName() == null) {
                ConsentInterceptor.skipAllConsentForRequest(requestDetails);
                return;
            }
            enforceOnlinePresence(requestDetails, operation, context);
            return;
        }
        if (context.kind() == PcmRequestContext.Kind.BATCH_PRESENCE) {
            if (operation != RestOperationTypeEnum.TRANSACTION
                    || requestDetails.getResourceName() != null) {
                throw denied();
            }
            ConsentInterceptor.skipAllConsentForRequest(requestDetails);
            return;
        }
        if (!ALLOWED.contains(operation)
                || (requestDetails.getResourceName() != null
                && !PcmSmartScopeParser.declaredResourceTypes().contains(requestDetails.getResourceName()))
                || "Binary".equals(requestDetails.getResourceName())
                || containsOperationPath(requestDetails.getRequestPath())
                || containsDeferredQuery(requestDetails.getParameters())) {
            throw denied();
        }
    }

    private void enforceOnlinePresence(
            RequestDetails requestDetails,
            RestOperationTypeEnum operation,
            PcmRequestContext context) {
        if (operation != RestOperationTypeEnum.SEARCH_TYPE) throw denied();
        try {
            PcmPatientIdentifier requested = PcmPresenceRequestPolicy.online(requestDetails);
            if (!context.presenceIdentifiers().equals(java.util.List.of(requested))) throw denied();
            int count = presenceCounter.count(requested, requestDetails);
            requestDetails.getUserData().put(
                    LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE, context.withPresenceCount(count));
            ConsentInterceptor.skipAllConsentForRequest(requestDetails);
        } catch (ForbiddenOperationException rejected) {
            throw rejected;
        } catch (RuntimeException rejected) {
            throw denied();
        }
    }

    static boolean containsDeferredQuery(Map<String, String[]> parameters) {
        for (Map.Entry<String, String[]> entry : parameters.entrySet()) {
            String name = entry.getKey();
            if ("_has".equals(name) || name.startsWith("_has:") || "_filter".equals(name)
                    || "_lastUpdated".equals(name) || name.contains(".")
                    || name.contains(":") && !"_security:not".equals(name)) {
                return true;
            }
        }
        return false;
    }

    private static boolean containsOperationPath(String path) {
        return path != null && (path.contains("$") || path.startsWith("_history"));
    }

    private static ForbiddenOperationException denied() {
        return new ForbiddenOperationException("PCM policy denied the request");
    }
}
