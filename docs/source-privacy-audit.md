# Source privacy and publication audit — 19 October 2026

Scope: the curated source export for **MattiTynka/Helsinki-rides**, its initial
Git commit and Pages application shell. The repository was kept private through
the audit, then made public at the owner's explicit request. See the
[public beta record](public-game-release.md) for the subsequent Pages publication.
The large authoring workspace is not the upload artifact.

## Findings and corrections

| ID | Finding | Correction |
| --- | --- | --- |
| PRIV-01 | Thirteen operator home-path occurrences across character contracts, a regression test, historical decisions and one saved error trace. | Removed local account/root prefixes. Contracts retain source-relative locations; the Finn test accepts `FINN_SOURCE` or a project-relative raw input. Error-trace geometry is unchanged; its test hash was updated. |
| PRIV-02 | The original implementation plan named the project owner personally. | Replaced the name with the project-owner role. The explicitly selected public GitHub handle remains. |
| PRIV-03 | Two retained Estates photographs contained EXIF/XMP camera-owner, device-serial and GPS metadata. | Stripped that metadata only from export copies, without recompressing the images. Both encoded raster bytes and independently decoded pixels match the originals. Required photographer/license credits remain. The export updates affected input hashes and retains original source hashes as provenance. |
| PRIV-04 | Agent state, logs, environment files, raw downloads and large generated assets were unsuitable for a source upload. | A positive upload allowlist and ignore rules exclude them. The exporter never reads `.env` values, follows links, copies Git history or overwrites an existing export. |

Text checks cover personal home paths, email addresses, recognizable credentials,
credential assignments and credential-bearing URLs. An additional local search
checked the operator's account and full name without recording those values in
this report. Intentional example-domain URL tests are not personal contacts.
Public creator attributions are retained because their asset licenses require
credit; they are not operator-identifying private information.

## Independent secret scan

Gitleaks 8.30.1 was downloaded from its official release and checked against its
published SHA-256. The initial default-rule scan found six `generic-api-key`
matches, all traced to non-credential data:

- Two copies of the exact float-coordinate triangle identifier checked by
  `frontierTriangleKey` in the foundation-skirt reconstruction.
- Four municipal Mannerheimintie street/surface labels.

`.gitleaks.toml` retains every default rule and scopes each exception to both an
exact file path and an exact, complete non-secret field line. No file, directory,
commit or credential rule is broadly ignored. Repeat scans must use this config;
new findings require review. Scan output is redacted and kept outside Git.

## Verification and history boundary

At the start of this audit the authoring Git repository had no commits/remotes,
and authenticated checks found no Helsinki repository under the selected GitHub
owner. There was no existing public game history to rewrite. This does not claim
to audit unrelated repositories or accounts.

The sanitized source checkout installed with the frozen lockfile, passed
TypeScript checking, passed **575 portable tests**, and built the Pages shell.
The release-tool tests passed **12 tests**; one symlink-creation test was skipped
because the Windows host disallows symlinks. It remains enabled on CI.
Three asset-dependent suites and one municipal-master regression are explicitly
omitted from the source gate; the runner prints their names and reasons. These
are not claimed as passing asset/gameplay checks.

The final source audit writes an inventory of every uploaded path, byte size and
SHA-256 under ignored `build/release-audit/`. Audit the exact initial commit and
all reachable history before upload. Use the owner-selected public handle and
GitHub no-reply identity for author and committer, never the workstation's real
name/email. After upload, compare the remote commit and tree with that inventory,
confirm private visibility and Pages disabled, and inspect CI results.

## Repeating the checks

```sh
python tools/release/source_release.py audit --images
python tools/release/source_release.py audit --images --git
gitleaks dir . --config .gitleaks.toml --redact=100 --no-banner
gitleaks git . --config .gitleaks.toml --log-opts="--all" --redact=100 --no-banner
```

Run the directory scan before installing dependencies or generating builds, so
its scope matches the curated upload. Scan the Pages build separately when
preparing a website release. The source CI checks all committed history with
Gitleaks and repeats the source privacy, image metadata, build and portable-test
gates. It has no deployment or artifact-upload step.

## Open-source boundary

The curated original code/documentation is prepared under MIT with retained
third-party notices. The full playable world remains a separate release:
redistribution provenance is still needed for the supplied car, Cathedral and
Alexander assets and the character adaptations/motion. Those model binaries,
raw datasets and world releases are excluded from this source export. See
[source release preparation](open-source-release.md) for the exact outstanding
rights and hosting evidence.

No pattern-based scan proves the absence of every possible secret. This audit
supports the exact reviewed source inventory and Git history, not arbitrary
future files, local work directories or a later world-asset upload.
