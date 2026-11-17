/* Fail-early native W3C contract cases, run by the existing gateway builder. */
#include <stdio.h>
#include <string.h>
#include "gateway_trace.h"

#define TRACE "4bf92f3577b34da6a3ce929d0e0e4736"
#define SPAN "00f067aa0ba902b7"
#define PARENT "00-" TRACE "-" SPAN "-01"

typedef struct {
    const char *name;
    const char *header;
    int accepted;
} trace_case_t;

/* Validate the production parser against accepted W3C and Node boundary cases.
 * Return failure immediately with its named input, without changing any runtime. */
int main(void) {
    const trace_case_t cases[] = {
        {"v00", PARENT, 1},
        {"reserved flags", "00-" TRACE "-" SPAN "-fe", 1},
        {"future prefix", "01-" TRACE "-" SPAN "-09-future", 1},
        {"empty", "", 0},
        {"malformed", "bad", 0},
        {"uppercase", "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01", 0},
        {"space", " " PARENT, 0},
        {"header injection", PARENT "\r\ninjected", 0},
        {"joined duplicates", PARENT "," PARENT, 0},
        {"v00 extra", PARENT "-extra", 0},
        {"short flags", "00-" TRACE "-" SPAN "-0", 0},
        {"forbidden version", "ff-" TRACE "-" SPAN "-01", 0},
        {"zero trace", "00-00000000000000000000000000000000-" SPAN "-01", 0},
        {"zero span", "00-" TRACE "-0000000000000000-01", 0},
        {"nonhex flags", "00-" TRACE "-" SPAN "-gg", 0},
        {"future invalid separator", "01-" TRACE "-" SPAN "-01x", 0}
    };
    size_t i, count = sizeof(cases) / sizeof(cases[0]);
    unsigned char oversized[600];
    for (i = 0; i < count; i++) {
        if (gateway_trace_valid((const unsigned char *) cases[i].header,
                strlen(cases[i].header)) != cases[i].accepted) {
            fprintf(stderr, "Gateway trace contract failed: %s\n", cases[i].name);
            return 1;
        }
    }
    memset(oversized, 'x', sizeof(oversized));
    memcpy(oversized, "01-" TRACE "-" SPAN "-01-", 56);
    if (gateway_trace_valid(NULL, 55)
            || gateway_trace_valid(oversized, sizeof(oversized))) {
        fprintf(stderr, "Gateway trace contract failed: null/oversized input\n");
        return 1;
    }
    printf("Gateway native trace contracts: %zu passed, 0 failed\n", count + 2);
    return 0;
}
