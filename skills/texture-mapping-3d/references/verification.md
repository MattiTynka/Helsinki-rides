# Verification and review

A texture is done when three things hold: the rig is provably untouched, the numbers are plausible, and
the pictures look right to you after you have actually opened them. A good-looking preview is not proof
of the first, and passing invariants is not proof of the last.

## 1. Invariants (automatic)

```bash
$TM verify --before "$BLEND" --after out/<name>.blend --views runs/calN/views.json --out runs/verifyN [--pose-frame 40]
```

`verify` compares fingerprints of every render mesh in both files:

- geometry (vertex positions and face corners);
- each UV layer;
- vertex group names and every weight;
- shape keys;
- modifier names and types;
- material slots;
- parent, parent bone and world matrix.

It also compares each armature's bones (names, parents, rest head and tail, deform flags).

The expected differences are none of them fingerprinted:

- new image datablocks, and an added image node for `new:` targets;
- the materials' viewport colours and the Material Preview shading that `apply` sets;
- inputs changed with `--set-input`. Anything else fails with exit code 3 and lists each issue. If that happens, do not hand
over the file; find out why.

## 2. Numbers

- **`calibrate`:**
  - `iou` above about 0.75, and `iou_after_warp` above about 0.9;
  - no `ambiguous` views left unexplained;
  - `decided_by` makes sense (the top of a front-above image must be `az0`-ish).
- **`recolour` (log and `report.json`):**
  - the palette has a colour for every material the images show (skin, hair, each fabric, the patches);
  - the multi-region objects and the skin object are the ones you expect;
  - each object's colour shares make sense (a garment mostly one colour; marks only a few percent).
- **`tone` (`tone.json`):**
  - `worst_log_error_reachable` drops pass by pass, to around 0.3 or below.
  - Regions in `at_floor` can't get as dark as the photos under the file's lights. Look at them in the
    renders and name them in the report.
  - Scales that hit the 0.1 or 3 clip mean a region was barely visible or misidentified.
- **`project` (`report.json`):**
  - `seen_fraction` per target, with skin and clothes usually 0.6–0.95;
  - per-tile `textured_fraction_of_covered`;
  - `skipped` entries with reasons;
  - `stray_triangles_outside_tiles` = 0.
- **`transfer`:** `misses` small, and `alignment.p90_after_m` small next to the character's size.
- **`verify`:** MAE vs reference, before → after, per calibrated view. It should drop clearly (for
  example 0.13 → 0.03). Use it to rank runs, not to accept one: a blurry average can score well.

## 3. Pictures (open every one with the Read tool)

| Sheet | What it shows | Look for |
|---|---|---|
| `render/<shot>.png` (front, threequarter, back, face, head_side, head_back) | EEVEE through the file's lights: what the user sees | First and most important. Single clean face features; skin and hair colour; one clean colour per garment; whole patches, single lettering; nothing washed out. Use the SKILL.md §4 list |
| `calibrate_<view>.png` | reference \| rigid fit \| after warp | right side of the character; blue islands inside the figure (keying holes); red parts that are real geometry the model lacks (fine) or a pose mismatch (not fine) |
| `verify_<view>.png` | reference through the warp \| before \| after (unlit) | after ≈ reference; face features on the face; logos and badges in place; no backdrop colour on edges |
| `verify_orbit<angle>.png` | before \| after, lit, at 0/45/135/180/225/315° | seams where views meet; smears on surfaces seen edge-on; untextured or old-texture islands; colours from the front painted on the back |
| `verify_posed<angle>.png` (with `--pose-frame`) | the animated pose | texture follows the deformation; nothing swims |
| `<stem>_confidence.png` | per-texel confidence (white = face-on view) | dark islands = areas no image saw well |

Then give the face a dedicated look. If the sheets are small, crop: load the after image and the
reference and compare the eye line, the mouth and the hairline. Users notice faces first.

## 4. Common defects and causes

| Defect | Cause | Where to fix |
|---|---|---|
| Ghost double or triple features (eyes, brows, badges) | `project` blended views that disagree on position | Use `recolour`. With `project`: lower that view's `weight`, restrict its `objects`, or `--skip` the face |
| The user says nothing changed | They are looking at Solid view, which shows viewport colours | `apply` without `--keep-viewport`; tell them Z → Material Preview |
| Colour defects specific to recolour (smudges, cut patches, grey fabric) | See route-recolour.md §6 | |
| Backdrop grey on silhouette edges | Mask edge too generous | `project --edge` up; or a manual mask |
| Front detail on the back | Wrong family in calibration (mirror tie) | Recalibrate (route-projection.md §4) |
| Patchy brightness between views | Different lighting per image | Delight or colour-match the images; or accept and note |
| Old texture showing through in strips | Low confidence (oblique) areas keep the original by design; tone matching recolours it, but a part whose colour the images never show keeps its old colour | More views; `--min-cos` down a little; or `--no-keep` for a full replace |
| Unseen skin a different tone from the face | Run with `--no-tone-match`, or the skin was barely seen | Remove the flag; check the skin's `seen_fraction` and `tone_matched` in `report.json` |
| Pink / missing textures in the new file | Source texture paths broken | `apply --repair-paths`; tell the user about their file |
| Asymmetric logo on both sides | Mirrored UVs share texels | Can't fix without new UVs; report |

## 5. Outcome labels for the report

- `TEXTURED_VERIFIED`: invariants PASS, numbers plausible, sheets reviewed with no blocking defects.
- `TEXTURED_WITH_ISSUES`: invariants PASS, but there are listed visible defects the user should know about.
- `BLOCKED_CALIBRATION`: no trustworthy camera for the needed views (wrong character, pose or crop).
- `BLOCKED_SERVICE`: a login, CAPTCHA, payment, quota, consent or upload refusal stopped the Modddif route.
- `BLOCKED_INVARIANTS`: `verify` failed; no file handed over as a result.
- `BLOCKED_ENVIRONMENT`: Blender 5.2 not found, selftest failing, or tools unavailable.

The JSON outputs carry machine statuses: `RECOLOURED_NOT_REVIEWED`, `PROJECTED_NOT_REVIEWED`, `TRANSFERRED_NOT_REVIEWED`,
`VERIFIED_INVARIANTS_NOT_REVIEWED`, `FAILED_INVARIANTS` and `INTERMEDIATE_NOT_A_RELEASE`. They say what the
code checked, so leave them as they are. The outcome label is your judgment after looking.
