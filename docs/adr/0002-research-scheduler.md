# ADR-0002: Research Scheduler

- Status: Accepted (implemented 2026-08-06, Nick's direction: "continue with
  full ADR-0002")
- Date: 2026-08-06
- Deciders: Nick Flach, Kannaka session

## Implementation notes (v1 deltas from the proposal below)

Shipped as `apps/research-scheduler` + `mode = "schedule"` in the runner.

- **Sweep source**: store apps' programs + the scheduler's own
  `demand/*.khdl`, NOT registered composites — `composites.json` stores
  sealed plan metadata without the source program, so a composite can't be
  re-grown to harvest fresh requests. Composite sweep returns when hdl
  persists sources (or accepts plan re-resolution) — tracked as future work.
- **Expect-gated programs**: hdl refuses to emit a plan while expects fail,
  so their demand is harvested from unresolved-component warnings instead
  (marked `degraded`, domain `unknown`).
- **Memory-domain demand is never ordered**: dark anchors are recall supply
  (provisioner territory); a crystal work order for them would be a
  category error. They still appear in the backlog report.
- **One standing order per request key** (`domain|class`); attribution =
  every requesting program + plan hash. State in
  `~/.kannaka/research-scheduler.json`.
- All four acceptance criteria from the sketch below hold; #2's "flip
  attributed to request id" is the `RESOLVED <key> (attributed to order
  <id>)` log line on the pass after supply lands.

## Context

kannaka-hdl §14 emits deduped `capability_discovery` requests for queries no
provider can satisfy, and `--publish-discovery` enqueues them on the swarm
work queue. Nothing yet *consumes* that queue with intent: requests are
announced, not scheduled, and plans never re-resolve when a capability
arrives. Meanwhile crystal v0.10–0.12 shipped the supply side — evidence
promotion (`replicate|perturb|resolution`, genome-replay closure) and v0.11
behavior contracts (`noise_shielding`, `pattern_completion`) — but the
registry has zero L6 rows: capability supply exists as machinery, not yet as
inventory. KCB-1 quantified why this matters: the medium's proven edge is
distractor suppression, not retention, so *which* capabilities get grown
should be driven by demand, not by faith.

## Proposal

A store app (`apps/research-scheduler`, provision-adjacent but its own
`mode = "schedule"`) that closes the §14 loop:

1. **Collect demand.** Sweep every registered composite
   (`~/.kannaka-hdl/composites.json`) and every store app's programs; grow
   each with providers attached; harvest `discovery_requests` from the
   sealed plans.
2. **Rank.** Score each requested capability by how many distinct plans it
   blocks (weighted by the requesting plan's own floors — a request from a
   gated architecture outranks a speculative sketch).
3. **Schedule supply.** For the top request(s), emit crystal work orders:
   `kannaka-crystal evolve …` toward the requested class, then
   `promote --procedure behavior --capability <name>` runs. Orders go on the
   swarm queue tagged with the originating request ids — the worker
   announcement path already exists.
4. **Re-resolve.** When a promotion lands (registry row gains a passing
   `behavioral_capabilities` record), re-grow the blocked plans; flips from
   unresolved → resolved are the scheduler's success metric, logged per
   request id.

## Why not build it yet

- Touches three systems at once (NATS queue discipline, crystal promotion,
  plan re-resolution) — exactly the shape that deserves an adversarial
  design review before code.
- Crystal-side prerequisites are one release old (first L2 row exists;
  behavior contracts v1 just shipped) — one manual demand→supply→re-resolve
  round should be walked by hand first to validate the contract.
- The lane split matters: crystal work orders execute in the crystal lane;
  this repo only *emits* them.

## Acceptance sketch (for the eventual implementation)

1. A plan with an unsatisfiable capability query yields a ranked backlog
   entry with the correct blocked-plan count.
2. A hand-run promotion that satisfies the request flips the plan to
   resolved on the next scheduler pass, and the flip is attributed to the
   request id.
3. The scheduler never executes crystal work itself — it only enqueues.
4. Deduplication: two plans requesting the same capability produce one
   order with two attributions.
