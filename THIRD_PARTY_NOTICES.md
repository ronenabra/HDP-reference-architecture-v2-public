# Third-party software

The sandbox's own code is licensed under [Apache-2.0](LICENSE). Dependencies keep
their own licenses, copyright notices and conditions; see [NOTICE](NOTICE).

Direct application Node dependencies are axios, express, jsonwebtoken,
on-finished (MIT) and ejs (Apache-2.0). Versions and transitive dependencies,
including body-parser, are recorded in each component's lockfile. Development
tools include axe-core (MPL-2.0), through the accessibility test dependencies;
its source is available at https://github.com/dequelabs/axe-core. The root
lockfile also records documentation tooling. These examples do not replace the
complete notices for installed dependencies.

Images also contain Node, NGINX, PostgreSQL, Java, HAPI FHIR and operating-system
packages. Each image distribution must include the matching license companion:
the project LICENSE and NOTICE, full third-party terms and attributions, the
exact runtime inventory, and applicable corresponding sources and build scripts.
The [release inventory](docs/releases/0.2.0.md#published-images) gives the matching companion reference, download instructions and checksum. Supply it with independent image downloads as well as image bundles.
The Apache-2.0 license for sandbox code does not relicense these dependencies.

Use `python3 scripts/package-release-licenses.py --help` to package reviewed,
hash-verified notices and sources. Use `--require-complete` for distribution;
the tool refuses missing source files, changed identities and unresolved review
items. Keep corresponding sources at the same download location as the images.
An upstream source link or an SPDX label alone does not fulfill every binary
redistribution requirement.

Java dependencies include LGPL and Eclipse-licensed libraries; operating-system
packages include GPL, LGPL and MPL software. Preserve their full terms, required
source and replacement rights. The Oracle JDBC driver has separate Oracle Free
Distribution, Hosting, and Use terms: retain those terms, keep the driver
unmodified, and do not charge an additional fee for the driver. See the
[HAPI notices](src/ho-fhir-server/THIRD_PARTY_NOTICES.md).

PCM-IG, HDP and IL Core guides and profiles are independently published. Contract
test downloads remain governed by their upstream terms; their lock records
public URLs and exact hashes. See [external references](docs/external-references.md).
Population datasets have separate licensing and attribution; see
[dataset ownership](docs/datasets.md).
