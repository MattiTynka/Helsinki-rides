# Raised bridge centre bars

The raised twin bars shown in the owner's screenshot are the centre-divider
boxes on Hakaniemensilta. The earlier local flat-tram-track patch targeted the
wrong geometry and was discarded. Ordinary tram tracks remain unchanged.

The correction removes only the exact centre-bar faces from the final world:
5,672 detailed faces and matching physical triangles, plus 3,852 coarse faces.
These faces occupy two cells, `c_p02_m07` and `c_p02_m08`. Outer safety rails,
glass panels, bridge floors, sidewalks, bank/junction repairs and all unrelated
geometry remain unchanged. The bridge producer no longer emits the centre boxes.

`tools/world/remove_bridge_centre_bars.ts` reads the manifest-pinned historical
profile and reconstructs the old centre boxes solely to identify their exact
Float32 triangle multisets. Duplicate caps are counted. It removes those faces
from each detail tier and from the matching physical props collider, filtering
triangle tags together with indices. It retains original vertex arrays, all
non-target triangles and the original compressed visual/image bytes.

From the source checkout, with the staged original mobile world available:

```powershell
node tools/world/remove_bridge_centre_bars.ts --world ../mobile-20261022/public-publish/world/senate-20261022-mobile-safe-v3 --out ../bridge-centre-rails-20261024/world/senate-20261024-bridge-centre-bars --release senate-20261024-bridge-centre-bars --receipt ../bridge-centre-rails-20261024/removal.json
```

The writer rejects a changed input manifest, mismatched or incomplete visual and
physical twins, or an existing output directory. It creates a closed candidate
with four changed visual payloads and two changed collision payloads, retaining
all other files and prior publication records. A new proof records the input,
producer, selected faces and output identities. Validate the packet using the
native Pages stager and inspect the screenshot-matched view in the game before
publication. Physics checks must establish that the bars no longer obstruct
transverse travel while the original road and outer rail geometry are retained.
