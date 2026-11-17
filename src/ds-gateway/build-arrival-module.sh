#!/bin/sh
# Build only the dynamic module against the immutable gateway's exact ABI.
set -eu
cd /tmp
# Exercise the actual dependency-free validator before configuring NGINX. The
# runtime image copies only the module; its ordinary Node tests need no compiler.
cc -std=c99 -Wall -Wextra -Werror -I/arrival-module \
    /arrival-module/gateway_trace_test.c -o /tmp/gateway_trace_test
/tmp/gateway_trace_test
curl -fsSL https://nginx.org/download/nginx-1.28.3.tar.gz -o nginx.tar.gz
printf '%s\n' '2c96a946bfb0882a21744ed429770a2123ae1828c7c48665092993ddee91a918  nginx.tar.gz' | sha256sum -c -
tar -xzf nginx.tar.gz
cd nginx-1.28.3
# These options come only from the pinned, trusted nginx binary, not configuration.
build_options="$(nginx -V 2>&1 | sed -n 's/^configure arguments: //p')"
eval "./configure $build_options --add-dynamic-module=/arrival-module"
make -j2 modules
install -m 755 objs/ngx_http_gateway_arrival_module.so /usr/lib/nginx/modules/
