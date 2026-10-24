# Setup

Last tested on Windows 11 with an 8 GB RTX 3070 Ti, Blender 5.2.1 LTS, Python 3.11 and torch 2.9.1+cu128 (October 2026).
Treat versions as the last known-good set, not as the newest available; check the Kimodo README when something fails.

## Blender

- Blender 5.2 LTS. The default Windows install is `C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`;
  elsewhere use your own install path.
- Always `-b --factory-startup --python-exit-code 1` and `use_scripts=False` (the scripts already do). Authoring files
  often contain rig UI scripts (`cloudrig.py`); they are not needed and should not run.
- Scripts use slotted actions (`action.slots`, `anim_utils.action_ensure_channelbag_for_slot`), Blender 4.4+ API.
  `MaskModifier.invert_vertex_group` (not `invert`), materials are always node-based in 5.x.

## Kimodo (motion generation)

```bash
cd motion
git clone https://github.com/nv-tlabs/kimodo vendor/kimodo           # last verified commit e1c219c (2026-10-15)
uv venv --python 3.11 .venv-kimodo
uv pip install --python .venv-kimodo/Scripts/python.exe torch==2.9.1 --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv-kimodo/Scripts/python.exe cmake setuptools wheel
export PATH="$(pwd)/.venv-kimodo/Scripts:$PATH"                       # MotionCorrection builds with cmake
uv pip install --python .venv-kimodo/Scripts/python.exe --no-build-isolation-package kimodo \
    -e "vendor/kimodo[all]" huggingface_hub
.venv-kimodo/Scripts/python.exe -c "import kimodo, motion_correction, torch; print(torch.cuda.is_available())"
```

- Model: `nvidia/Kimodo-SOMA-RP-v1.2` (ungated, downloads on first use to the HF cache). Kimodo code is Apache-2.0;
  read the model card for the weights' licence before commercial use (the Snow project accepted non-commercial terms).
- The text encoder (LLM2Vec on `meta-llama/Meta-Llama-3-8B-Instruct`) is gated. A fine-grained token without
  "read gated repos" gets HTTP 403. The pipeline does not need it: `gen_notext.py` feeds the unconditional (zero) text
  embedding and constrains root path + heading every frame. Do not use an ungated Llama mirror without the user's consent.
- Tokens: `HUGGINGFACE_TOKEN` in the project `.env`. Never echo it; check with
  `curl -s -H "Authorization: Bearer $T" https://huggingface.co/api/whoami-v2` and print only the user name/error.
- 8 GB VRAM is enough for 3 samples × 100 denoising steps × 5-8 s clips at 30 fps.
- Run Python tools with `-I` (isolated) from a work directory so nothing in the cwd shadows a module.

## Browser runtime

- three.js r150+ with `GLTFLoader` and `SkeletonUtils`; Vite dev server; Playwright Chromium with
  `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist` for GPU captures on Windows.
- ffmpeg on PATH for demo videos.
- If port 5173 stays busy after stopping the dev server, an orphan `node vite` holds it: check the command line of the
  PID before killing it.
