# syntax=docker/dockerfile:1.7
FROM hapiproject/hapi:v8.10.0-3@sha256:55213612779ab3eeec919226b7bad378f0061ade823393a61d7dd46dd5087a3d AS upstream

FROM maven:3.9.16-eclipse-temurin-21-alpine@sha256:d5134611660b880f0e2244c7ffd3d29c2776f547b06775265c3999fa41bf4e4a AS build
WORKDIR /workspace
COPY pom.xml ./
RUN mvn --batch-mode --no-transfer-progress dependency:go-offline
COPY src ./src
RUN mvn --batch-mode --no-transfer-progress package -DskipTests
COPY --from=upstream /app/main.war /workspace/upstream.war
# The upstream launcher does not expose arbitrary loader-path content to
# Spring's auto-configuration discovery reliably. Overlay only this module's
# compiled classes/resources into WEB-INF/classes of the pinned starter WAR.
RUN mkdir -p overlay/WEB-INF/classes \
    && cp -R target/classes/. overlay/WEB-INF/classes/ \
    && cp upstream.war main.war \
    && jar uf main.war -C overlay .

# Prepare the complete original runtime off-image. Copying an upstream final
# layer and deleting its key later would still publish that key in lower layers.
COPY --from=upstream / /runtime-root/
RUN java src/build-tools/SanitizePublicWar.java upstream.war main.war sanitized.war sanitization.json \
    && cp sanitized.war /runtime-root/app/main.war \
    && mkdir -p /runtime-root/app/sbom /runtime-root/app/config \
    && cp target/bom.json /runtime-root/app/sbom/pcm-ho-fhir.cdx.json \
    && cp sanitization.json /runtime-root/app/sbom/pcm-public-sanitization.json \
    && cp src/main/resources/application.yaml /runtime-root/app/config/application.yaml

FROM scratch
COPY --from=build /runtime-root/ /
# This is the complete metadata contract of the pinned upstream runtime. Keep
# Java, user, environment, labels and launch behavior identical when flattening.
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    LANG=C.UTF-8 \
    JAVA_VERSION=21.0.11
LABEL org.opencontainers.image.created="2026-07-15T18:07:12.779Z" \
    org.opencontainers.image.description="" \
    org.opencontainers.image.licenses="Apache-2.0" \
    org.opencontainers.image.revision="4d12a3fe9e17fd19b7b446cf8c99c2f1632602eb" \
    org.opencontainers.image.source="https://github.com/hapifhir/hapi-fhir-jpaserver-starter" \
    org.opencontainers.image.title="hapi-fhir-jpaserver-starter" \
    org.opencontainers.image.url="https://github.com/hapifhir/hapi-fhir-jpaserver-starter" \
    org.opencontainers.image.version="v8.10.0-3"
USER 65532:65532
WORKDIR /app
ENTRYPOINT ["java", "--class-path", "/app/main.war", "-Dloader.path=main.war!/WEB-INF/classes/,main.war!/WEB-INF/,/app/extra-classes", "org.springframework.boot.loader.PropertiesLauncher"]
