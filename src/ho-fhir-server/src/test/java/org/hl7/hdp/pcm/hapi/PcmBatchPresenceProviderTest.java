package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.jpa.api.dao.IFhirSystemDao;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.InvalidRequestException;
import ca.uhn.fhir.rest.server.exceptions.PayloadTooLargeException;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Patient;
import org.hl7.fhir.r4.model.Meta;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Root provider proves import delegation plus batch isolation, limits, and timeout. */
class PcmBatchPresenceProviderTest {
    private static final String SYSTEM = "http://fhir.health.gov.il/identifier/il-hdp-test-id";
    private static final PcmPatientIdentifier ONE = new PcmPatientIdentifier(SYSTEM, "1");
    private static final PcmPatientIdentifier TWO = new PcmPatientIdentifier(SYSTEM, "2");
    private final FhirContext fhir = FhirContext.forR4Cached();

    @Test
    void discoveryDelegatesOnlyValidatedReadOnlySearchesAndProjectsNestedResults() {
        PcmRequestContext context = new PcmRequestContext("ho", "client", List.of(),
                PcmRequestContext.Kind.DEPENDENT_DISCOVERY, null, List.of(), null, false, ONE);
        @SuppressWarnings("unchecked")
        IFhirSystemDao<Bundle, Meta> dao = mock(IFhirSystemDao.class);
        SystemRequestDetails request = new SystemRequestDetails();
        String encoded = java.net.URLEncoder.encode(ONE.token(), java.nio.charset.StandardCharsets.UTF_8);
        Bundle input = batch("Patient?_has:RelatedPerson:patient:identifier=" + encoded,
                "RelatedPerson?identifier=" + encoded);
        Bundle nativeResult = new Bundle().setType(Bundle.BundleType.BATCHRESPONSE);
        Bundle search = new Bundle().setType(Bundle.BundleType.SEARCHSET);
        Patient patient = new Patient(); patient.addAddress().setCity("private");
        search.addEntry().setResource(patient);
        nativeResult.addEntry().setResource(search).getResponse().setStatus("200");
        when(dao.transaction(request, input)).thenReturn(nativeResult);
        PcmBatchPresenceProvider provider = new PcmBatchPresenceProvider(r -> context, (i, r) -> 0,
                new PcmPresenceLimits(100, 16384, 1000), fhir, dao);
        Bundle result = provider.batch(input, request);
        assertThat(((Patient) ((Bundle) result.getEntryFirstRep().getResource())
                .getEntryFirstRep().getResource()).hasAddress()).isFalse();
        verify(dao).transaction(request, input);
        Bundle write = batch("Patient?identifier=" + encoded);
        write.getEntryFirstRep().getRequest().setMethod(Bundle.HTTPVerb.DELETE);
        assertThatThrownBy(() -> provider.batch(write, request)).isInstanceOf(ForbiddenOperationException.class);
        verify(dao, never()).transaction(request, write);
        Bundle expansion = batch("Patient?_has:RelatedPerson:patient:identifier=" + encoded + "&_include=*");
        assertThatThrownBy(() -> provider.batch(expansion, request)).isInstanceOf(ForbiddenOperationException.class);
        verify(dao, never()).transaction(request, expansion);
    }

    @Test
    void authorizedPresenceSupportsOnlyBoundedCountBatchesAndNeverReturnsPatients() {
        PcmRequestContext context = batchContext();
        PcmBatchPresenceProvider provider = provider(context, (identifier, request) -> identifier.equals(ONE) ? 1 : 0,
                new PcmPresenceLimits(2, 16384, 1000), Clock.systemUTC());
        Bundle result = provider.batch(batch(url(ONE), url(TWO)), new SystemRequestDetails());
        assertThat(result.getEntry()).extracting(entry -> ((Bundle) entry.getResource()).getTotal()).containsExactly(1, 0);
        assertThat(result.getEntry()).allSatisfy(entry -> assertThat(((Bundle) entry.getResource()).getEntry()).isEmpty());
        assertThatThrownBy(() -> provider.batch(batch(url(ONE), url(TWO), url(ONE)), new SystemRequestDetails()))
                .isInstanceOf(PayloadTooLargeException.class);
        assertThatThrownBy(() -> provider.batch(batch(url(ONE)).setType(Bundle.BundleType.TRANSACTION), new SystemRequestDetails()))
                .isInstanceOf(InvalidRequestException.class);
        Bundle write = batch(url(ONE));
        write.getEntryFirstRep().getRequest().setMethod(Bundle.HTTPVerb.DELETE);
        assertThat(provider.batch(write, new SystemRequestDetails()).getEntryFirstRep().getResponse().getStatus()).isEqualTo("400");
    }

