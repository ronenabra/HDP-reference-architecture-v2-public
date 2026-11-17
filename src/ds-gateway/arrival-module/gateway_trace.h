/* W3C validation shared by the native observer and its standalone contract test.
 * This accepts only bounded printable headers, matching the Node trace boundary.
 * A caller context is a causal hint, never authenticated source identity. */
#ifndef GATEWAY_TRACE_H
#define GATEWAY_TRACE_H
#include <stddef.h>

/* Return a lowercase hex digit, or -1 when the input is not canonical hex. */
static int gateway_hex(unsigned char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

/* Validate the complete header before the caller copies its known v00 prefix.
 * Future versions may append printable fields; reserved flag bits are not copied.
 * Duplicate headers are rejected separately at the HTTP header-list boundary. */
static int gateway_trace_valid(const unsigned char *value, size_t length) {
    size_t i;
    int trace_nonzero = 0, span_nonzero = 0;
    if (!value || length < 55 || length > 512) return 0;
    for (i = 0; i < length; i++)
        if (value[i] < 0x21 || value[i] > 0x7e || value[i] == ',') return 0;
    for (i = 0; i < 55; i++) {
        if (i == 2 || i == 35 || i == 52) {
            if (value[i] != '-') return 0;
        } else if (gateway_hex(value[i]) < 0) return 0;
        if (i >= 3 && i < 35 && value[i] != '0') trace_nonzero = 1;
        if (i >= 36 && i < 52 && value[i] != '0') span_nonzero = 1;
    }
    if (!trace_nonzero || !span_nonzero || (value[0] == 'f' && value[1] == 'f')) return 0;
    if (value[0] == '0' && value[1] == '0') return length == 55;
    return length == 55 || value[55] == '-';
}
#endif
