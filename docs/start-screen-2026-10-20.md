# Screenshot-backed start screen

The start screen uses two translucent panels over a static Senate Square game
screenshot. The main panel contains the language choice, loading state, play
button, keyboard help and graphics setting. The second panel keeps the full
source credits and license links visible before play. At narrow widths the
panels stack; the whole screen scrolls, including on short viewports.

The play button stays disabled until startup completes. Its native button
semantics support Enter and Space. Language, graphics and credit interactions
do not enter the game. Starting play hides the entire overlay, including the
screenshot. The background has no animation or input handlers, and the progress
transition is disabled when reduced motion is requested.

## Image provenance

`apps/game/src/assets/senate-square-start.jpg` is a metadata-free JPEG re-encode
of the game screenshot supplied by the user for this design. No scene content
was added or removed, and no Google Maps imagery is included. The existing
third-party game asset credits also apply to the depicted scene; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

| Item | Value |
| --- | --- |
| Original image | 1918 × 974 pixels, PNG |
| Original SHA-256 | `f4435f2786150ad763f414e0058a35463e511d84ec76a5aeb8bf6c060e0a6b1a` |
| Published image | 1918 × 974 pixels, JPEG, 145,349 bytes |
| Published SHA-256 | `252fababed512da5b29c9a945c7a8731b43e26b3e684454aa91d54d64080e9ca` |
| Conversion | Sharp 0.35.5, quality 82, MozJPEG, 4:2:0 chroma |
| Metadata | No EXIF, XMP or IPTC; checked with the release JPEG sanitizer |

The CSS asset reference lets Vite emit a content-hashed image inside the
application assets directory for both the ordinary build and GitHub Pages.
The image adds approximately 142 KiB to the shell and has no effect on city
streaming, world manifests, collision or the in-game camera.
