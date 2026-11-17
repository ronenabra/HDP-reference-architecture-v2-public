package org.hl7.hdp.pcm.hapi;

import java.util.Set;
import java.util.regex.Pattern;

/** Conservative admission check for the HAPI in-memory matcher subset. */
public final class PcmFilterSupport {
    private static final Pattern RESOURCE_TYPE = Pattern.compile("[A-Z][A-Za-z0-9]{0,63}");
    private static final Set<String> EXPLICITLY_DEFERRED = Set.of("_has", "_filter", "_lastUpdated");
    private static final Set<String> BASELINE_PARAMETERS = Set.of(
            "_security", "_tag", "identifier", "status", "code", "subject", "patient",
            "performer", "date", "effective", "category", "authoredon", "recorded-date", "effective-time", "whenhandedover");

    private PcmFilterSupport() {
    }

    /**
     * Reject expressions outside the deliberately measured baseline. This is
     * an admission guard; HAPI's AuthorizationSearchParamMatcher remains the
     * authoritative resource matcher and independently fails unsupported
     * expressions closed.
     */
    public static boolean isSupported(String resourceType, String filter) {
        if (resourceType == null || !RESOURCE_TYPE.matcher(resourceType).matches()) {
            return false;
        }
        if (filter == null || filter.isBlank()) {
            return true;
        }
        if ("Patient".equals(resourceType) && filter.startsWith("_has:RelatedPerson:patient:identifier=")) {
            String[] parts = filter.split("&", -1);
            String identifier = parts[0].substring("_has:RelatedPerson:patient:identifier=".length());
            return identifier.matches("[^|,\\s&]+\\|[^|,\\s&]+")
                    && (parts.length == 1 || parts.length == 2 && PcmWorkflowPolicy.DEMOGRAPHICS.equals(parts[1]));
        }
        for (String criterion : filter.split("&", -1)) {
            int equals = criterion.indexOf('=');
            if (equals <= 0 || equals == criterion.length() - 1) {
                return false;
            }
            String name = criterion.substring(0, equals);
            String value = criterion.substring(equals + 1);
            if (EXPLICITLY_DEFERRED.contains(name)
                    || name.indexOf('.') >= 0
                    || value.indexOf('$') >= 0
                    || java.util.Arrays.stream(value.split(",", -1)).anyMatch(token -> token.isEmpty()
                        || token.indexOf('|') >= 0 && token.indexOf('|') != token.lastIndexOf('|'))) {
                return false;
            }
            if (name.indexOf(':') >= 0 && !"_security:not".equals(name)) {
                return false;
            }
            String baseName = "_security:not".equals(name) ? "_security" : name;
            if (!BASELINE_PARAMETERS.contains(baseName)) {
                return false;
            }
        }
        return true;
    }
}
