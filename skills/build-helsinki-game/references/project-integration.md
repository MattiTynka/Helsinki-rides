# GPT-6 Astra in the existing Helsinki repository

This is a discovery map, checked against the repository on 2026-10-17. Re-read the relevant current files before acting; it does not certify their claims or freeze a release ID. The intended calling session uses `gpt-6-astra`, selected by the user or host. `SKILL.md` and `agents/openai.yaml` describe the workflow and invocation, not a model-selection mechanism. Preserve the active model, caller's reasoning setting and authorized routing; do not change configuration to apply this skill.

## Establish the current task

Read the root instructions, `README.md`, `package.json`, the relevant sections of `docs/Helsinki_Browser_Game_Implementation_Plan_v3.md`, and applicable files in `docs/decisions/`. For resumed work, locate the latest relevant `docs/handoff-*.md` and backlog. A handoff records unfinished work and historical evidence; it does not authorize every suggested follow-up. Inspect the actual working tree and asset files before accepting its status.

The project already has an M0/M1/M2 plan and an implemented game. Do not restart a G0 feasibility sprint, add a delivery mission, replace the art pipeline, or expand the map merely because the skill's starter workflow mentions them. When the user asks to fix a defect, trace it through the existing pipeline and repair the responsible layer.

| Concern | Repository sources to inspect |
| --- | --- |
| Browser, render, input and test hooks | `apps/game/src/`, `apps/game/vite.config.ts` |
| Simulation and interaction state | `packages/sim/`, its tests |
| Coordinates, payloads and release types | `packages/world-schema/`, `content/helsinki/world-origin.json` |
| Geographic inputs, cells and source rights | `tools/world/`, `content/helsinki/`, `docs/source-register.md` |
| Hero/landmark assets, axes, sockets and census | `tools/blender/`, `content/assets/`, `docs/asset-pipeline.md` |
| Web optimization and delivery | `docs/model-optimization-2026-10-20.md`, `docs/decisions/0022-web-delivery-collision-streaming-and-texture-tier.md`, current `tools/world/` delivery producers; see [Web optimization](web-optimization.md) |
| Current content identity | `apps/game/public/world/current.json`, then the referenced release and its hashes |
| Runtime evidence and remaining work | `tools/verify/`, `docs/benchmarks/`, relevant handoff/backlog |

Keep the accepted LoD2 building conversion, city terrain and authored landmark decisions. Blender is used for designated hero/landmark/scenery assets, not an obligatory stage for every city building. Preserve the source ledger and the distinction between licensed build inputs and visual-only references. Resolve the recorded origin; the synthetic origin in this skill is never a substitute.

## Use the native interfaces

- The game's inspection adapter is `window.__HELSINKI_GAME__`, defined in `apps/game/src/testapi.ts` and used by `tools/verify/`. The bundled `capture-review.mjs` expects a different `__GAME_TEST__` v2 interface. Use native harnesses first; do not add a second adapter just to run the bundled helper. Verify production exclusion in actual code/builds when making a release claim.
- The native world release schema and publisher live in `packages/world-schema/` and `tools/world/`. `assets/world-manifest.template.json` and `validate_world.py` describe a separate starter format. A rejection by that helper is not proof that the native release is defective; inspect and validate with the native format's checks.
- Asset contracts already live under `content/assets/`, including census specs. Preserve their names, axes, sockets, clips and budgets. Extend an existing contract only when the requested change needs it; do not replace it with a blank template.
- Resolve the exact release used by a benchmark or journey. The active release pointer, a newer intermediate export and an older passing recording can refer to different content. Include source identity too: a release ID alone does not identify changed simulation or renderer code. If Git has no commit or the tree is dirty, record the relevant file hashes/inventory instead of claiming a clean committed candidate.
- Use this installed skill's helpers under `.agents/skills/build-helsinki-game`. Historical project examples may name another local skill copy; that copy is not automatically synchronized or the source for the current invocation. Compare helper behavior if changing a caller; do not rewrite project callers or the other copy as an incidental skill update.

## Execute within the established boundaries

Resolve paths before running examples. Commands in archived notes may use Bash `\` or CMD `^` continuations; on PowerShell use single-line commands or argument arrays and quote paths with spaces. Inspect flags in the actual script before starting a costly job. Keep Blender jobs serial and size their limits from available RAM/disk and the current task, not a historic success.

The project asset guide records host authorization for its own reviewed scripts and source files. Apply that authorization only to its stated scope and when the active host instructions permit it. The runner's `--trusted-host` flag does not create authorization or provide isolation. Untrusted assets and generated scripts outside that authorization retain the container requirements in [Blender workflow](blender-workflow.md). Continue preparation and offline checks when an execution capability is missing.

`tools/world/publish_release.ts` can remove older local releases unless `--keep` is supplied. Preserve existing releases for ordinary local integration; pruning needs explicit scope and a verified target. Distinguish building local content, changing the local active pointer, and publishing externally. Follow authorization for the actual requested action, without adding a new confirmation when it is already authorized.

## Pick the applicable verification

From the repository root, established check entry points include:

```powershell
pnpm typecheck
pnpm test
python -m unittest discover -s tools/world/tests -t tools/world
```

These are available checks, not a requirement to run all three for every edit. For native asset/runtime work, inspect arguments in `tools/verify/verify-glb.ts`, `verify-browser.ts`, `play-journey.ts` and `replay-recording.ts`. The current `verify-glb.ts` accepts character/car inputs; passing it does not validate a scenery or landmark asset. Check those assets with their own contracts/census and full glTF validation, then the affected runtime behavior. Use the current plan's gate and preset budgets. A release journey must use that release's recording; a focused simulation test does not close a browser gate. Use `pnpm build:review` plus `pnpm preview` for review-build transfer/performance measurements when required, and check ordinary production output separately for production-only claims.

Maintain the existing project handoff/decision records when the task warrants it, rather than introducing another status system. Record the requested scope, changed source/content identity, completed checks, captures actually opened, missing evidence and next runnable step. A reference to an older PASS remains historical until its inputs match the candidate.

## Model-adaptation basis

The autonomy, instruction-priority, bounded delegation, concise reporting and test-scope guidance follows [OpenAI's GPT-6 Astra prompting guidance](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#prompting-best-practices), fetched on 2026-10-17. This is a prompt/workflow adaptation: no provider SDK, API model router or application runtime model integration is needed by these local helpers. Model documentation does not establish Blender compatibility or game acceptance; use the separate evidence gates.
