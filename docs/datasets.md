# Synthetic datasets and sandbox import

Synthetic population datasets and the native generator are published separately
in [HDP-synthetic-dataset](https://github.com/ronenabra/HDP-synthetic-dataset). No population dataset release is bundled
with this application. Ordinary bootstrap leaves managed clinical databases empty;
small CI/DEMO/workflow bundles here remain regression inputs only.

## Reviewed release

Use **4.2.2-2026-10-10**, FHIR **4.0.1**, at dataset repository commit
`459ac3e28e8507df2eba82289a7e2deed9c073fd`. The
[release index](https://github.com/ronenabra/HDP-synthetic-dataset/blob/459ac3e28e8507df2eba82289a7e2deed9c073fd/releases/synthetic-population/4.2.2-2026-10-10/release-index.json)
records archive and bundle checksums, counts and validation limits. These files
live in the repository's release directory; the links do not assume a GitHub
Release or tag exists.

| Archive | Distinct people | FHIR resources | Compressed bytes | Expanded file bytes |
| --- | ---: | ---: | ---: | ---: |
| `hdp-synthetic-1k.tar.zst` | 1,000 | 19,179 | 1,667,795 | 88,081,518 |
| `hdp-synthetic-10k.tar.zst` | 10,000 | 190,525 | 17,554,269 | 872,678,732 |

Patient-resource counts can exceed population size because source records and
intentional duplicates are included. Start with 1k for a smaller import. Expanded
file sizes do not estimate database, memory or full-stack disk requirements.

## Download and verify 1k

Run from the sandbox repository root, with `curl`, GNU `tar`, `zstd` and
`sha256sum` installed. No dataset generator installation is needed. Each step
below runs only if the preceding step succeeds.

```sh
(
  set -eu
  dataset_dir=tmp/external-datasets/4.2.2-2026-10-10
  mkdir -p "$dataset_dir"
  curl --fail --location --output "$dataset_dir/hdp-synthetic-1k.tar.zst" \
    https://raw.githubusercontent.com/ronenabra/HDP-synthetic-dataset/459ac3e28e8507df2eba82289a7e2deed9c073fd/releases/synthetic-population/4.2.2-2026-10-10/hdp-synthetic-1k.tar.zst
  (
    cd "$dataset_dir"
    printf '%s  %s\n' \
      487fcfde1ba425c097f21ad4dad27396a3c7038d63a564fa41d273295c44d1cb \
      hdp-synthetic-1k.tar.zst | sha256sum -c -
    tar --zstd -xf hdp-synthetic-1k.tar.zst
    cd 1k
    sha256sum -c checksums.sha256
  )
)
```

For 10k, use the same pinned directory's `hdp-synthetic-10k.tar.zst`, expected
SHA-256 `d5d35ec7a6698f2ee17c85809a9042b8345a9f362ac71f146411d8de52bc985a`,
and extracted `10k/` directory. Keep downloads and expanded data outside version
control. Review [upstream notices](https://github.com/ronenabra/HDP-synthetic-dataset/blob/459ac3e28e8507df2eba82289a7e2deed9c073fd/THIRD_PARTY_NOTICES.md)
and [NOTICE](https://github.com/ronenabra/HDP-synthetic-dataset/blob/459ac3e28e8507df2eba82289a7e2deed9c073fd/NOTICE) before redistribution: Apache-2.0 covers
project-owned work; embedded terminology retains its own terms. When sharing
archives separately, also provide the upstream LICENSE, NOTICE, third-party
notices and LOINC attribution alongside them.

## Explicit source mapping and import

Each population contains three nonempty transaction Bundles under `bundles/`.
The following mapping assigns the HMO to HO A; filenames never choose a target
implicitly. Source tags must match the contents of their files.

| Sandbox target | Bundle filename | Expected source tag | 1k resources |
| --- | --- | --- | ---: |
| HO A | `hmo.source.transaction.json` | `hmo` | 11,815 |
| HO B | `hospital-a.source.transaction.json` | `hospital-a` | 4,024 |
| HO C | `hospital-b.source.transaction.json` | `hospital-b` | 3,340 |

From the sandbox repository root, after successful verification:

```sh
node pcm-connectathon/scripts/bootstrap-local-team.js \
  --team-id dataset-demo --teams-root tmp/connectathon-teams \
  --preset connectathon-balanced \
  --bundle-root "$PWD/tmp/external-datasets/4.2.2-2026-10-10/1k/bundles" \
  --ho-a-bundle hmo.source.transaction.json --ho-a-source hmo \
  --ho-b-bundle hospital-a.source.transaction.json --ho-b-source hospital-a \
  --ho-c-bundle hospital-b.source.transaction.json --ho-c-source hospital-b \
  --require-clinical
```

This command creates and starts a team, imports the selected data and runs startup
sanity checks. It is an explicit mutation, not an offline preview. Admin Sources &
data also supports explicit uploads after empty startup. Follow the
[import contract and recovery guidance](../clinical-data/README.md); imports use
private maintenance credentials, never Doctor tokens. For uncertain imports,
inspect the operation ledger and reconcile before retrying. A timeout does not
prove that nothing changed.

## Compatibility and validation limits

On 17 November 2026, an anonymous download of the pinned **1k** archive matched
its published SHA-256. All three extracted bundles matched their published hashes
and passed this sandbox's offline transaction inspector, including source/tag,
resource/request shape and local-reference checks. No live import or Doctor
workflow was run for this review. The 10k archive was reviewed through its index,
not downloaded or qualified here. Its listed per-source sizes/counts fit the
current default admission limits (768 MiB and 200,000 entries per bundle); that
alone does not establish server capacity or successful loading.

The 1k resources retain embedded dataset tag **`4.2.1-s14-1000-normal`** despite
the external release label **4.2.2-2026-10-10**. Preserve the original bytes and
record both values in run reports; do not retag resources to match the release
label. Runtime dataset comparisons use the embedded tag.

All Patient records in the inspected 1k bundles have an identifier accepted by
the non-Strict connectathon identity rules. Most use
`http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id`; Strict excludes
that GUID namespace. Each source also contains the two standard synthetic test
identities (`il-hdp-test-id`, values `1` and `2`). The offline import inspector's
patient summary uses the default identifier rules and includes only those two
per source. This summary is not the population count or a live Doctor selection
result. Successful import does not configure HMO eligibility, OTP or dependent
discovery by itself; those workflows need their separate sandbox configuration.

The [upstream release notes](https://github.com/ronenabra/HDP-synthetic-dataset/blob/459ac3e28e8507df2eba82289a7e2deed9c073fd/releases/synthetic-population/4.2.2-2026-10-10/README.md)
retain intentional data-quality problems, forty reviewed culture-profile errors
and incomplete terminology/clinical validation. Original 10k validation sampled
twelve graphs; standalone 10k reproduction has not been run. The upstream
[known generic-generator test failure](https://github.com/ronenabra/HDP-synthetic-dataset/blob/459ac3e28e8507df2eba82289a7e2deed9c073fd/KNOWN_ISSUES.md)
is distinct from the accepted-release reproduction path. These are synthetic
software-testing fixtures, not clinical guidance or representative population
statistics. Full sandbox regression results will be published separately; this
offline review does not replace them.
