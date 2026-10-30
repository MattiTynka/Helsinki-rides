# Free traversal without geographic fences

The game previously rendered streets beyond its qualified coverage polygon while silently stopping vehicles and characters at the polygon. The player could see an open street and still be unable to continue. Geographic recovery and vehicle entry/exit checks could also return or strand a player at the same edge.

At the user's request, traversal now follows physical collision geometry instead of the coverage polygon or rectangular play area. Walking, jumping, climbing and driving do not clip their movement to geographic coverage. Vehicle approaches, exits and drop-in destinations do not reject positions because of the polygon. Crossing a geographic edge does not trigger recovery. Recovery still handles nonfinite positions and actual falls below the kill height, using physically supported recovery destinations.

The minimap draws the road graph without the old polygon clip. Collision and visual streaming continue following the player and waiting for missing nearby assets; those temporary loading waits remain necessary for consistent physics and rendering. Coverage metadata remains available to offline authoring tools and automatic population/spawn qualification. It is not a player movement boundary.

This changes the application shell. The pinned optimized world, terrain, road graph, textures and collision payloads are unchanged. Removing the fences does not repair every unfinished street surface or create additional city geometry. Ordinary walls, kerbs and other physical obstacles still collide.

Regression checks cover crossing polygon holes, polygon edges and all four rectangular edges; walking out and back; driving, steering, exiting and re-entering outside coverage; climbing across an edge; finite drop-in validation; real fall recovery; retained spawn qualification; and a physical building beyond the old mask that still blocks walking. Run `node --test packages/sim/test/simulation.test.ts apps/game/test/drop-in.test.ts`, followed by the normal source and release gates before publication.
