package org.hl7.hdp.pcm.hapi;

/** Stable diagnostic reason attached at the existing verifier branch; public denial remains generic. */
final class PcmContextException extends SecurityException {
    final String reasonCode;
    PcmContextException(String reasonCode, String message) { super(message); this.reasonCode = reasonCode; }
}
