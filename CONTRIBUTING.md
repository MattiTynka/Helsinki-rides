# Contributing to Helsinki-rides

The project is preparing an open-source release at
`MattiTynka/Helsinki-rides`. The repository remains private during preparation.
Public issue tracking, a hosted game and downloadable city assets are separate
release steps; their availability must not be assumed from this document.

## Development

Use Node.js 22.18 or newer and the pnpm version pinned in `package.json`.
From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:source
python -m unittest discover -s tools/release/test
python tools/release/source_release.py audit --images
pnpm build:pages
```

The source repository deliberately excludes downloaded geodata, generated world
releases, source models and local evidence. Compilation and source tests are
distinct from running the full city. `pnpm dev` requires a separately supplied,
compatible world release in `apps/game/public/world/`, including its
`current.json` pointer. See [release preparation](docs/open-source-release.md)
and the [source register](docs/source-register.md). Do not add those large
directories to Git to make a local setup work.

## Changes

Keep changes focused. Describe the behavior before and after, reproduction
steps, and the checks actually run. Changes to physics, input, animation or
rendering need relevant runtime evidence in addition to source checks. State
any missing verification; a screenshot or old benchmark alone does not establish
that a new candidate works.

Preserve the coordinate system, schemas, deterministic simulation, asset hashes,
source ledgers and existing attributions. Keep visual geometry, collision and
road graphs distinct. Do not reintroduce the removed 2017 city mesh. Refer to
[the asset pipeline](docs/asset-pipeline.md) before changing models or authoring
scripts. Generate revisions separately and keep original source assets intact.

## Rights and privacy

Original code and documentation contributions are submitted under the project's
[MIT license](LICENSE). Submit only material you have the right to contribute.
This does not transfer third-party rights or change an existing asset license.
An asset contribution must include its author, source URL, exact license, file
hash and description of changes. Preserve required attribution and upstream
license/notice files. Do not introduce a contributor license agreement by
implication; none is required by this document.

Reference images require their own redistribution permission even when no pixels
enter the game. Link to a reference instead of committing an unlicensed copy.
Google Maps and Street View imagery is visual reference only and must not be
embedded in distributed textures, screenshots or reference archives. A supplied
model or a removed brand badge does not establish a redistribution license.

Keep secrets, environment files, personal filesystem paths, local browser logs,
recordings and account details out of submissions. Use fictional placeholders in
documentation. Report vulnerabilities through [SECURITY.md](SECURITY.md).
