# ADR-0001: Make kicks and goals feel insanely satisfying

**Status:** Accepted
**Date:** 2026-11-27
**Deciders:** 4ozCy

## Context
The game already has a lot of "juice": slow motion on close calls and goals, screen shake, a white
flash, confetti, net ripples, a crowd that reacts, a fire trail on a 3-goal streak, haptics and a
carnival fanfare. What it lacks is *impact*:

- The kick sounds and buzzes the same whether it's a tap or a 1000 km/h rocket.
- Nothing freezes on contact, so the strike and the ball hitting the net have no weight.
- Goal number 7 in a row sounds exactly like goal number 1.

Hard constraint: the simulation is deterministic and tested (24 physics tests, shareable replays,
the daily challenge). Nothing here may change where a ball goes. Everything below is presentation:
playback timing, sound and vibration only.

## Decision
Add an impact layer on top of the existing effects (Option A):

1. **Hit-stop.** The picture freezes for a few hundredths of a second when boot meets ball (longer for
   harder shots) and when a goal hits the net. The sim just resumes a moment later, so outcomes and
   replays are identical.
2. **Power-scaled kick.** Kick volume, punch and a low thump grow with shot power; the vibration
   grows with it too.
3. **Goal boom.** A deep bass hit when the ball bulges the net, under the existing crowd and fanfare.
4. **Streak ladder.** A combo "ding" that climbs one note per goal in a row, so streaks *sound* like they're
   building.

## Options Considered

### Option A: Impact layer on the existing effects (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Low: about 20 lines, all in the browser layer |
| Risk to physics/replays | None: the sim is untouched |
| Performance | Negligible: a few extra oscillators per kick |
| Familiarity | Same helpers the game already uses (tone, burst, buzz) |

**Pros:** biggest "feel" win per line; safe; ships today.
**Cons:** doesn't add new things to *do*, only makes the current ones hit harder.

### Option B: New mechanics (power meter "perfect zone", combo multipliers, skill shots)
| Dimension | Assessment |
|---|---|
| Complexity | Medium to high: touches scoring, UI and tests |
| Risk to physics/replays | Medium: scoring and replay records change |
| Performance | Fine |

**Pros:** more depth and reasons to replay.
**Cons:** changes the game's balance; needs new tests; slower to ship.

### Option C: Camera work (zoom punch on goals, goal-cam angle)
| Dimension | Assessment |
|---|---|
| Complexity | Medium: the raycast background and stand texture are built around the current camera |
| Risk | Visual glitches at odd angles |

**Pros:** very cinematic.
**Cons:** high effort for the renderer as it is; shake and hit-stop get most of the punch for a fraction of the work.

## Trade-off Analysis
Satisfaction in short-session arcade games comes mostly from feedback at the moments of contact
(strike, net) and from escalation (streaks). Option A targets exactly those moments without touching
the deterministic sim, so it can't break replays, the daily challenge or the tests. B and C are worth
doing later, but they cost more and risk more for less immediate feel.

## Consequences
- Easier: every future effect can hook the same two moments (kick, net) and the streak count.
- Harder: hit-stop adds ~0.1 s per goal; if it ever feels sluggish, shorten the numbers in `hitStop`.
- Revisit: Option B's "perfect power zone" once players have played this version.

## Action Items
1. [x] Hit-stop on kick (scaled by power) and on goal net contact
2. [x] Power-scaled kick sound and vibration
3. [x] Goal bass boom
4. [x] Streak combo ding, one note higher per goal in a row
5. [ ] Play-test on a phone, tune the timings
6. [ ] Consider Option B (perfect power zone) next
