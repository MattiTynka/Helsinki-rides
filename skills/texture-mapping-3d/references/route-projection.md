# Calibration and pixel projection: how they work and how to tune them

Read this when a calibration or projection result looks wrong, or before changing defaults. The normal
commands are in `SKILL.md`. Calibration (§1–2) feeds both local commands. `recolour`
(`route-recolour.md`) is the default; `project` (§3) blends the images' own pixels, so use it only for
renders of this exact mesh. With concept art it doubles features.

## Contents
1. Calibrate: from an image to a camera and a warp
2. views.json and the calibration outputs
3. Project: from cameras to texels
4. Symptoms and fixes
5. Limits

## 1. Calibrate: from an image to a camera and a warp

`calibrate` runs once per image folder and `.blend` (it checks the `.blend` hash later).

1. **Scene.** It opens the file with scripts disabled and sets the pose (`--pose current|rest`,
   `--frame`). It evaluates the character meshes as rendered, without Subdivision Surface: outlines
   barely change, and fitting gets much faster.
2. **Reference mask.** The mask comes from `<view>_mask.png` if present, then alpha, then a backdrop
   key:
   - The backdrop is modelled from the four image borders, so gradients and vignettes are fine.
   - Pixels within `--mask-tol` (0.08) of the backdrop count as backdrop. So do neutral pixels at
     0.4–1.15× its brightness (shadows), but only in the lowest fifth of the figure and below, where floor
     shadows fall. Grey gear higher up stays foreground.
   - The bottom view, where no floor is visible, skips the shadow rule.
   - The backdrop is flood-filled from the border, so enclosed areas of backdrop colour stay foreground.
3. **Camera model.** An orbit camera aims at the centre of the character's bounding box:
   - azimuth 0 = in front of the character; 90 = the character's left; 180 = behind; 270 = the right;
   - elevation in degrees (+ = above);
   - roll;
   - perspective k = character height / camera distance (0 = orthographic).

   Scale and image offset are solved per candidate by a 2D silhouette fit (`fit_ortho`, multi-start: by
   height, width, area and bounding box).
4. **Search.** For each view label it runs:
   - a coarse grid of azimuth families × elevations × perspectives (`VIEW_SEARCH`, `PERSPECTIVE`) at 160 px;
   - coordinate-descent refinement of each family that comes within 0.05 IoU of the best, at 400 px;
   - a final fit at 1024 px.

   Scores are IoU minus a weak prior that pulls towards the view the label names (`VIEW_PRIOR`,
   `PRIOR_WEIGHT`). The prior costs a few thousandths of IoU, enough to settle near-ties without
   overriding a clearly better fit.
5. **Mirror ties.** Front-above vs back-above, and left vs right, can have almost equal silhouettes. When
   the runner-up family is within `--photo-margin` (0.08), both candidates are compared by colour with the
   already-solved, unambiguous views (front, back, left, right):
   - The test uses surface points both cameras see: the exposure-normalised median colour difference,
     divided by the same median after shuffling the points.
   - Only agreement beyond chance counts, so a plain navy uniform that matches anything carries no vote.
   - A 10% lead decides. Otherwise the view stays flagged `ambiguous` (within `--ambiguity` 0.02).
6. **Warp.** The camera is rigid, but concept art rarely matches the mesh's proportions. `warp_masks`
   fits a smooth displacement field at up to 512 px so that the reference silhouette, pulled back
   through it, matches the model's silhouette. It is coarse-to-fine demons on signed distance fields
   with Gaussian smoothing. Projection then reads reference colour at camera pixel + displacement.
   `--no-warp` turns it off (use that for renders of this exact mesh).

## 2. views.json and the calibration outputs

Each entry under `views` holds:

- **Camera:** `kind`, `width`, `height`, `forward`/`right`/`up`, and either `center` +
  `pixels_per_metre` (ortho) or `position` + `focal_px` + `cx`/`cy` (perspective). Also `azimuth`,
  `elevation`, `roll` and `perspective`.
- **Fit quality:** `iou` (rigid fit) and `iou_after_warp`, `candidate` and `runner_up`, `ambiguous`,
  `decided_by` (`silhouette` or `photo-consistency with ...`), `photo_check` with per-anchor errors, and
  `coarse_family_iou`.
- **`warp`:** file `warp_<view>.npy`, its size, and the mean and maximum shift in pixels.
- **`weight`:** 1.0, or 0.6 for top and bottom, which are usually oblique and lower quality.
- **Optional `objects`** (add it by hand): a list of object names this view may paint. Use it to stop a
  view from painting a part it shows badly.

Also in the folder:

- `calibrate_<view>.png`: reference | rigid fit | after warp (red = reference only, blue = model only);
- `mask_<view>.png`;
- `warp_<view>.npy`.

