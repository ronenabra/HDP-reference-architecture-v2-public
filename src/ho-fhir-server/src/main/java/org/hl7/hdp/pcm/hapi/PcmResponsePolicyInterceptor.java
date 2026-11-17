package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException;
import org.hl7.fhir.instance.model.api.IBaseConformance;
import org.hl7.fhir.instance.model.api.IBaseOperationOutcome;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.CapabilityStatement;
import org.hl7.fhir.r4.model.OperationOutcome;
import org.hl7.fhir.r4.model.Resource;
import org.hl7.fhir.r4.model.DomainResource;
import org.hl7.fhir.r4.model.Patient;
import org.hl7.fhir.r4.model.RelatedPerson;

import java.util.Set;

/** Removes authorization-sensitive totals and exposes only the bounded PCM surface. */
public final class PcmResponsePolicyInterceptor {
    private static final Set<CapabilityStatement.TypeRestfulInteraction> RESOURCE_INTERACTIONS = Set.of(
            CapabilityStatement.TypeRestfulInteraction.READ,
            CapabilityStatement.TypeRestfulInteraction.VREAD,
            CapabilityStatement.TypeRestfulInteraction.SEARCHTYPE,
            CapabilityStatement.TypeRestfulInteraction.HISTORYINSTANCE,
            CapabilityStatement.TypeRestfulInteraction.HISTORYTYPE);

    /** Ordinary protected searches omit totals and return identifier-free diagnostics. */
    @Hook(Pointcut.SERVER_OUTGOING_RESPONSE)
    public boolean removeOrdinaryTotal(RequestDetails requestDetails, IBaseResource resource) {
        Object context = requestDetails.getUserData().get(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE);
        if (context instanceof PcmRequestContext pcm && !pcm.importAccess() && resource instanceof Bundle bundle) {
            if (pcm.kind() == PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE) {
                // Cap candidates before filtering: invalid rows never trigger a wider scan.
                if (bundle.getEntry().size() > 10) bundle.getEntry().subList(10, bundle.getEntry().size()).clear();
                Set<String> seen = new java.util.HashSet<>();
                bundle.getEntry().removeIf(entry -> !(entry.getResource() instanceof Patient patient)
                        || !PcmSandboxSamplePolicy.eligiblePatient(patient, seen));
                projectBundle(bundle, pcm.kind());
                bundle.setTotalElement(null);
                bundle.getLink().clear();
                if (bundle.getEntry().size() > 10) bundle.getEntry().subList(10, bundle.getEntry().size()).clear();
            } else if (pcm.kind() == PcmRequestContext.Kind.PATIENT_AUTHENTICATION
                    || pcm.kind() == PcmRequestContext.Kind.DEPENDENT_DISCOVERY) {
                projectBundle(bundle, pcm.kind());
            } else if (pcm.kind() == PcmRequestContext.Kind.ONLINE_PRESENCE && pcm.presenceCount() != null) {
                bundle.setType(Bundle.BundleType.SEARCHSET);
                bundle.setTotal(pcm.presenceCount());
                bundle.getEntry().clear();
                bundle.getLink().clear();
            } else if (pcm.kind() == PcmRequestContext.Kind.BATCH_PRESENCE) {
                bundle.setId((String) null);
                bundle.getLink().clear();
            } else if (pcm.kind() == PcmRequestContext.Kind.DATA_SOURCE_ACCESS) {
                Object total = requestDetails.getUserData().get(PcmAuthorizedMatchExecutor.VERIFIED_TOTAL);
                if (total instanceof Integer exact && exact >= 0) {
                    bundle.setType(Bundle.BundleType.SEARCHSET).setTotal(exact);
                    bundle.getEntry().clear();
                    bundle.getLink().clear();
                } else if (requestDetails.getUserData().get(PcmAuthorizedMatchExecutor.VERIFIED_PAGE_TOTAL) instanceof Integer exact && exact >= 0) {
                    bundle.setTotal(exact);
                } else {
                    bundle.setTotalElement(null);
                }
            }
        }
        if (!(context instanceof PcmRequestContext pcm && pcm.importAccess())
                && resource instanceof OperationOutcome outcome) {
            sanitize(outcome);
        }
        PcmRuntimeObservability.outgoing(requestDetails, resource,
                context instanceof PcmRequestContext pcm && java.util.Set.of(PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE,
                        PcmRequestContext.Kind.PATIENT_AUTHENTICATION, PcmRequestContext.Kind.DEPENDENT_DISCOVERY).contains(pcm.kind()));
        return true;
    }

    /** Exception outcomes bypass the ordinary outgoing-resource hook in HAPI. */
    @Hook(Pointcut.SERVER_OUTGOING_FAILURE_OPERATIONOUTCOME)
    public void sanitizeFailure(RequestDetails requestDetails, IBaseOperationOutcome outcome) {
        Object context = requestDetails.getUserData().get(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE);
        if (!(context instanceof PcmRequestContext pcm && pcm.importAccess())
                && outcome instanceof OperationOutcome r4Outcome) {
            sanitize(r4Outcome);
        }
    }

    /** Install the safe outcome before HAPI serializes an outgoing exception. */
    @Hook(Pointcut.SERVER_PRE_PROCESS_OUTGOING_EXCEPTION)
    public BaseServerResponseException sanitizeException(RequestDetails requestDetails, Throwable throwable) {
        if (!(throwable instanceof BaseServerResponseException responseException)) return null;
        Object context = requestDetails.getUserData().get(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE);
        if (!(context instanceof PcmRequestContext pcm && pcm.importAccess())) {
            OperationOutcome outcome = new OperationOutcome();
            sanitize(outcome);
            responseException.setOperationOutcome(outcome);
            responseException.setResponseBody(null);
        }
        return responseException;
    }

