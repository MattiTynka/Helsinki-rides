# Recolour route: how it works and how to tune it

Read this when a recolour result looks wrong, or before changing defaults. The normal commands are in
`SKILL.md`; calibration is shared with the projection route (`route-projection.md` §1–2).

## Contents
1. Why recolour
2. recolour step by step
3. tone: matching a real render
4. render and apply
5. Options
6. Symptoms and fixes
7. Limits
8. Worked example (Rain → police officer)

## 1. Why recolour

Reference images are usually concept art: the head is bigger, the arms sit higher, the costume has parts
the mesh doesn't. Blending several views' pixels onto such a mesh puts each view's eyes, badges and
lettering in a slightly different place, so features come out doubled or tripled, and the images'
shading is baked in. Recolour uses the images only for **colour** (from one view per texel) and lets the
model keep its own detail. Its eyes, face and fabric weave stay sharp. Users judge the result on an
EEVEE render, and that is where blending fails and recolour holds up.

## 2. recolour step by step

1. **Scene.** Same pose, meshes and Subdivision setting as `calibrate` (read from `views.json`; the
   `.blend` hash must match). Texels are rasterised per target and UDIM tile at `--work-res` (2048).
2. **Photo colour.** For each view, texels inside the image, facing it (cos > `--min-cos` 0.2), inside
   the eroded, feathered mask (`--edge`) and unoccluded (`--depth-eps`) get a weight
   `cos^--power(4) × feather`. Each texel keeps the colour of its **single heaviest view**. Confidence
   ramps from `--min-cos` to `--full-cos` (0.5).
3. **Palette.** The foreground pixels of the first `--palette-view` (front) are clustered with k-means
   (`--k` 7) in `[ln r − ln g, ln b − ln g, 0.35·ln luminance]`. Shading moves luminance far more than
   chroma, so one fabric under light and shadow stays together. Centres closer than `--merge-chroma`
   (0.35) in chroma and `--merge-lum` (1.4) in log-luminance merge into one label. Each later palette
   view (back) is clustered the same way, but adds only centres that no existing centre covers, as new
   labels. Pooling front and back instead lost the white and bright blue of Rain's patches: the extra
   navy pulled those k-means centres away, and no decals were pasted. Each label's colour is the
   log-space mode of its confidently seen texels.
4. **Marks.** A label holding less than `--min-share` (4%) of all confident votes is a *mark*: badges,
   lettering, piping. Marks never become regions, only decals.
5. **Multi-region objects.** These are given with `--multi`, or chosen automatically: an object whose
   second colour holds `--auto-second` (20%) of it, or whose marks hold `--auto-marks` (2%) of it. Only
   marks whose hue differs from the object's main colour by `--merge-chroma` count: a white mark on black
   shoes is shine in the image, and as a decal it left white blotches on Rain's toe caps. The
   skin object is never chosen, and neither are objects named like hair, brow, lash or beard: drawn
   highlights read as light marks and would be pasted onto the hair as decals. The log prints every object's colour shares and the choice; check it.
6. **Regions.** On multi-region objects, a label counts on an object only if it holds
   `--min-object-share` (15%) of that object's votes, or the `--object-share NAME=value` override. Votes are
   weighted by confidence, box-blurred (`--radius` 6) and gap-filled, and each texel takes the winning
   label.
7. **One-colour objects.** Every other object's texels take one colour per target: the mode of the
   confident photo colours on those objects. That is how hair gets blonde even when the palette has no
   blonde cluster. The skin object (`--skin-object`, by default a mesh named like `head` or `face`) sets
   the skin label's colour, so skin on the body matches the face.
8. **Recolour.** For each region, gain = (photo colour × calibration scale) / mode of the original
   texture over the region. The original × the gain keeps the original's detail at the new colour.
   New-material targets (flat colours before) get flat region colours.
9. **Decals.** Decal colour comes from the heaviest `--decal-views` view whose cos ≥ that view's limit
   (`--decal-cos-view` front=0.4, back=0.4; others `--decal-cos` 0.75). A texel becomes a decal if all of
   these hold:
   - it is on a multi-region object, not skin;
   - its colour is a mark label;
   - it differs from the region colour by more than `--decal-thr` (0.7) in log colour.

   Specks are removed by an open of radius `--decal-clean` (2) and edges are softened by 1 texel.

**Run folder.** It holds one PNG per target (per UDIM tile) at the original image size, plus two label
images: `<stem>_labels*.png` (region colours, for looking at) and `<stem>_labelid*.png` (region IDs, for
`tone`). `report.json` records per target:

- `seen_fraction`, `materials`, `multi_objects` and `single_objects`;
- `labels` (photo colours, linear) and `display_colour`;
- `outputs` and `label_ids`.