    @Test
    void authorizedDiscoveryKeepsProjectionsAndRejectsWritesExpansionAndDifferentRepresentatives() {
        @SuppressWarnings("unchecked")
        IFhirSystemDao<Bundle, Meta> dao = mock(IFhirSystemDao.class);
        SystemRequestDetails request = new SystemRequestDetails();
        String encoded = java.net.URLEncoder.encode(ONE.token(), java.nio.charset.StandardCharsets.UTF_8);
        String patientUrl = "Patient?_has:RelatedPerson:patient:identifier=" + encoded + "&_elements=identifier,name";
        String relatedUrl = "RelatedPerson?identifier=" + encoded + "&_elements=identifier,patient,active,relationship";
        Bundle input = batch(patientUrl, relatedUrl);
        Patient patient = new Patient(); patient.addAddress().setCity("private");
        Bundle search = new Bundle().setType(Bundle.BundleType.SEARCHSET);
        search.addEntry().setResource(patient);
        Bundle response = new Bundle().setType(Bundle.BundleType.BATCHRESPONSE);
        response.addEntry().setResource(search).getResponse().setStatus("200");
        when(dao.transaction(request, input)).thenReturn(response);
        PcmBatchPresenceProvider provider = new PcmBatchPresenceProvider(r -> discoveryContext(), (i, r) -> 0,
                new PcmPresenceLimits(100, 16384, 1000), fhir, dao);
        assertThat(((Patient) ((Bundle) provider.batch(input, request).getEntryFirstRep().getResource()).getEntryFirstRep().getResource()).hasAddress()).isFalse();
        verify(dao).transaction(request, input);
        String otherRepresentative = java.net.URLEncoder.encode(TWO.token(), java.nio.charset.StandardCharsets.UTF_8);
        for (Bundle denied : List.of(batch(patientUrl, relatedUrl.replace(encoded, "other%7C2")),
                batch(patientUrl.replace(encoded, otherRepresentative), relatedUrl.replace(encoded, otherRepresentative)),
                batch(patientUrl + "&_include=*", relatedUrl), batch(patientUrl, relatedUrl, relatedUrl),
                batch("Observation?identifier=" + encoded, relatedUrl))) {
            assertThatThrownBy(() -> provider.batch(denied, request)).isInstanceOf(ForbiddenOperationException.class);
            verify(dao, never()).transaction(request, denied);
        }
        Bundle write = batch(patientUrl, relatedUrl);
        write.getEntryFirstRep().getRequest().setMethod(Bundle.HTTPVerb.POST);
        assertThatThrownBy(() -> provider.batch(write, request)).isInstanceOf(ForbiddenOperationException.class);
        verify(dao, never()).transaction(request, write);
    }

    private static PcmRequestContext discoveryContext() {
        // The verifier supplies the Contract-bound representative; request queries cannot choose it.
        return new PcmRequestContext("ho-a", "client", List.of(), PcmRequestContext.Kind.DEPENDENT_DISCOVERY,
                null, List.of(), null, false, ONE);
    }

