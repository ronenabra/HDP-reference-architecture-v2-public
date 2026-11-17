package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.jpa.api.dao.IFhirSystemDao;
import ca.uhn.fhir.rest.annotation.Transaction;
import ca.uhn.fhir.rest.annotation.TransactionParam;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.InvalidRequestException;
import ca.uhn.fhir.rest.server.exceptions.PayloadTooLargeException;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Meta;
import org.hl7.fhir.r4.model.OperationOutcome;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;

/** Root transaction provider for PCM batch-presence and authenticated private imports. */
public final class PcmBatchPresenceProvider {
    private final SignedRequestContextVerifier verifier;
    private final PatientPresenceCounter counter;
    private final PcmPresenceLimits limits;
    private java.util.function.Supplier<PcmPresenceLimits> currentLimits;
    private final FhirContext fhirContext;
    private final IFhirSystemDao<Bundle, Meta> systemDao;
    private final Clock clock;

    public PcmBatchPresenceProvider(
            SignedRequestContextVerifier verifier,
            PatientPresenceCounter counter,
            PcmPresenceLimits limits,
            FhirContext fhirContext,
            IFhirSystemDao<Bundle, Meta> systemDao) {
        this(verifier, counter, limits, fhirContext, systemDao, Clock.systemUTC());

    }

    PcmBatchPresenceProvider(
            SignedRequestContextVerifier verifier,
            PatientPresenceCounter counter,
            PcmPresenceLimits limits,
            FhirContext fhirContext,
            IFhirSystemDao<Bundle, Meta> systemDao,
            Clock clock) {
        this.verifier = verifier;
        this.counter = counter;
        this.limits = limits;
        this.currentLimits = () -> limits;
        this.fhirContext = fhirContext;
        this.systemDao = systemDao;
        this.clock = clock;
    }

    /** Attach request-time mounted configuration refresh in the production registrar. */
    PcmBatchPresenceProvider withCurrentLimits(java.util.function.Supplier<PcmPresenceLimits> supplier) {
        this.currentLimits = java.util.Objects.requireNonNull(supplier);
        return this;
    }

    /** Delegate authenticated imports or execute independent count-only batch entries. */
    @Transaction
    public Bundle batch(@TransactionParam Bundle input, RequestDetails requestDetails) {
        PcmRequestContext context = verifier.verify(requestDetails);
        if (context.importAccess()) {
            if (input == null || input.getType() != Bundle.BundleType.TRANSACTION) {
                throw new InvalidRequestException("PCM import requires a FHIR transaction Bundle");
            }
            return systemDao.transaction(requestDetails, input);
        }
        boolean unfiltered = context.kind() == PcmRequestContext.Kind.UNFILTERED_SIMULATION;
        boolean discoveryShape = input != null && input.getEntry().stream().anyMatch(entry -> entry.hasRequest()
                && entry.getRequest().hasUrl() && (entry.getRequest().getUrl().startsWith("RelatedPerson?")
                || entry.getRequest().getUrl().startsWith("Patient?") && entry.getRequest().getUrl().contains("_has")));
        if (context.kind() == PcmRequestContext.Kind.DEPENDENT_DISCOVERY || unfiltered && discoveryShape) {
            validateOuterBundle(input);
            enforcePayloadLimit(input, requestDetails);
            if (input.getEntry().size() > 2) throw denied();
            java.util.Set<String> types = new java.util.HashSet<>();
            PcmPatientIdentifier representative = null;
            for (Bundle.BundleEntryComponent entry : input.getEntry()) {
                validateReadEntry(entry);
                String url = entry.getRequest().getUrl();
                if (unfiltered) {
                    PcmPatientIdentifier requested = PcmSystemSearchPolicy.validateUnfilteredDiscoveryUrl(url);
                    if (representative != null && !representative.equals(requested)) throw denied();
                    representative = requested;
                } else PcmSystemSearchPolicy.validateUrl(context, url);
                if (!types.add(url.substring(0, url.indexOf('?')))) throw denied();
            }
            // Native batch processing preserves separate search paging and per-entry status.
            Bundle result = systemDao.transaction(requestDetails, input);
            PcmResponsePolicyInterceptor.projectBundle(result, PcmRequestContext.Kind.DEPENDENT_DISCOVERY);
            return result;
        }
        if (context.kind() != PcmRequestContext.Kind.BATCH_PRESENCE
                && context.kind() != PcmRequestContext.Kind.ONLINE_PRESENCE && !unfiltered) throw denied();
        validateOuterBundle(input);
        enforcePayloadLimit(input, requestDetails);
        if (input.getEntry().size() > currentLimits.get().maxPatients()) {
            throw new PayloadTooLargeException("PCM batch-presence operational limit exceeded");
        }

        long started = clock.millis();
        List<EntryPlan> plans = new ArrayList<>();
        for (Bundle.BundleEntryComponent entry : input.getEntry()) {
            plans.add(plan(entry, context));
        }

        Bundle response = new Bundle().setType(Bundle.BundleType.BATCHRESPONSE);
        for (EntryPlan plan : plans) {
            ensureWithinTimeout(started);
            Bundle.BundleEntryComponent result = response.addEntry();
            if (plan.errorStatus() != null) {
                result.getResponse().setStatus(plan.errorStatus());
                result.setResource(outcome());
                continue;
            }
            try {
                int count = counter.count(plan.identifier(), requestDetails);
                result.getResponse().setStatus("200");
                result.setResource(new Bundle().setType(Bundle.BundleType.SEARCHSET).setTotal(count));
            } catch (RuntimeException rejected) {
                result.getResponse().setStatus("403");
                result.setResource(outcome());
            }
        }
        ensureWithinTimeout(started);
        return response;
    }

