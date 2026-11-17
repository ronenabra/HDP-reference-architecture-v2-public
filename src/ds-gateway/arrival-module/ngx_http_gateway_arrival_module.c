/* Observe gateway arrivals without changing request handling. Built against the
 * exact gateway NGINX source/ABI; no collector, queue or shared pairing state. */
#include <ngx_config.h>
#include <ngx_core.h>
#include <ngx_http.h>
#include <openssl/rand.h>
#include "gateway_trace.h"

typedef struct {
    ngx_open_file_t *file;
    ngx_str_t organization;
} gateway_conf_t;

typedef struct {
    ngx_http_request_t *request;
    ngx_str_t id;
    ngx_str_t traceparent, trace_id, span_id, parent_span_id, flags;
    ngx_str_t origin;
    unsigned written:1;
} gateway_arrival_t;

static ngx_int_t gateway_init(ngx_conf_t *cf);
static void *gateway_create_conf(ngx_conf_t *cf);
static char *gateway_log(ngx_conf_t *cf, ngx_command_t *cmd, void *conf);
static ngx_int_t gateway_variable(ngx_http_request_t *r,
    ngx_http_variable_value_t *v, uintptr_t data);
static ngx_int_t gateway_variables(ngx_conf_t *cf);
static ngx_int_t gateway_observe(ngx_http_request_t *r);

static ngx_command_t gateway_commands[] = {
    { ngx_string("gateway_arrival_log"), NGX_HTTP_MAIN_CONF|NGX_CONF_TAKE2,
      gateway_log, NGX_HTTP_MAIN_CONF_OFFSET, 0, NULL },
    ngx_null_command
};
static ngx_http_module_t gateway_context = {
    gateway_variables, gateway_init, gateway_create_conf, NULL,
    NULL, NULL, NULL, NULL
};
ngx_module_t ngx_http_gateway_arrival_module = {
    NGX_MODULE_V1, &gateway_context, gateway_commands, NGX_HTTP_MODULE,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NGX_MODULE_V1_PADDING
};

/* A request cleanup anchors identity through internal redirects (which clear
 * module contexts). The small entries die with their owning main request. */
static void gateway_cleanup(void *data) { (void) data; }

static gateway_arrival_t *gateway_find(ngx_http_request_t *r) {
    ngx_pool_cleanup_t *cln;
    gateway_arrival_t *arrival;
    for (cln = r->pool->cleanup; cln; cln = cln->next) {
        if (cln->handler != gateway_cleanup) continue;
        arrival = cln->data;
        if (arrival->request == r) return arrival;
    }
    return NULL;
}

/* Read existing NGINX variables; headers never become trusted source metadata. */
static ngx_str_t gateway_value(ngx_http_request_t *r, char *name) {
    ngx_str_t key;
    ngx_http_variable_value_t *value;
    key.len = ngx_strlen(name); key.data = (u_char *) name;
    value = ngx_http_get_variable(r, &key, ngx_hash_key(key.data, key.len));
    if (!value || value->not_found) return (ngx_str_t) ngx_null_string;
    return (ngx_str_t) { value->len, value->data };
}

/* Escape every string, including control characters and caller-controlled URLs. */
static u_char *gateway_string(u_char *p, const char *key, ngx_str_t value) {
    p = ngx_sprintf(p, "\"%s\":\"", key);
    p = (u_char *) ngx_escape_json(p, value.data, value.len);
    return ngx_cpymem(p, "\",", 2);
}

/* Reject duplicate headers before validation: NGINX variables alone may expose
 * only one occurrence. Internal auth requests inherit their actual public parent. */
static ngx_str_t gateway_remote_parent(ngx_http_request_t *r) {
    ngx_list_part_t *part = &r->headers_in.headers.part;
    ngx_table_elt_t *headers = part->elts;
    ngx_str_t found = ngx_null_string;
    ngx_uint_t i, count = 0;
    for (i = 0; ; i++) {
        if (i >= part->nelts) {
            if (!part->next) break;
            part = part->next; headers = part->elts; i = 0;
        }
        if (headers[i].key.len == 11 &&
            ngx_strncasecmp(headers[i].key.data, (u_char *) "traceparent", 11) == 0) {
            found = headers[i].value; count++;
        }
    }
    if (count != 1 || !gateway_trace_valid(found.data, found.len))
        return (ngx_str_t) ngx_null_string;
    return found;
}

/* Create one server span for the actual public request or internal subrequest.
 * Context remains in the owning pool through redirects; no shared mutable state. */
