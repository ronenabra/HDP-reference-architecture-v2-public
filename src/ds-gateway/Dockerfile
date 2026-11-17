FROM nginx:1.28.3@sha256:146adea4768b83c607d0bdfa4188464e3da6e0a3ad4475db1d1d8f64f27c29cc AS arrival-build

# Build dependencies stay outside the shipped image. Source checksum and exact
# NGINX configure flags bind the repository module to the pinned runtime ABI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential=12.12 curl=8.14.1-2+deb13u7 libpcre2-dev=10.46-1~deb13u3 libssl-dev=3.5.7-1~deb13u3 zlib1g-dev=1:1.3.dfsg+really1.3.1-1+b1 \
    && rm -rf /var/lib/apt/lists/*
COPY arrival-module /arrival-module
COPY build-arrival-module.sh /tmp/build-arrival-module.sh
RUN sh /tmp/build-arrival-module.sh

FROM nginx:1.28.3@sha256:146adea4768b83c607d0bdfa4188464e3da6e0a3ad4475db1d1d8f64f27c29cc

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf \
    && apt-get update \
    && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*

COPY --from=arrival-build /usr/lib/nginx/modules/ngx_http_gateway_arrival_module.so /usr/lib/nginx/modules/

COPY runtime-reload.sh /usr/local/bin/runtime-reload.sh
RUN chmod +x /usr/local/bin/runtime-reload.sh

# Config will be mounted via docker-compose
# COPY nginx.conf /etc/nginx/nginx.conf 
# (We are using volume mount in dev, but for completeness could copy)