At run level it records `multi_objects`, `skin_object` and `decal_only_labels`.

## 3. tone: matching a real render

`tone --blend <applied.blend> --run <recolour run> --out runs/toneN [--prev runs/toneN-1/tone.json]`

- **Beauty.** An EEVEE render (`--samples` 32) through the file's camera at 1200 px on the long side.
  Without a camera it frames the character from the front.
- **Material IDs.** A Workbench flat render with every material's viewport colour set to an ID colour.
- **Region IDs.** A Workbench texture render with each recoloured material's active texture set to the
  run's `_labelid` image (Non-Color, Closest).
- **Scale.** For every (material, region) with at least `--min-pixels` (300) pixels, compared with
  the mode of its rendered colour:
  - **Hue:** the per-channel ratio divided by the luminance ratio, clipped to 1/3–3 and raised to
    `--damping`.
  - **Brightness, first pass:** the luminance ratio, clipped to 0.1–3. Together with the hue this is
    the plain photo / render ratio.
  - **Brightness with `--prev`:** the previous pass's render and scale give two points on
    `render = slope × base + offset`, solved for the photo's luminance and clipped to 1/3–3 per pass. The offset is
    shine from the lights that no base colour removes.
  - **At the floor:** if the solution is below a quarter of the current base luminance, the region
    can't reach the photo, so its brightness holds and only its hue moves. Driving it on towards black
    only turns it grey. On Rain the plain-ratio rule took the shirt's base colour to almost black and the
    render got greyer.
  - **Dark channels with `--prev`, region not at the floor:** each channel whose render is below 0.25
    (linear) gets its own slope and offset and is solved alone, clipped to ¼–3. Shine adds about the same
    to every channel, so one brightness for all overshoots the channel the colour lives in: on Rain the
    jeans matched the photos' luminance but rendered grey [50,53,74] instead of navy [41,51,93]. Bright
    channels keep the shared rule, because AgX compresses them and their own slope is unreliable.

  Damping defaults to 1 on the first pass and 0.5 with `--prev`.
- **Output.** `tone.json` holds:
  - `scales` (what `recolour --calib` reads);
  - `measurements` (photo vs render, the scale applied and `at_floor`, per region);
  - `worst_log_error`, plus `worst_log_error_reachable`, which leaves out the regions listed in `at_floor`.

  The renders are saved beside it.

Two passes (rec1 → tone1 → rec2 → tone2 → rec3) are enough. A third `tone` run on the final file (with
`--prev` the second) is a cheap check: `worst_log_error_reachable` around 0.3 or below means the
render is close to the photos. Regions in `at_floor` stay lighter than the photos; lower their shine with
`apply --set-input`, or report it.

Calibration fits the file's own lights and view transform. Material Preview uses an HDRI instead, so it
looks slightly different. If the file has no lights, `tone` warns. In that case, calibrate under the
lighting the user will render with, or skip `tone`.

## 4. render and apply

- **`render`:** EEVEE shots for review:
  - `front` through the file's camera (`--no-scene-camera` frames it instead);
  - `threequarter` at 37° and `back` at 180°, 50 mm, full body;
  - `face` at 85 mm, `head_side` at 90° and `head_back` at 155°.

  The facing direction comes from `--views` or `--facing`. The file is never saved.
- **`apply`:**
  - relinks or wires the new images as before;
  - sets each changed material's viewport colour to the target's `display_colour`;
  - switches the Layout and Animation 3D views from Solid to Material Preview (`--keep-viewport` skips
    both);
  - with `--set-input "MATERIAL:INPUT=VALUE"` (repeatable), sets that input on every Principled BSDF of
    the material.

  `<name>.tm3d.json` lists all of it.

## 5. Options

| Option | Default | Effect |
|---|---|---|
| `--multi` | auto | Objects that carry several colour regions or marks |
| `--skin-object` | head/face mesh | Sets the skin colour; never gets decals; `none` turns it off |
| `--auto-second`, `--auto-marks` | 0.2, 0.02 | Thresholds for auto multi |
| `--palette-view` | front,back | Views whose colours form the palette; the first is clustered alone, the others add only colours it lacks |
| `--k`, `--merge-chroma`, `--merge-lum` | 7, 0.35, 1.4 | Palette size and merging of shades |
| `--min-share` | 0.04 | Below this share of the character a colour is a mark |
| `--min-object-share`, `--object-share` | 0.15, — | Share a colour needs on an object to become a region there |
| `--radius` | 6 | Region smoothing (work texels) |
| `--decal-views`, `--decal-cos`, `--decal-cos-view` | front,back,left,right; 0.75; front=0.4,back=0.4 | Where decals may come from |
| `--decal-thr`, `--decal-clean` | 0.7, 2 | Mark contrast; speck removal |
| `--calib` | — | `tone.json` from the previous pass |
| `--image`, `--skip`, `--views-only`, `--min-new-coverage`, `--no-warp`, `--work-res`, `--min-cos`, `--full-cos`, `--power`, `--edge`, `--depth-eps` | as `project` | Targets, views and sampling |