static void gateway_trace(ngx_http_request_t *r, gateway_arrival_t *arrival) {
    gateway_arrival_t *parent = r->parent ? gateway_find(r->parent) : NULL;
    ngx_str_t incoming = parent ? parent->traceparent : gateway_remote_parent(r);
    u_char random[24], *value;
    size_t i;
    unsigned trace_nonzero, span_nonzero;
    do {
        if (RAND_bytes(random, sizeof(random)) != 1) return;
        trace_nonzero = span_nonzero = 0;
        for (i = 0; i < 16; i++) trace_nonzero |= random[i];
        for (i = 16; i < 24; i++) span_nonzero |= random[i];
    } while (!trace_nonzero || !span_nonzero);
    value = ngx_pnalloc(r->pool, 55);
    if (!value) return;
    ngx_memcpy(value, "00-", 3);
    if (incoming.len) ngx_memcpy(value + 3, incoming.data + 3, 32);
    else ngx_hex_dump(value + 3, random, 16);
    value[35] = '-'; ngx_hex_dump(value + 36, random + 16, 8);
    value[52] = '-'; value[53] = '0';
    value[54] = incoming.len && (gateway_hex(incoming.data[54]) & 1) ? '1' : '0';
    arrival->traceparent = (ngx_str_t) {55, value};
    arrival->trace_id = (ngx_str_t) {32, value + 3};
    arrival->span_id = (ngx_str_t) {16, value + 36};
    arrival->flags = (ngx_str_t) {2, value + 53};
    if (incoming.len) arrival->parent_span_id = (ngx_str_t) {16, incoming.data + 36};
    arrival->origin = parent ? (ngx_str_t) ngx_string("internal")
        : incoming.len ? (ngx_str_t) ngx_string("remote") : (ngx_str_t) ngx_string("root");
}

/* Emit synchronously once before access/auth/upstream. A marker is published only
 * after one complete append succeeds; write errors leave completion fallback. */
static ngx_int_t gateway_observe(ngx_http_request_t *r) {
    gateway_conf_t *conf = ngx_http_get_module_main_conf(r, ngx_http_gateway_arrival_module);
    gateway_arrival_t *arrival, *parent;
    ngx_pool_cleanup_t *cln;
    ngx_str_t values[16], timestamp, parent_id = ngx_null_string;
    const char *keys[] = { "arrivalId", "requestId", "correlationId", "flowId",
        "method", "url", "originalUrl", "timestampEpoch", "healthOrganizationId", "parentArrivalId",
        "traceId", "spanId", "parentSpanId", "traceFlags", "spanKind", "traceContextOrigin" };
    u_char random[16], *line, *p;
    size_t length = 512, i;
    ssize_t written;
    if (!conf->file || gateway_find(r)) return NGX_DECLINED;
    cln = ngx_pool_cleanup_add(r->pool, sizeof(gateway_arrival_t));
    if (!cln) return NGX_DECLINED;
    arrival = cln->data;
    ngx_memzero(arrival, sizeof(*arrival));
    arrival->request = r; cln->handler = gateway_cleanup;
    arrival->id.data = ngx_pnalloc(r->pool, 32);
    if (!arrival->id.data || RAND_bytes(random, sizeof(random)) != 1) return NGX_DECLINED;
    arrival->id.len = 32;
    ngx_hex_dump(arrival->id.data, random, sizeof(random));
    if (r->parent && (parent = gateway_find(r->parent)) && parent->written) parent_id = parent->id;
    gateway_trace(r, arrival);
    values[0] = arrival->id;
    values[1] = gateway_value(r, "request_id");
    values[2] = gateway_value(r, "correlation_id");
    values[3] = gateway_value(r, "flow_id");
    values[4] = r->method_name;
    values[5] = r == r->main ? r->unparsed_uri : r->uri;
    /* Main original URI includes the exact query and leading slashes. Subrequests
     * retain that public request binding while their own URL identifies /auth. */
    values[6] = r->main->unparsed_uri;
    values[7] = gateway_value(r, "msec");
    values[8] = conf->organization;
    values[9] = parent_id;
    values[10] = arrival->trace_id; values[11] = arrival->span_id;
    values[12] = arrival->parent_span_id; values[13] = arrival->flags;
    values[14] = (ngx_str_t) ngx_string("server"); values[15] = arrival->origin;
    for (i = 0; i < 16; i++) length += ngx_strlen(keys[i]) + values[i].len
        + ngx_escape_json(NULL, values[i].data, values[i].len) + 8;
    timestamp = gateway_value(r, "time_iso8601");
    length += timestamp.len + ngx_escape_json(NULL, timestamp.data, timestamp.len);
    line = ngx_pnalloc(r->pool, length);
    if (!line) return NGX_DECLINED;
    p = ngx_cpymem(line, "{", 1);
    p = gateway_string(p, "timestamp", timestamp);
    p = ngx_cpymem(p, "\"level\":\"INFO\",\"message\":\"Gateway Request\",\"details\":{\"type\":\"GATEWAY_REQUEST\",\"arrivalProtocol\":\"nginx-early/1\",\"componentRole\":\"gateway\",\"category\":\"system\",\"visibility\":\"default\",", sizeof("\"level\":\"INFO\",\"message\":\"Gateway Request\",\"details\":{\"type\":\"GATEWAY_REQUEST\",\"arrivalProtocol\":\"nginx-early/1\",\"componentRole\":\"gateway\",\"category\":\"system\",\"visibility\":\"default\",") - 1);
    for (i = 0; i < 16; i++) p = gateway_string(p, keys[i], values[i]);
    p--; p = ngx_cpymem(p, "}}\n", 3);
    written = ngx_write_fd(conf->file->fd, line, p - line);
    if (written == p - line) arrival->written = 1;
    else ngx_log_error(NGX_LOG_ERR, r->connection->log, ngx_errno,
        "gateway arrival append failed (%z of %uz bytes)", written, p - line);
    return NGX_DECLINED;
}

