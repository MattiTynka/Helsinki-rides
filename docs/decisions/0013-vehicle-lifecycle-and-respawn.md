# 0013 Vehicle lifetime and safe respawn

Date: 2026-10-17. Scope: the owner's reported render crash, empty pistol after
respawn, and repeated falls outside the playable map.

An officer's retirement must not delete a car while the player is entering,
driving, exiting, or still using it as the death/arrest camera target. The officer
can retire independently. Cancel an unfinished seat reservation when the player
dies or is arrested. An absent vehicle in a presentation snapshot must fall back
to rendering the player and updating the camera instead of throwing out of the
animation frame.

Every new life restores the configured starting weapons with a full magazine and
their configured reserve, then holsters them. Reload and firing timers reset;
repeated respawns must not accumulate ammunition. This request supersedes the
original plan's ammunition loss after death and weapon confiscation after arrest.

Respawn and fall recovery must resolve to supported, unobstructed positions inside
the playable map. A nearest road outside that area, a terrain sample without a
physical surface, or an unsuccessful nearest-road search is not a valid recovery.
Vehicle recovery must account for the vehicle footprint and work even far from
the road network. Use a bounded, deterministic fallback to verified ground. Keep
valid authored anchors where possible and preserve the existing world assets.

Verification: reproduce the missing-vehicle error, exercise officer cleanup during
player use and unused-car cleanup, verify ammunition after both endings, test
unsupported/outside anchors and distant player/vehicle falls, then run the affected
ordinary-build browser scenarios and native gameplay journeys with Node replay.
Evidence is recorded under `data/evidence/vehicle-despawn-crash-20261017/`.
