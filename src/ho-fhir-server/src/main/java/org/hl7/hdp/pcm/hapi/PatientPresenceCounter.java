package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;

/** Exact zero-or-one Patient presence lookup with ambiguity and HTEST checks. */
@FunctionalInterface
public interface PatientPresenceCounter {
    int count(PcmPatientIdentifier identifier, RequestDetails requestDetails);
}
