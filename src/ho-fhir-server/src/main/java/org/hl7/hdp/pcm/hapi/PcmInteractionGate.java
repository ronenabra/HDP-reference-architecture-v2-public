package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;

/** Maps SMART r/s letters to the concrete HAPI read-side operations. */
public final class PcmInteractionGate {
    private PcmInteractionGate() {
    }

    public static boolean permits(PcmReadGrant grant, RestOperationTypeEnum operation) {
        // Owner-approved master scope authority is direct logical-ID READ only.
        // Includes retain the existing separately authorized clinical/system behavior.
        if (grant.masterRead()) return operation == RestOperationTypeEnum.READ;
        if (operation == null) return true;
        return switch (operation) {
            case READ, VREAD, HISTORY_INSTANCE -> grant.interactions().contains('r');
            case SEARCH_TYPE, GET_PAGE, HISTORY_TYPE -> grant.interactions().contains('s');
            default -> false;
        };
    }

    /** Search responses may also carry referenced resources granted for read. */
    public static boolean permitsAdmission(
            PcmReadGrant grant,
            RestOperationTypeEnum operation,
            String requestResourceType) {
        return permitsResult(grant, operation, requestResourceType);
    }

    /**
     * Select grants that may authorize resources returned for this request.
     *
     * <p>A same-type {@code r} grant must not authorize primary results from a
     * search admitted by a separate {@code s} grant. A read grant for another
     * type remains available for included or reverse-included resources.</p>
     */
    public static boolean permitsResult(
            PcmReadGrant grant,
            RestOperationTypeEnum operation,
            String requestResourceType) {
        if (grant.masterRead()) return operation == RestOperationTypeEnum.READ && grant.resourceType().equals(requestResourceType);
        if (permits(grant, operation)) return true;
        return (operation == RestOperationTypeEnum.SEARCH_TYPE || operation == RestOperationTypeEnum.GET_PAGE)
                && grant.interactions().contains('r')
                && requestResourceType != null
                && !requestResourceType.equals(grant.resourceType());
    }
}
