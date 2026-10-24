# Other routes: services and local models

Researched 2026-10-17 from primary docs and source code. Items marked **(unverified)** come from vendor
claims or secondary sources. These tools change quickly, so re-check a tool's docs before using it and
tell the user when you could not.

**Main finding:** no texturing service or open model documents keeping a skeleton or skin weights.
Treat every external tool as a texture generator for a static copy:

1. `handoff` writes a posed, UV-keeping proxy GLB.
2. The tool textures it.
3. `transfer` ray-casts the returned surface onto the original UVs.
4. `apply` writes the new `.blend`.

`transfer` doesn't care whether the tool kept the UVs, re-unwrapped or remeshed. It needs only a textured
surface in the same pose and roughly the same place. It re-aligns small offsets and scale changes
(similarity ICP). For tools that normalise the mesh to a unit cube, scale the result back in Blender
first if `transfer` reports misalignment. Keeping UVs on the tool's side still helps, because detail
survives better.

Uploading to any service publishes the character to that vendor. Ask first, as with Modddif.
API keys belong to the user. Never type them into pages, and never print `.env`.

## Web services that texture an uploaded mesh

| Service | Keeps UVs | Image conditioning | Notes |
|---|---|---|---|
| **Meshy Retexture API** ([docs](https://docs.meshy.ai/en/api/retexture)) | `enable_original_uv: true` | `image_style_url`, or `multiview_image_urls` (1–4 images, first = front; meshy-7; not combinable with style inputs) | GLB/glTF/OBJ/FBX/STL ≤ 400 MB; `enable_pbr`; 2k/4k/8k; about 10 credits (2K/4K) or 15 (8K) per job; the Free plan has no API |
| **Tencent Hunyuan3D cloud, China site** `SubmitTextureTo3DJob` ([docs](https://cloud.tencent.com/document/api/1804/126292)) | `EnableKeepUV` (layout and topology unchanged) | one `Image`, or `MultiViewImages` (left, right, back, top, bottom, left_front, right_front) with model 3.1 | OBJ/GLB input; `EnablePBR`; `TextureSize` 720–4096. The international `SubmitHunyuanTo3DTextureEditJob` takes FBX and has no UV flag (unverified) |
| **Tripo** `POST /v3/models/texture` ([docs](https://developers.tripo3d.com/en/docs/models-texture.md)) | not documented in the API; a blog says Studio respects existing UVs (unverified) | one image, or exactly 4 (front, left, back, right) | ≤ 150 MB; `pbr`, `texture_quality` up to 8K, `delight` (v3.5), `bake`; GLB output |
| **Modddif** (web app, no API) | yes, paints into the imported UV map | one selected reference per generation; multiview from preset angles | See `route-modddif.md`. Free = public projects under CC BY 4.0 |
| Scenario (hosts Meshy Retexture), Layer Retexture ("no UV changes"), 3D AI Studio (resells Tripo/Hunyuan) | as their upstream (unverified) | — | Resellers; check their terms |
| Leonardo `generations-texture` | OBJ with UVs | text only | Whether it is still current is unverified |

These don't texture user meshes: Rodin/Hyper3D, Sloyd (only its own jobs), Polycam (tileable materials)
and Kaedim (unverified).

**Mapping our six views onto the APIs:**

- **Meshy:** `multiview_image_urls` takes at most 4 images, with the front first. Send front, then left,
  back and right in the order its docs specify.
- **Hunyuan 3.1:** `Image` = front, and `MultiViewImages` takes the others by name.
- **Tripo:** 4 images, in the order front, left, back, right.

Check the orientation convention for left and right in each API, since some mean the viewer's left.

## Local tools (8 GB RTX-class GPU in mind)

**Keep the mesh's UVs:**

- **StableProjectorz** ([site](https://stableprojectorz.com/)): free Windows app; Stable Diffusion
  projection from many cameras with ControlNet and IP-Adapter. It preserves the original UVs and supports
  UDIM. AGPL-3.0 since 2026-01. It is interactive, so the user drives it; import `handoff.glb` there and
  bring the result back with `transfer`.
- **StableGen** Blender add-on with a ComfyUI backend ([repo](https://github.com/sakalond/StableGen)):
  - Models: SDXL (fits 8 GB), FLUX.1-dev or Qwen-Image-Edit (16 GB+), with an IP-Adapter reference.
  - Set Bake → Unwrap Method = **None** (the default is Smart UV Project). It may pack islands when UVs
    overlap.
  - Blender 5.2 is untested by the author. Run it on a copy, never the user's file. GPL-3.0.
- **TRELLIS.2 texturing** ([repo](https://github.com/microsoft/TRELLIS.2)): mesh plus one image. It uses
  the mesh's UVs when present, but rescales vertices to a unit cube. It needs 24 GB or more and is tested
  on Linux only. MIT licence, but its nvdiffrast dependency is non-commercial.
- **MV-Adapter** ([repo](https://github.com/huanngzh/MV-Adapter)): the pipeline defaults to
  `uv_unwarp=False`, but the bundled scripts set it to True, so edit that one line. The SD2.1 variant
  needs under 10 GB. Its CV-CUDA dependency is Linux/WSL2, so native Windows is unverified. Apache-2.0.
- SyncMVD, Paint3D, TEXTure and Text2Tex keep UVs but are text-driven, not faithful to a reference.

**Re-unwrap or remesh** (use `transfer` to bring the result back):

- **Hunyuan3D-2.1 Paint:** remeshes by default, then always runs xatlas. Albedo plus metallic-roughness;
  about 21 GB. The Tencent Community License **excludes the EU, UK and South Korea**, so check where the
  user is before suggesting it.
- **Hunyuan3D-2.0 Paint:** front, left and back images; RGB only; same licence. It also ships
  `hunyuan3d-delight-v2-0`.
- Step1X-3D, UniTEX (FLUX weights are non-commercial) and SeqTex (80 GB GPU) are research-grade.

**Add-ons around projection:**

- **Delighting** before projection: Marigold IID appearance (albedo, roughness, metallic;
  [model](https://huggingface.co/prs-eth/marigold-iid-appearance-v1-1), CreativeML Open RAIL++-M), or the
  Hunyuan delight model. Feed delit images to `calibrate` and `project` in place of the originals. Keep
  the file names and the size, or recalibrate.
- **PBR after projection:** Material Anything can derive PBR maps from an albedo-textured mesh (MIT,
  Linux). This skill only changes base colour; adding other maps is a separate, explicit step.

## Blender-native alternatives (and why this skill doesn't use them)

- **Bake operator:** Cycles only, and since 5.0 it bakes only into selected *and* active image nodes. It
  has no base-colour pass, so base colour must be routed through Emission and baked as EMIT. It works,
  but it is slow and fragile headless. `transfer` does the same Selected-to-Active job with BVH ray-casts
  in numpy.
- **`paint.project_image`:** projects from the active camera with occlusion and normal falloff. Headless
  use is unverified, and there's no multi-view blending.
- **UV Project modifier:** up to 10 projectors, but each face takes the single best one, with no blending
  and no occlusion.

## Pitfalls whatever the route

- **Pose:** texture in the images' pose, and never let a tool's returned mesh replace the rigged mesh.
- **Mirrored or overlapping UVs:** common on characters, and they make asymmetric details collide (a
  badge on one sleeve shows on both). `handoff` reports `uv_overlap_ratio` per proxy.
- **UDIM:** glTF has none. `handoff` packs tiles into 0–1 and `transfer` writes them back per tile. No
  service documents UDIM support.
- **Baked-in lighting:** delight the images or accept the look. Say which in the report.
- **Colour space:** base colour is sRGB, and data maps are Non-Color.