    /** Project each search result, including nested batch results, before serialization. */
    static void projectBundle(Bundle bundle, PcmRequestContext.Kind kind) {
        bundle.setTotalElement(null);
        for (Bundle.BundleEntryComponent entry : bundle.getEntry()) {
            Resource source = entry.getResource();
            if (source instanceof Bundle nested) {
                projectBundle(nested, kind);
                continue;
            }
            if (source instanceof OperationOutcome outcome) {
                sanitize(outcome);
                continue;
            }
            DomainResource projected;
            if (source instanceof Patient patient) {
                Patient result = new Patient();
                patient.getIdentifier().stream().filter(value -> kind != PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE
                        || PcmSandboxSamplePolicy.SYSTEM.equals(value.getSystem())).forEach(value -> result.addIdentifier(value.copy()));
                patient.getName().forEach(value -> result.addName(value.copy()));
                // Modifier elements retain their meaning even in a subsetted response.
                if (kind != PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE && patient.hasActiveElement()) result.setActiveElement(patient.getActiveElement().copy());
                if (kind != PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE && patient.hasDeceased()) result.setDeceased(patient.getDeceased().copy());
                if ((kind == PcmRequestContext.Kind.PATIENT_AUTHENTICATION
                        || kind == PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE) && patient.hasBirthDateElement()) {
                    // Copy DateType directly to retain year/month/day precision without deriving age.
                    result.setBirthDateElement(patient.getBirthDateElement().copy());
                }
                if (kind == PcmRequestContext.Kind.PATIENT_AUTHENTICATION) {
                    patient.getTelecom().forEach(value -> result.addTelecom(value.copy()));
                }
                projected = result;
            } else if (source instanceof RelatedPerson related
                    && kind == PcmRequestContext.Kind.DEPENDENT_DISCOVERY) {
                RelatedPerson result = new RelatedPerson();
                related.getIdentifier().forEach(value -> result.addIdentifier(value.copy()));
                if (related.hasPatient()) result.setPatient(related.getPatient().copy());
                if (related.hasActiveElement()) result.setActiveElement(related.getActiveElement().copy());
                related.getRelationship().forEach(value -> result.addRelationship(value.copy()));
                projected = result;
            } else {
                throw new ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException("PCM result type denied");
            }
            projected.setId(source.getIdElement().copy());
            projected.setMeta(source.getMeta().copy());
            if (kind != PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE && source.hasImplicitRules()) projected.setImplicitRulesElement(source.getImplicitRulesElement().copy());
            if (kind != PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE && source.hasLanguage()) projected.setLanguageElement(source.getLanguageElement().copy());
            if (kind != PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE && source instanceof DomainResource domain) {
                domain.getModifierExtension().forEach(value -> projected.addModifierExtension(value.copy()));
            }
            if (!projected.getMeta().getTag().stream().anyMatch(tag -> "http://terminology.hl7.org/CodeSystem/v3-ObservationValue".equals(tag.getSystem()) && "SUBSETTED".equals(tag.getCode()))) {
                projected.getMeta().addTag("http://terminology.hl7.org/CodeSystem/v3-ObservationValue", "SUBSETTED", null);
            }
            entry.setResource(projected);
        }
    }

    private static void sanitize(OperationOutcome outcome) {
        outcome.getIssue().clear();
        outcome.addIssue()
                .setSeverity(OperationOutcome.IssueSeverity.ERROR)
                .setCode(OperationOutcome.IssueType.PROCESSING)
                .setDiagnostics("PCM request denied");
    }

    /** Filter the native statement rather than advertising HAPI's wider feature set. */
    @Hook(Pointcut.SERVER_CAPABILITY_STATEMENT_GENERATED)
    public IBaseConformance limitCapability(IBaseConformance conformance) {
        if (!(conformance instanceof CapabilityStatement statement)) return conformance;
        statement.setDescription("PCM-IG 0.4.0 strict sandbox read/search/history surface; "
                + "exact authorized _summary=count and _count=0 type searches; "
                + "opt-in _total=accurate with mutation-invalidated total reuse; bounded clinical pages default 20/max 100 with fresh authority on every continuation; "
                + "single-target native Patient $everything (_type, positive _count only; no totals; native MATCH entries require s); "
                + "advanced SMART filters and Binary are unsupported");
        statement.getRest().forEach(rest -> {
            rest.getInteraction().clear();
            rest.getOperation().clear();
            rest.getResource().removeIf(resource -> !PcmSmartScopeParser.declaredResourceTypes().contains(resource.getType()));
            rest.getResource().forEach(resource -> {
                resource.getInteraction().removeIf(interaction -> !RESOURCE_INTERACTIONS.contains(interaction.getCode()));
                resource.getOperation().clear();
                if ("Patient".equals(resource.getType())) resource.addOperation().setName("everything")
                        .setDefinition("http://hl7.org/fhir/OperationDefinition/Patient-everything")
                        .setDocumentation("GET instance or type form resolves exactly one verified clinical Patient; _type and positive _count only; no total; graph MATCH entries require search permission");
                resource.getSearchParam().removeIf(parameter -> !Set.of(
                        "_id", "_security", "identifier", "status", "code", "subject", "patient",
                        "performer", "date", "effective", "category").contains(parameter.getName()));
            });
        });
        return statement;
    }
}
