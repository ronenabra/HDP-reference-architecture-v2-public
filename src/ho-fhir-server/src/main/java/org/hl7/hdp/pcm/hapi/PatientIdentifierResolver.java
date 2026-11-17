package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;

/** Resolves one typed business identifier to exactly one local Patient id. */
@FunctionalInterface
public interface PatientIdentifierResolver {
    String resolve(String system, String value, RequestDetails requestDetails);
}
