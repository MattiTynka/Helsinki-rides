# Police and stealable cars across the playable city

This source-only update starts from public main `89fef38` and retains the
`senate-20261021-city-expansion` world, manifest
`1178aa4520c9c9bc5c371d85cd7229205a4836a123391f1ec38745448b89f8c1`.
No model, texture, collision, road database or world archive changes are needed.
The delivery and streaming policy in the web-delivery handoff remains in force.

Previously, all police units came from four fixed Senate-area spawns. Remote
units could occupy the entire wanted-level allowance, and the largest road
component excluded smaller district networks. Dispatch now selects local road
lanes with a directed route to the player's local road network. New patrols
start outside the immediate view, within the player's collision loading ring,
and require complete native ground support at the road's actual height.
Unseen remote units can be replaced locally. Nearby officers and cars stay in
place, and a stolen or reserved patrol car survives its old unit's retirement.
Wanted-level unit caps remain unchanged. Failed routes brake and retry instead
of driving directly across disconnected ground. New responding units retain a
fixed local incident point until a real sighting updates shared knowledge, so
an old Senate sighting cannot send a replacement back to the wrong district.
Completed driving routes stay safely braked on subsequent frames; a native
Toinen linja test exposed the previous out-of-range waypoint crash.

The world previously supplied only nine civilian cars. A local population now
adds up to twelve more, using municipal parking slots and clear outer edges of
ordinary streets. The existing Lumi GT and Revontuli models are reused. The
full car footprint must have loaded native ground, acceptable slope and solid
clearance; terrain fallback, water, mismatched road levels, active traffic lanes
and junction mouths are excluded. Cars use the existing boarding, driving and
damage systems. Cars farther than 260 metres retire after a delay, releasing
their physics bodies and renderer views. The player's car and an entry in
progress remain protected. No map-wide actor population or additional model
downloads are introduced.

Retiring a police unit also keeps responsibility for a protected stolen patrol
car. Once abandoned far away, that car can retire too, releasing its collision
residency instead of accumulating across repeated thefts and district travel.

Regression tests cover distant and disconnected districts, wanted caps,
stolen/reserved patrol cars, unsupported and occupied spawn points, streamed
collision readiness, civilian entry/driving, bounded retirement and replay
determinism. `tools/verify/verify-city-population.ts` exercises six actual-world
districts: Esplanadi, central and northern Mannerheimintie, west Kamppi,
Katajanokka/Uspenski and Hakaniemi. District setup uses the native review
drop-ins; civilian entry and acceleration use real keyboard input. The normal
weapon and witness-report simulation must dispatch a new responding local
unit in each district. These checks do not establish every road or a long
whole-city performance soak. Existing map and bridge beta limitations remain.