## 6. Symptoms and fixes

| Symptom (in the EEVEE renders) | Likely cause | Fix |
|---|---|---|
| Eyes, brows or badges doubled or tripled | `project` used with concept art | Use `recolour` |
| Hair skin-coloured or patchy | Hair treated as multi-region | Give `--multi` without the hair objects |
| A garment painted one colour; its patches or lettering missing | Not multi-region | Add it to `--multi` |
| One fabric in several shades (camouflage) | Shades not merged | Raise `--merge-chroma` (0.45) or `--merge-lum` (2) |
| Dark band or smudge across a garment | Gear drawn in the images but not modelled (belt, holsters, bag) | `--object-share NAME=0.5` for that object |
| Boot colour around the trouser ankles | Same, at the hem | Raise `--min-object-share` (0.2) |
| White or blue blobs on clothes | A mark colour is common enough to become a region | Raise `--min-share` (0.06) |
| White blotches on shoes or another plain item | Auto multi took highlights in the images for marks | Give `--multi` without that object |
| Patches cut in half | The patch wraps over a curved surface past the view's decal limit | Lower that view's limit, for example `--decal-cos-view front=0.3,back=0.3` |
| Lettering doubled, or a shifted partial copy | An oblique view adds decals | Keep side views at 0.75, or remove them from `--decal-views` |
| Small stray marks | Noise in the images | `--decal-clean 3` |
| Marks on the face or hands | Wrong skin object | Set `--skin-object` |
| Render lighter and greyer than the images | The file's lighting (AgX, bright lights) | Two `tone` passes |
| One garment stays grey after `tone` (listed in `at_floor`) | Too shiny: the lights' shine outweighs its base colour | `apply --set-input "MAT:Specular IOR Level=0.45"` (match a similar fabric) |
| No patches or lettering at all; the log shows no light mark colour in the palette | The mark colours were lost from the palette | Check that the view with the most marks is first in `--palette-view`; raise `--k` (9) |
| `tone` scales stuck at 0.1 or 3 | Region barely visible or misidentified | Open `beauty.png` and `label_id.png` in the tone folder; raise `--min-pixels` |
| A back-only colour missing (back panel) | Not in the palette views | It is if `back` is in `--palette-view`; otherwise add the view |
| The user sees the old colours | Solid view shows viewport colours | Don't pass `--keep-viewport`; tell them Z → Material Preview |
| Eyebrows or lashes keep the old colour | They were skipped (vertex colour or tiny) | Say so; recolour them only if the user asks |

## 7. Limits

- **Colour only, not shape:** a T-shirt stays a T-shirt, and a belt, boots, collar or pockets that the
  mesh lacks appear as nothing (or a smudge, see §6). Say so in the report.
- **Decal sharpness:** decals are only as sharp as the image is on that spot. Small badges come out faint.
- **Animation:** everything is UV-mapped, so the textures follow the rig.

## 8. Worked example (Rain → police officer)

The images showed a blonde Finnish police officer. The model is Rain, with a white top, jeans, brown
skin and hair. The approved result used:

```bash
SKIP="--skip TEX-rain_eyes.png.000 --skip new:MAT-rain.gums --skip new:MAT-rain.teeth --skip new:MAT-rain.tongue --skip new:MAT-rain.eyebrows --skip new:MAT-rain.eyelashes"
recolour ... $SKIP --object-share GEO-rain-top=0.5          # duty belt and holsters drawn over the shirt
apply    ... --set-input "MAT-rain.top:Specular IOR Level=0.45" --repair-paths   # shirt was as shiny as plastic, rendered grey; source texture paths broken
```

It took two `tone` passes. Auto multi picked the body (arms become sleeves), the top and the scarf.
Hair, shoes, jeans and hairband got one colour each, and the head set the skin colour. Rerunning
exactly these commands reproduced the approved look:
- whole patches and a single POLIISI;
- navy jeans and black shoes;
- skin a little closer to the images than the approved file.

The check pass gave `worst_log_error_reachable` 0.24. Shirt, sleeves, scarf, laces and hair are
`at_floor`, so the shirt and sleeves render a little lighter than the images; that was accepted. The
approved file itself was made with `--multi GEO-rain-body,GEO-rain-top,GEO-rain-jeans`, and either set
works. Before the mark-hue rule, auto multi also took the shoes (their shine read as 3% white marks)
and left white blotches on the toes.
