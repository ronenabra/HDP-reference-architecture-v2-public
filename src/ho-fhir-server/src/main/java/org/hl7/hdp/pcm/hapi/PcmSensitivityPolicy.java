package org.hl7.hdp.pcm.hapi;

import java.util.Set;
import java.util.stream.Collectors;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.r4.model.Resource;

/** Fail closed for upstream-unresolved sensitivity combinations on compiled bucket alternatives. */
final class PcmSensitivityPolicy {
    private static final String LOCAL = "http://fhir.health.gov.il/cs/il-core-sensitivity-labels";
    private static final String ACT = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
    private static final Set<String> LOCAL_CODES = Set.of("genetics", "mental-health", "gynecology", "fertility",
            "adoption-surrogacy", "domestic-violence", "sexual-violence", "social-work");
    private static final Set<String> ACT_CODES = Set.of("HIV", "PHY", "PRS", "NOPAT");

    private PcmSensitivityPolicy() { }

    /** Only compiled bucket/sensitivity alternatives need this guard; full access/Patient identity do not. */
    static boolean requiresGuard(String expression) {
        return expression != null && expression.contains("_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|")
                && expression.contains("_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V");
    }

    /** Leave category OR and exclusions to HAPI; deny unknown codes and mixed sensitivity records as unsupported. */
    static boolean permits(String expression, IBaseResource resource) {
        if (!requiresGuard(expression)) return true;
        if (!(resource instanceof Resource record)) return false;
        var labels = record.getMeta().getSecurity().stream()
                .filter(label -> LOCAL.equals(label.getSystem()) || ACT.equals(label.getSystem())).toList();
        if (labels.stream().anyMatch(label -> !(LOCAL.equals(label.getSystem()) ? LOCAL_CODES : ACT_CODES).contains(label.getCode()))) return false;
        // The pinned guide leaves mixed-record policy open. A multi-category record
        // is unsupported, even when each label appears in the grant's positive OR.
        return labels.stream().map(label -> label.getSystem() + "|" + label.getCode()).distinct().count() <= 1;
    }
}