    @Test
    void returnsOnlyIndependentCountSearchsetsForAuthorizedHtestIdentifiers() {
        PcmBatchPresenceProvider provider = provider(batchContext(), (identifier, request) -> identifier.equals(ONE) ? 1 : 0,
                new PcmPresenceLimits(10, 16384, 1000), Clock.systemUTC());
        Bundle response = provider.batch(batch(url(ONE), url(TWO)), new SystemRequestDetails());

        assertThat(response.getType()).isEqualTo(Bundle.BundleType.BATCHRESPONSE);
        assertThat(response.getEntry()).hasSize(2).allSatisfy(entry -> {
            assertThat(entry.getResponse().getStatus()).isEqualTo("200");
            assertThat(entry.getResource()).isInstanceOf(Bundle.class);
            assertThat(((Bundle) entry.getResource()).getEntry()).isEmpty();
        });
        assertThat(((Bundle) response.getEntry().get(0).getResource()).getTotal()).isEqualTo(1);
        assertThat(((Bundle) response.getEntry().get(1).getResource()).getTotal()).isZero();
    }

    @Test
    void isolatesMalformedAndUnauthorizedEntriesWithoutReturningPatients() {
        Bundle malformed = batch("Patient?identifier=x%7C1&_summary=count&_count=1");
        malformed.getEntryFirstRep().addExtension().setUrl("https://example.invalid/not-allowed");
        Bundle response = provider(batchContext(), (identifier, request) -> 1,
                new PcmPresenceLimits(10, 16384, 1000), Clock.systemUTC())
                .batch(batch(url(ONE), url(new PcmPatientIdentifier(SYSTEM, "3")),
                        "Patient?identifier=x%7C1&_summary=count&_count=1"), new SystemRequestDetails());

        assertThat(response.getEntry()).extracting(entry -> entry.getResponse().getStatus())
                .containsExactly("200", "403", "400");
        assertThat(response.getEntry()).noneMatch(entry -> entry.getResource() instanceof Patient);

        Bundle extensionResponse = provider(batchContext(), (identifier, request) -> 1,
                new PcmPresenceLimits(10, 16384, 1000), Clock.systemUTC())
                .batch(malformed, new SystemRequestDetails());
        assertThat(extensionResponse.getEntryFirstRep().getResponse().getStatus()).isEqualTo("400");
    }

    @Test
    void rejectsTransactionsWrongTokenKindsExtraOuterFieldsAndOperationalLimits() {
        Bundle transaction = batch(url(ONE), url(TWO)).setType(Bundle.BundleType.TRANSACTION);
        assertThatThrownBy(() -> provider(batchContext(), (i, r) -> 1,
                new PcmPresenceLimits(10, 16384, 1000), Clock.systemUTC()).batch(transaction, new SystemRequestDetails()))
                .isInstanceOf(InvalidRequestException.class);

        Bundle extra = batch(url(ONE), url(TWO));
        extra.setId("not-allowed");
        assertThatThrownBy(() -> provider(batchContext(), (i, r) -> 1,
                new PcmPresenceLimits(10, 16384, 1000), Clock.systemUTC()).batch(extra, new SystemRequestDetails()))
                .isInstanceOf(InvalidRequestException.class);

        assertThatThrownBy(() -> provider(clinicalContext(), (i, r) -> 1,
                new PcmPresenceLimits(10, 16384, 1000), Clock.systemUTC())
                .batch(batch(url(ONE), url(TWO)), new SystemRequestDetails()))
                .isInstanceOf(ForbiddenOperationException.class);
        assertThatThrownBy(() -> provider(batchContext(), (i, r) -> 1,
                new PcmPresenceLimits(2, 16384, 1000), Clock.systemUTC())
                .batch(batch(url(ONE), url(TWO), url(ONE)), new SystemRequestDetails()))
                .isInstanceOf(PayloadTooLargeException.class);

        SystemRequestDetails oversized = new SystemRequestDetails();
        oversized.addHeader("Content-Length", "20000");
        assertThatThrownBy(() -> provider(batchContext(), (i, r) -> 1,
                new PcmPresenceLimits(10, 16384, 1000), Clock.systemUTC()).batch(batch(url(ONE), url(TWO)), oversized))
                .isInstanceOf(PayloadTooLargeException.class);

        SystemRequestDetails negativeLength = new SystemRequestDetails();
        negativeLength.addHeader("Content-Length", "-1");
        assertThatThrownBy(() -> provider(batchContext(), (i, r) -> 1,
                new PcmPresenceLimits(10, 16384, 1000), Clock.systemUTC()).batch(batch(url(ONE)), negativeLength))
                .isInstanceOf(PayloadTooLargeException.class);
    }

