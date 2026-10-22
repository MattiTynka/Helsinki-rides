# Helsinki-rides source release preparation

Target repository: **MattiTynka/Helsinki-rides**. Initial visibility was private.
The owner subsequently authorized making the repository public and publishing
the game on Pages. The [public beta record](public-game-release.md) supersedes
the earlier preparation-only restrictions below. Source Git continues to exclude
the generated world; a separately audited release packet supplies the public
game. Unresolved supplied-asset terms remain explicitly identified until the
owner provides the remaining copyright information.

## What the repository contains

The source release contains the original TypeScript application, simulation and
schema packages, authoring/verification scripts, configuration, applicable tests,
build lockfile, documentation and the explicitly licensed small artwork inputs
listed below. Original project code and documentation are MIT-licensed, copyright
2026 MattiTynkä. Third-party code and content retain their own
licenses. An existing explicit CC0 artwork dedication is preserved.

MIT remains the code license because this project permits reuse of its original
software. The proportion of CC BY assets does not require changing the code
license: [Creative Commons recommends software licenses for code](https://creativecommons.org/faq/#can-i-apply-a-creative-commons-license-to-software)
and confirms that [including CC material in a collection preserves its own license](https://creativecommons.org/faq/#if-i-create-a-collection-that-includes-a-work-offered-under-a-cc-license-which-licenses-may-i-choose-for-the-collection).
For each CC BY 4.0 asset, retain the supplied creator/copyright and other required
notices, its source and license links, and the record of modifications, as
[the license requires](https://creativecommons.org/licenses/by/4.0/legalcode.en#s3).
Keep these records with distributed originals and optimized derivatives. ODbL,
CC0 and other identified terms remain separate; MIT does not clear an asset whose
redistribution rights are unresolved.

The source export excludes raw downloads, work directories, world releases,
Blender/source models, dependencies, generated builds, local evidence, accounts,
agent state, environment secrets and logs. A clean source checkout is not a
self-contained copy of the current 1.68 GB world release. It can install, compile
and run source tests; playing the complete city additionally requires a compatible
world packet and `apps/game/public/world/current.json`. The historical build
recipes also reference excluded inputs. They document provenance rather than
promise a one-command rebuild from the source checkout alone.

See [third-party notices](../THIRD_PARTY_NOTICES.md), the
[source register](source-register.md), and the
[deployment plan](github-pages-release-plan.md).

## Audited artwork in content/

The 2026-10-19 audit found nine raster images and three matching original SVGs in
`content/`. No GLB, Blender scene or other model binary was found there.

| Files | Rights and source-export treatment |
| --- | --- |
| `content/assets/facades/estates/front-2021.jpg` | Josefiina Alanen, “House of the Estates Facade 2021-06-08,” CC BY 4.0. Keep with `credits.json` and source metadata. The export removes non-rendering metadata while preserving encoded pixels and author/license credits; derived facade samples are cropped, reprojected and reconstructed. |
| `content/assets/facades/estates/park-2022.jpg` | Josefiina Alanen, “House of the Estates Park 2022-07-20,” CC BY 4.0. Same treatment. |
| `content/assets/facades/esplanadi/catani-valtonen.jpg` | Marja Valtonen / Helsinki City Museum, CC BY 4.0. Keep with `source-ledger.json`. Original JPEG remains unchanged; production adaptation rectifies and repeats corresponding clean bays and removes photographed foreground objects. |
| `content/helsinki/district-expansion/facade-charts/canalside-v1/canalside-original.{png,svg}` | Original project procedural artwork, explicitly CC0-1.0. Keep with profile and ledger. |
| `content/helsinki/district-expansion/facade-charts/canalside-v2/canalside-original.{png,svg}` | Original project procedural artwork, explicitly CC0-1.0. Keep with profile and ledger. |
| `content/helsinki/district-expansion/facade-charts/canalside-v3/canalside-original.{png,svg}` | Original project procedural artwork, explicitly CC0-1.0. Keep with profile and ledger. |
| `content/assets/facades/estates/DSC05064.jpg`, `DSC05070.jpg`, `DSC05072.jpg` | Daderot, CC0 according to retained Commons metadata. Research-only, not production inputs. Exclude these three from the source artifact to keep unused reference copies out; this is a packaging choice, not a claim of unknown rights. |

The CC BY photograph hashes and source/license links are in
`content/assets/facades/estates/credits.json` and
`content/assets/facades/esplanadi/source-ledger.json`. Preserve those records with
the files. Commons metadata records titles, authors and licenses for the excluded
Daderot photographs. Textual metadata and links may remain.

No unknown-rights raster image was found in `content/`. References to operator
photographs, Google panoramas, architectural drawings and other research media
are not redistribution grants. Their actual downloads and diagnostic composites
are under the excluded `data/` tree. Do not copy them into the source package.

## Exact source-artifact exclusions

These paths are excluded from the proposed upload artifact, without deleting or
altering the development originals:

```text
.git/                         # never copy existing repository history into the export
.agents/
.claude/
.codex/
.aws/
.env                          # all actual environment values
.env.*                        # a reviewed .env.example may be included separately
node_modules/                 # at any depth
data/
models/
build/
dist/                         # at any depth
dist-pages/                   # at any depth
apps/game/public/world/
__pycache__/                  # at any depth
*.pyc
*.rgba.deflate
*.blend1
*.log
debug.log
content/assets/facades/estates/DSC05064.jpg
content/assets/facades/estates/DSC05070.jpg
content/assets/facades/estates/DSC05072.jpg
```

Use a positive allowlist as well as these exclusions. Review every new file before
adding it to the export. Do not assume a Git ignore rule alone proves an artifact
or existing Git history is clean. Scan the final artifact's files and the exact
initial Git commit for credentials, personal paths, binary/size surprises and
forbidden input copies. Report findings without printing secret values.

The two vendored Basis decoder files in `apps/game/public/basis/` are required
small runtime dependencies and may remain. Their exact hashes and Apache-2.0
license/notice are preserved in `THIRD_PARTY_NOTICES.md`.

## Content clearance before a public playable release

The source-only export avoids distributing unresolved model rights. The full
world packet has additional release conditions:

1. **Owner-supplied car and Cathedral:** the source register describes these as
   the owner's assets, but does not provide an upstream redistribution license
   or explicit original-authorship grant. Record the actual author, origin and
   redistribution terms, or replace them with cleared assets. Removed badges do
   not resolve copyright or trademark provenance.
2. **Alexander II monument:** the exporter explicitly records “original licensing
   not supplied.” Obtain the source model/texture rights or replace the model.
   Public-domain status of a physical historical monument does not establish
   rights to somebody else's digital model or photographs.
3. **Supplied Finn/Rain adaptations and motion:** the Blender Studio base models
   are recorded as CC BY 4.0. Retain attribution and adaptation notices, and
   confirm rights for the owner's added textures, uniform and exported movement.
   Finn's ledger identifies Kimodo-SOMA-RP-v1.2, Apache-2.0 code and a separate
   NVIDIA Open Model License checkpoint, but has no checkpoint revision/hash.
   Reproducibility and applicable output/model terms require separate evidence;
   do not label the supplied clips Apache-2.0 merely because the generator code
   is. No model checkpoint or Kimodo implementation is part of this source export.
4. **OpenStreetMap:** preserve ODbL attribution and keep OSM-derived database
   content distinct from the MIT code. Any public derivative database/produced
   work release must fulfill applicable notice, share-alike and machine-readable
   source/alteration availability requirements. Publish an identified exact road
   database and provenance alongside the game, or document the qualifying source
   and complete alteration method; an old URL alone is not that evidence.
5. **City/photo material:** retain authors, license links, source identities and
   changes in the delivered manifest, credits and asset notices. Reference-only
   third-party images remain excluded. The removed 2017 mesh is not an input.

Current City of Helsinki and OSM source descriptions are in
`content/helsinki/city-north-20261019/sources.json`; their raw ledgers remain local.
The [CC BY 4.0 terms](https://creativecommons.org/licenses/by/4.0/) require credit,
a license link and identification of changes. The
[ODbL legal text](https://opendatacommons.org/licenses/odbl/1-0/) sets the database
and produced-work conditions. This file records concrete unresolved evidence,
not a grant on behalf of any third-party owner.

## Release checks and handoff

1. Freeze the source artifact's file list, sizes and SHA-256 hashes. Verify that
   every included file matches the reviewed source, except explicitly recorded
   privacy substitutions in export-only text. Preserve the original workspace.
2. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test:source` and
   `pnpm build:pages` in the sanitized checkout. Identify any fixture that still depends
   on excluded local data. Do not report a missing-data skip as a passing game
   verification. Keep desktop/browser claims tied to their exact world/runtime.
3. Inspect artifact contents and commit candidates for secrets, personal paths,
   oversized files, unknown-rights material and accidental dependency/build copies.
   Confirm MIT, all retained asset credits and the Basis notice/license are included.
4. Verify `gh api user` identifies `MattiTynka` before preparing the target remote.
   Verify the exact repository name `Helsinki-rides`, visibility **private**, and
   Pages disabled. Notify the owner when the upload artifact is ready.
5. After an authorized source upload, recheck repository visibility and tree.
   Keep deployment workflows inactive until a separate website release is approved.
   A future visibility change is a separate action.

A private source repository does not guarantee a private Pages site or asset
bucket. GitHub's [Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
describes the hosting/access options. The future site and external asset host
need their own access review; browser-delivered content is downloadable. Do not
enable either as an incidental consequence of creating this private repository.

## Repeatable source export

From the authoring workspace, run `pnpm release:source` to create a new
`build/source-release` directory. Existing exports are never overwritten.
The exporter uses a positive file allowlist, rejects personal paths and email
addresses, strips image metadata losslessly, and updates the two affected
Estates hash pins only in the exported checkout. The original photographs remain
unchanged. Use `--out build/source-release-N` for another export.

Public GeoJSON is scanned as text. The two explicitly selected compressed road
registration datasets are decoded before scanning, with a 64 MiB bound, strict
JSON/UTF-8 validation and exactly one complete gzip member without filename,
comment, extra-header or trailing data. Original facade PNGs are individually
allowlisted and receive the same image metadata checks as the older assets.
Before committing, compare Git's complete prospective file list with this
allowlist; a file omitted from the audit must not be silently added to Git.

Run `python tools/release/source_release.py audit --images` inside the export.
After its initial commit, add `--git` to check every reachable commit's files and
metadata. The expected initial identity is the owner-selected public GitHub
handle with its GitHub no-reply address. Never inherit a workstation's real
email or account name. Run Gitleaks 8.30.1 with `.gitleaks.toml` against both the
source directory and all Git history, with `--redact=100`. The configuration
extends all default rules and narrowly documents six verified geometry/street
label false positives. It does not ignore entire files or history.

The source CI runs checks only, with read-only permissions and no deployment or
artifact upload. It checks committed history for credentials, source privacy,
portable tests, typechecking and the Pages shell build. Three complete asset
suites and one municipal-master test are deliberately omitted from
`test:source`; the runner prints their exact names and reasons. The full `test`
command still requires local source assets and historical evidence.

The source export is the upload candidate. Do not initialize a remote from the
large authoring workspace or stage its original images, local logs or agent state.