/* Noncacheable getter is essential: auth subrequests share NGINX variables with
 * their parent, but completion must always identify its own observation. */
static ngx_int_t gateway_variable(ngx_http_request_t *r,
    ngx_http_variable_value_t *v, uintptr_t data) {
    gateway_arrival_t *arrival = gateway_find(r);
    ngx_str_t value = ngx_null_string;
    if (arrival) {
        switch (data) {
        case 0: if (arrival->written) value = arrival->id; break;
        case 1: value = arrival->traceparent; break;
        case 2: value = arrival->trace_id; break;
        case 3: value = arrival->span_id; break;
        case 4: value = arrival->parent_span_id; break;
        case 5: value = arrival->flags; break;
        case 6: value = arrival->origin; break;
        }
    }
    v->valid = 1; v->no_cacheable = 1; v->not_found = 0;
    v->len = value.len;
    v->data = value.len ? value.data : (u_char *) "";
    return NGX_OK;
}

static ngx_int_t gateway_variables(ngx_conf_t *cf) {
    ngx_str_t names[] = { ngx_string("gateway_arrival_id"), ngx_string("gateway_traceparent"),
        ngx_string("gateway_trace_id"), ngx_string("gateway_span_id"), ngx_string("gateway_parent_span_id"),
        ngx_string("gateway_trace_flags"), ngx_string("gateway_trace_origin") };
    ngx_http_variable_t *var;
    ngx_uint_t i;
    for (i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        var = ngx_http_add_variable(cf, &names[i], NGX_HTTP_VAR_NOCACHEABLE);
        if (!var) return NGX_ERROR;
        var->get_handler = gateway_variable; var->data = i;
    }
    return NGX_OK;
}

static void *gateway_create_conf(ngx_conf_t *cf) {
    return ngx_pcalloc(cf->pool, sizeof(gateway_conf_t));
}

static char *gateway_log(ngx_conf_t *cf, ngx_command_t *cmd, void *configuration) {
    gateway_conf_t *conf = configuration;
    ngx_str_t *args = cf->args->elts;
    (void) cmd;
    if (conf->file) return "is duplicate";
    conf->file = ngx_conf_open_file(cf->cycle, &args[1]);
    if (!conf->file) return NGX_CONF_ERROR;
    conf->organization = args[2];
    return NGX_CONF_OK;
}

/* Main post-read precedes rewrite/authorization. Subrequests start at server
 * rewrite, so that phase supplies the corresponding early internal observation. */
static ngx_int_t gateway_init(ngx_conf_t *cf) {
    ngx_http_core_main_conf_t *core = ngx_http_conf_get_module_main_conf(cf, ngx_http_core_module);
    ngx_http_handler_pt *handler;
    handler = ngx_array_push(&core->phases[NGX_HTTP_POST_READ_PHASE].handlers);
    if (!handler) return NGX_ERROR;
    *handler = gateway_observe;
    handler = ngx_array_push(&core->phases[NGX_HTTP_SERVER_REWRITE_PHASE].handlers);
    if (!handler) return NGX_ERROR;
    *handler = gateway_observe;
    return NGX_OK;
}