You can edit `views.json` by hand, for example to drop a view, change a `weight` or add `objects`.
`project` reads it as it is. Don't edit camera numbers by hand; rerun with different options instead.

## 3. Project: from cameras to texels

For each target image (or `new:<material>` target):

1. **Texel geometry.** It rasterises the target's UV triangles at `--work-res` (2048 max side) per UDIM
   tile. Each covered texel gets a 3D position and normal on the posed mesh. Mask modifiers are off here,
   so skin under clothes keeps its texels.
2. **Per view:**
   - project each texel through the camera and then the warp;
   - keep texels inside the image, facing the camera (cos > `--min-cos` 0.2), and inside the reference
     mask eroded by `--edge` (0.4% of image size) and feathered;
   - ray-cast to the camera against the as-rendered mesh. A texel is visible if nothing is closer than
     `--depth-eps`.
3. **Blend.** Each view's weight is `weight × cos^--power(4) × feather`, and the colour is the weighted
   mean in linear light. Confidence ramps from `--min-cos` to `--full-cos` (0.5) of the most face-on view
   that sees the texel.
4. **Compose.** Gaps between seen texels are filled by push-pull. The original texture is first
   tone-matched (`tone_gains`; `--no-tone-match` turns it off):
   - texels seen well (confidence ≥ 0.5) pair original and projected colour;
   - within about 8 texels of them, the gain is their local colour ratio, which closes narrow gaps such
     as the edges of a sleeve;
   - farther away, each cluster of original colours maps to the dominant projected colour of its seen
     texels, so hidden skin takes the skin tone the images show, not a badge painted on it.

   The new layer is then blended over the tone-matched original by confidence (with `--no-keep`,
   push-pull fills everything instead). The result is
   saved as sRGB PNG at the original image's size, one file per UDIM tile, plus a `_confidence` PNG.
5. **New-material targets** are skipped when the views see less than `--min-new-coverage` (20%).
   Targets nobody sees are skipped and listed under `skipped`.

`report.json` records per target `seen_fraction`, per-view `visible`/`occluded_or_masked`, per tile
`textured_fraction_of_covered`, `mean_confidence_covered`, `original_kept` and `tone_matched`, plus the outputs and timing.

## 4. Symptoms and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| A view's camera is on the wrong side (`az180` for a front image) | Mirror tie, and the colour check wasn't decisive | Check `photo_check`; rerun with a larger `--photo-margin`; or drop the view (`--views-only`) |
| `left`/`right` fitted at the opposite azimuth | Files named from the viewer's side | Fine if the colour check agrees. Otherwise swap the file names |
| Blue islands inside the figure in `calibrate_*.png` | Keyed out a part similar to the backdrop | Write `<view>_mask.png`; or lower `--mask-tol` |
| Red halo all around | Backdrop shadow or glow kept as foreground | Raise `--mask-tol`; or supply a mask |
| Low IoU (< 0.75) | Different pose, crop, costume or character | Use another image; re-pose the rig (`--pose`/`--frame`); or use the Modddif route |
| Face features offset in `verify_front.png` | Proportion mismatch the outline warp can't fix inside the face | `--skip` the face/eye materials; or repair in Modddif |
| Colour streaks on side surfaces | Oblique projection | Raise `--power` (6–8) or `--min-cos` (0.3) |
| Thin bright or dark rim at silhouettes | Backdrop bleeding in at mask edges | Raise `--edge` (0.006–0.01) |
| Wrong colour from one view on hidden areas | Visibility tolerance too loose | Lower `--depth-eps` (1e-4) |
| Seams where views meet | Exposure or lighting differs between images | Even out the images, delight them (route-alternatives.md), or accept and repair |
| Eyes, teeth or tongue painted skin-coloured | Hidden or too small in the images | `--skip` those images or materials |
| The new `.blend` shows pink textures | Texture paths broken in the source | `apply --repair-paths`, or `--texture-dir` |

## 5. Limits

- Only what the images show gets the images' colours. Undersides, inner arms and the inside of the
  mouth keep the original texture's detail in the images' tone, or push-pull colour with `--no-keep`.
- Lighting and shadows in the images are baked into the base colour.
- Mirrored or overlapping UVs receive the average of every surface sharing those texels. An asymmetric
  logo shows on both sides. Fixing this means new UVs, which this skill won't do on the rig. Tell the
  user.
- Hair cards, transparent and very thin parts project poorly. Skip them, or texture them in Modddif.
- The warp fixes outlines, not interior features. A face drawn at a different scale lands
  approximately, not exactly.
- Mapping nodes, box projection and procedural colours are not projected through. A `new:` target
  replaces them with a fresh image, and the old nodes stay in the material, unlinked.