    private EntryPlan plan(Bundle.BundleEntryComponent entry, PcmRequestContext context) {
        try {
            validateReadEntry(entry);
            Bundle.BundleEntryRequestComponent request = entry.getRequest();
            PcmPatientIdentifier identifier = PcmPresenceRequestPolicy.batchEntry(request.getUrl());
            if (context.kind() != PcmRequestContext.Kind.UNFILTERED_SIMULATION
                    && !context.presenceIdentifiers().contains(identifier)) return EntryPlan.error("403");
            return new EntryPlan(identifier, null);
        } catch (RuntimeException rejected) {
            return EntryPlan.error("400");
        }
    }

    /** Reject writes and conditional or decorated entries before delegating any work. */
    private static void validateReadEntry(Bundle.BundleEntryComponent entry) {
        if (entry.hasFullUrl() || entry.hasResource() || entry.hasSearch() || entry.hasResponse()
                || entry.hasLink() || entry.hasExtension() || entry.hasModifierExtension() || !entry.hasRequest()) throw denied();
        Bundle.BundleEntryRequestComponent request = entry.getRequest();
        if (request.getMethod() != Bundle.HTTPVerb.GET || !request.hasUrl()
                || request.hasExtension() || request.hasModifierExtension()
                || request.hasIfMatch() || request.hasIfModifiedSince()
                || request.hasIfNoneExist() || request.hasIfNoneMatch()) throw denied();
    }

    private static void validateOuterBundle(Bundle input) {
        if (input == null || input.getType() != Bundle.BundleType.BATCH || input.getEntry().isEmpty()
                || input.hasId() || input.hasMeta() || input.hasImplicitRules() || input.hasLanguage()
                || input.hasIdentifier() || input.hasTimestamp() || input.hasTotal()
                || input.hasLink() || input.hasSignature()) {
            throw new InvalidRequestException("PCM batch-presence request is invalid");
        }
    }

    private void enforcePayloadLimit(Bundle input, RequestDetails requestDetails) {
        long bytes;
        try {
            String header = requestDetails.getHeader("Content-Length");
            bytes = header == null ? fhirContext.newJsonParser().encodeResourceToString(input)
                    .getBytes(StandardCharsets.UTF_8).length : Long.parseLong(header);
        } catch (RuntimeException rejected) {
            throw new InvalidRequestException("PCM batch-presence payload length is invalid");
        }
        if (bytes < 0 || bytes > currentLimits.get().maxPayloadBytes()) {
            throw new PayloadTooLargeException("PCM batch-presence operational limit exceeded");
        }
    }

    private void ensureWithinTimeout(long started) {
        if (clock.millis() - started >= currentLimits.get().timeoutMilliseconds()) {
            throw denied();
        }
    }

    private static OperationOutcome outcome() {
        OperationOutcome outcome = new OperationOutcome();
        outcome.addIssue().setSeverity(OperationOutcome.IssueSeverity.ERROR)
                .setCode(OperationOutcome.IssueType.PROCESSING)
                .setDiagnostics("PCM request denied");
        return outcome;
    }

    private static ForbiddenOperationException denied() {
        return new ForbiddenOperationException("PCM request denied");
    }

    private record EntryPlan(PcmPatientIdentifier identifier, String errorStatus) {
        private static EntryPlan error(String status) {
            return new EntryPlan(null, status);
        }
    }
}
