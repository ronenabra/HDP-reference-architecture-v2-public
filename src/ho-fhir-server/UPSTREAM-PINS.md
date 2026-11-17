# Immutable upstream pins

- HAPI FHIR core: `8.10.0`, tag commit
  `96ac50f89455eb4cbef57fa858854e58b6dac4a5`
- HAPI JPA Starter: `image/v8.10.0-3`, commit
  `4d12a3fe9e17fd19b7b446cf8c99c2f1632602eb`
- Starter runtime image:
  `hapiproject/hapi@sha256:55213612779ab3eeec919226b7bad378f0061ade823393a61d7dd46dd5087a3d`
- Maven builder image (linux/amd64 manifest):
  `maven@sha256:d5134611660b880f0e2244c7ffd3d29c2776f547b06775265c3999fa41bf4e4a`
- Maven wrapper: `3.9.16`, archive SHA-512
  `831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6`
- CycloneDX Maven plugin: `2.9.1`; `makeBom` is bound to `package`, excludes
  test scope, writes `target/bom.json`, and is copied unchanged into the image
  as `/app/sbom/pcm-ho-fhir.cdx.json`.
- PostgreSQL test image:
  `postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`
- Java target: 17; pinned builder/runtime Java: Temurin 21.
- Upstream license: Apache License 2.0. See `THIRD_PARTY_NOTICES.md`.