    @Test
    void wholeRequestTimeoutFailsClosed() {
        Clock clock = mock(Clock.class);
        when(clock.millis()).thenReturn(0L, 100L);
        PcmBatchPresenceProvider provider = provider(batchContext(), (identifier, request) -> 1,
                new PcmPresenceLimits(10, 16384, 50), clock);
        assertThatThrownBy(() -> provider.batch(batch(url(ONE), url(TWO)), new SystemRequestDetails()))
                .isInstanceOf(ForbiddenOperationException.class);
    }

    @Test
    void delegatesAuthenticatedImportTransactionsToTheNativeSystemDao() {
        @SuppressWarnings("unchecked")
        IFhirSystemDao<Bundle, Meta> systemDao = mock(IFhirSystemDao.class);
        Bundle transaction = new Bundle().setType(Bundle.BundleType.TRANSACTION);
        Bundle expected = new Bundle().setType(Bundle.BundleType.TRANSACTIONRESPONSE);
        SystemRequestDetails request = new SystemRequestDetails();
        when(systemDao.transaction(request, transaction)).thenReturn(expected);

        PcmBatchPresenceProvider provider = new PcmBatchPresenceProvider(
                ignored -> importContext(), (identifier, details) -> 0,
                new PcmPresenceLimits(10, 16384, 1000), fhir, systemDao, Clock.systemUTC());

        assertThat(provider.batch(transaction, request)).isSameAs(expected);
        verify(systemDao).transaction(request, transaction);
    }

    @Test
    void rejectsNonTransactionImportBundlesWithoutCallingTheSystemDao() {
        @SuppressWarnings("unchecked")
        IFhirSystemDao<Bundle, Meta> systemDao = mock(IFhirSystemDao.class);
        PcmBatchPresenceProvider provider = new PcmBatchPresenceProvider(
                ignored -> importContext(), (identifier, details) -> 0,
                new PcmPresenceLimits(10, 16384, 1000), fhir, systemDao, Clock.systemUTC());

        assertThatThrownBy(() -> provider.batch(batch(url(ONE)), new SystemRequestDetails()))
                .isInstanceOf(InvalidRequestException.class);
        verify(systemDao, never()).transaction(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }

    private PcmBatchPresenceProvider provider(
            PcmRequestContext context,
            PatientPresenceCounter counter,
            PcmPresenceLimits limits,
            Clock clock) {
        @SuppressWarnings("unchecked")
        IFhirSystemDao<Bundle, Meta> systemDao = mock(IFhirSystemDao.class);
        return new PcmBatchPresenceProvider(request -> context, counter, limits, fhir, systemDao, clock);
    }

    private static PcmRequestContext batchContext() {
        return new PcmRequestContext("ho-a", "pcm-presence-orchestrator", List.of(),
                PcmRequestContext.Kind.BATCH_PRESENCE, null, List.of(ONE, TWO), null, false);
    }

    private static PcmRequestContext clinicalContext() {
        return new PcmRequestContext("ho-a", "client", List.of());
    }

    private static PcmRequestContext importContext() {
        return new PcmRequestContext("ho-a", "private-loader", List.of(), true);
    }

    private static Bundle batch(String... urls) {
        Bundle bundle = new Bundle().setType(Bundle.BundleType.BATCH);
        for (String url : urls) bundle.addEntry().getRequest().setMethod(Bundle.HTTPVerb.GET).setUrl(url);
        return bundle;
    }

    private static String url(PcmPatientIdentifier identifier) {
        return "Patient?identifier=" + identifier.system().replace(":", "%3A").replace("/", "%2F")
                + "%7C" + identifier.value() + "&_summary=count&_count=0";
    }
}
