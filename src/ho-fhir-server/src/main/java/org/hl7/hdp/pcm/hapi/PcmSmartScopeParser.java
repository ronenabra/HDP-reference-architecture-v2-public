package org.hl7.hdp.pcm.hapi;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Strict parser for the bounded SMART v2 resource-scope subset. */
public final class PcmSmartScopeParser {
    private static final Pattern SCOPE = Pattern.compile("(patient|system)/([A-Z][A-Za-z0-9]{0,63}|\\*)\\.([rs]{1,2})(?:\\?(.+))?");
    private static final Set<String> DECLARED_TYPES = Set.of(
            "Patient", "Observation", "Encounter", "Condition", "Procedure",
            "MedicationRequest", "Practitioner", "Organization", "PractitionerRole", "Location", "RelatedPerson", "DiagnosticReport",
            "MedicationStatement", "MedicationAdministration", "MedicationDispense", "AllergyIntolerance", "Immunization");

    private PcmSmartScopeParser() {
    }

    /** Parse a space-delimited grant into independent rules, preserving union semantics. */
    public static List<PcmReadGrant> parse(String scope, String patientId) {
        if (scope == null || scope.isBlank() || !scope.equals(scope.trim()) || scope.contains("  ")) {
            throw new SecurityException("Unsupported PCM scope expression");
        }
        boolean patientPrefix = scope.startsWith("patient/");
        if (java.util.Arrays.stream(scope.split(" ")).anyMatch(token -> token.startsWith("patient/") != patientPrefix)) {
            throw new SecurityException("Mixed Patient/system scope prefixes are unsupported");
        }
        List<PcmReadGrant> grants = new ArrayList<>();
        for (String token : scope.split(" ")) {
            Matcher match = SCOPE.matcher(token);
            if (!match.matches()) {
                throw new SecurityException("Unsupported PCM scope expression");
            }
            boolean patientLevel = "patient".equals(match.group(1));
            if (patientLevel && (patientId == null || patientId.isBlank())) {
                throw new SecurityException("Patient scope requires one local Patient");
            }
            Set<Character> interactions = new LinkedHashSet<>();
            for (char value : match.group(3).toCharArray()) interactions.add(value);
            // The added master types have only explicit Patient-context logical-ID read authority.
            // They must not extend pre-existing system or wildcard permissions.
            if (Set.of("PractitionerRole", "Location").contains(match.group(2))
                    && (!patientLevel || !interactions.equals(Set.of('r')))) {
                throw new SecurityException("Master resources require explicit Patient-context direct read");
            }
            String filter = match.group(4);
            // A Patient wildcard covers Patient-compartment resources only. Master direct reads
            // retain their separately explicit finite .r authority; no master search is inferred.
            Set<String> types = "*".equals(match.group(2))
                    ? DECLARED_TYPES.stream().filter(type -> !Set.of("PractitionerRole", "Location").contains(type) && (!patientLevel || !Set.of("Organization", "Practitioner", "PractitionerRole", "Location").contains(type)))
                            .collect(java.util.stream.Collectors.toSet())
                    : Set.of(match.group(2));
            for (String type : types) {
                if (!DECLARED_TYPES.contains(type) || !PcmFilterSupport.isSupported(type, filter)) {
                    throw new SecurityException("Unsupported PCM scope expression");
                }
                grants.add(new PcmReadGrant(type, filter, patientLevel ? patientId : null, interactions,
                        patientLevel && !"*".equals(match.group(2)) && Set.of("Organization", "Practitioner", "PractitionerRole", "Location").contains(type)
                                && interactions.equals(Set.of('r'))));
            }
        }
        return List.copyOf(grants);
    }

    /** Resource types intentionally advertised by the strict sandbox. */
    public static Set<String> declaredResourceTypes() {
        return DECLARED_TYPES;
    }
}
