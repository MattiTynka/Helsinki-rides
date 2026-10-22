# Civilian population and police response

This pass starts from deployed source `a3ace03` and world
`senate-20261021-city-expansion`. The new world is
`senate-20261022-civilian-response`; its descriptor pins the exact payload.
City geometry, collision, streets, texture tiers and streaming rules are retained.

## Gameplay

The first completed theft is reported, including when no officer sees it.
Unseen reports arrive after the existing 3–6 second witness delay; witnessed
thefts are immediate. Re-entering the same stolen vehicle does not report another
theft. Reports retain their incident coordinates, so police investigate the
reported site rather than following an unseen moving player.

Police may return fire after an actual player discharge. Aiming, an empty
magazine, theft, dangerous driving or a higher wanted level cannot independently
authorize police shooting. Holstering, escape, death and respawn clear that
permission. Moving officers retain their aimed upper body between shots.
Press G on foot to holster and surrender; releasing aim alone does not put away
the weapon. Holstering wins simultaneous aim, fire and reload inputs. A later aim
can draw the weapon again, but police need a new actual player shot to return fire.

Up to eight civilians walk near the player on supported, obstacle-checked street
edges and footways. Rain has dark and light complexion civilian variants; the
original dark-complexion Snow is also present. Distant walkers retire. Shooting
or driving into civilians causes injury, a fall and a police report. Survivors
recover without an upright snap on a repeated hit; dead actors remain down and
retire on bounded timers. Vehicle impacts use pre-solve relative speed so an
abrupt stop against a pedestrian does not discard the injury.

## Motion and rendering

Finn and uniformed Rain retain their accepted native rigs. Shot-driven recoil
uses a damped spring and paired arm IK. Actual shots are queued across fixed
simulation ticks, including frames containing several ticks. The rendered barrel
positions the flash; a short warm point light illuminates nearby hands and face.
The light is calibrated for this game's tone mapping and pistol geometry.

Civilian animation uses the corrected original Snow/Rain derivatives, with the
three used idle, walk and death clips and 22-joint skeletons. Their Quaternius motion provenance is
recorded separately from the Blender Studio model attribution. Knockdown poses
scrub the existing fall animation, hold, then reverse for a surviving actor.

## Web delivery

`tools/assets/prepare_civilian_characters.mjs` creates separate derivatives with
512-pixel mipmapped KTX2 textures and lossless Meshopt buffer compression. It
never overwrites originals. Snow's index-only reduction keeps every retained
vertex attribute exact, including skin weights. Face, eyebrow and collar layers
are protected together after close-up review rejected earlier reductions.

| Civilian | Triangles | GLB bytes |
| --- | ---: | ---: |
| Rain, dark complexion | 13,360 | 753,176 |
| Rain, light complexion | 13,360 | 748,728 |
| Original Snow | 13,888 | 774,576 |

All three satisfy the existing 14,000-triangle NPC geometry budget and a civilian
contract requiring only their three used clips. Seven unused action clips and
their unreachable buffers are removed without resampling the retained clips. Actor models load
after startup; nearby simulation waits while a required model is unavailable.
The loader and publication stager reject configured appearances without a
matching character asset. Existing cell unloading, low texture tiers and bounded
actor cleanup remain in effect.

`tools/assets/stage_civilian_release.ts` validates the base gameplay digest,
checks character contracts, hashes all retained payloads and hard-links unchanged
files into a fresh release. Credits and notices are refreshed independently.
The world sub-budget reserves 20 MB for the shell, within the unchanged 980 MB
complete-site ceiling. The stager checks the combined artifact independently;
the GitHub Pages limit is not bypassed. No city cell or texture tier is removed.

## Verification and remaining scope

Portable source checks, TypeScript, release-tool tests and source/privacy audits
are required before publication. Focused native-world checks cover population
in six districts and dispatch in four. Browser harnesses exercise a real F-key
theft, report timing, pursuit without first fire, actual return fire, civilian
assault, fall/recovery, decoded textures and exact runtime asset hashes. Player
relocations used to frame these inspections are explicitly recorded as fixtures.

Independent review checked retained animation/skin data, glTF decoding, texture
mips, geometry budgets, repeated-hit continuity and report-location knowledge.
Render images were opened for visual review; checks alone are not appearance
evidence. The release receipt and hosted smoke identify what actually deployed.

The requested Agent 47 model is not included in this packet. Its official asset
download remains unavailable to the working session. No substitute model or
unverified animation is presented as Agent 47. The recorded source is Veterock's
[Agent 47 model](https://sketchfab.com/3d-models/agent-47-riggedface-morphs-1680cad927304bb687d6a9ad5b9dd98a),
whose public metadata identifies CC BY-NC 4.0. Integration and its separate
attribution remain pending the actual authorized asset file.
