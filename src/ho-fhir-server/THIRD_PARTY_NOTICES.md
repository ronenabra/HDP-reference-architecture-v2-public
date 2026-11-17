# HAPI runtime notices

The sandbox extension is Apache-2.0 licensed. The runtime uses HAPI FHIR 8.10.0
and HAPI JPA Starter v8.10.0-3, also Apache-2.0 licensed:

- https://github.com/hapifhir/hapi-fhir/tree/v8.10.0
- https://github.com/hapifhir/hapi-fhir-jpaserver-starter/tree/4d12a3fe9e17fd19b7b446cf8c99c2f1632602eb

The full University Health Network attribution is reproduced in the root
[NOTICE](../../NOTICE). HAPI's license and the image's Apache-2.0 label do not
cover every bundled dependency. Distribute the exact image's license/source
companion with each image download; see the root [third-party notices](../../THIRD_PARTY_NOTICES.md).

The runtime inventory comes from the shipped WAR, JRE and operating-system
files. `/app/sbom/pcm-ho-fhir.cdx.json` describes the custom module's build
dependencies; it is not a complete inventory of the runtime or proof that each
listed build dependency is shipped.

Hibernate libraries use LGPL-2.1. Logback and several Jakarta/Eclipse libraries
have Eclipse or LGPL/GPL alternatives. Preserve the selected license terms and
provide the applicable exact source and build instructions in the companion.
The libraries remain separate replaceable JARs inside `/app/main.war`; recipients
may replace them with compatible modified versions and rebuild an image. The
sandbox imposes no additional restriction on reverse engineering needed to debug
modifications to LGPL libraries. OpenJDK retains GPL-2.0 with the Classpath
Exception and its bundled third-party legal notices.

`ojdbc11-23.6.0.24.10.jar` retains its original bytes and bundled Oracle Free
Distribution, Hosting, and Use Terms and Conditions. Those terms permit
unmodified redistribution with the license included, prohibit an additional fee
for the driver and preserve Oracle's other conditions. They apply specifically
to the driver and its separately licensed technology.

## GreenMail change

On 2026-11-17, this distribution removed the unused `greenmail.p12` test
keystore from GreenMail 2.1.0-rc-1. All remaining dependency entries, classes and
notices retain their original uncompressed bytes. GreenMail is Apache-2.0
licensed. The transformation is implemented in
`src/build-tools/SanitizePublicWar.java`; the image is flattened so the removed
resource is absent from lower layers too.

`/app/sbom/pcm-public-sanitization.json` records the pinned upstream image,
original and modified WAR/dependency hashes, and the removed entry's hash.
This receipt identifies the change without changing the Java launch behavior.
