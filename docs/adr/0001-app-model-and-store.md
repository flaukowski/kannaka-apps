# ADR-0001: KHDL App Model and the kannaka-apps Store

- Status: Accepted
- Date: 2026-08-06
- Deciders: Nick Flach, Kannaka session

## Context

kannaka-hdl v0.8.0 completed ADR-0002 (its own repo): sealed plan IR, typed
queries, live providers (crystal registry, `MemoryCliProvider` over a running
HRM, composites), expect gates, the `memory-plan-v1` executable lowering, and
§14 capability-discovery requests. Its first operational use — the fleet-wide
memory integrity gate (2026-08-06) — proved that a resolved, gated plan can
carry a real operational verdict (O2's witness failed all four identity
anchors; three other nodes passed).

That gate was a hand-rolled shell wrapper around one `.khdl` file. The next
step is a repeatable shape for such programs: **apps** — and a place to keep,
list, and install them: **a store**.

## Decision

### 1. One store monorepo; apps graduate when they earn it

Apps live as directories under `apps/` in this repo (`kannaka-apps`). An app
today is small — a manifest, one to three `.khdl` programs, a README — and
does not justify per-app repos, CI, and release plumbing. The store repo IS
the app store: cloning it installs every first-party app.

An app **graduates** to its own repository when it needs an independent
release cadence, its own compiled code, or external contributors. The store
index then lists it as an `external` entry (name + git URL) so discovery
stays in one place. (No app qualifies yet.)

### 2. App manifest: `app.toml`

Each app directory carries an `app.toml`, restricted to a deliberately tiny
TOML subset (`[section]` headers and flat `key = value` pairs; values are
quoted strings, numbers, or booleans). The runner ships its own ~30-line
parser — no dependency, no surprises.

```toml
[app]
name = "preflight"          # store-unique, kebab-case
version = "0.1.0"           # semver, per-app
description = "one line"
kind = "gate"               # gate | provision (open set; runner dispatches on [run] mode)

[run]
mode = "gate"               # gate | provision
entry = "gates/default.khdl"    # gate mode: the gate program
# provision mode instead uses:
# seed = "seed.khdl"            # anchors WITHOUT expect lines (see §4)
# gate = "gate.khdl"            # anchors WITH expect gates
# seed_via = "cli"              # only "cli" is implemented; see §5
# seed_importance = 0.8         # overrides lowered --importance for seeded anchors

[variants]
# optional named alternates for [run] entry/seed/gate, e.g. per node role:
# witness = "gates/witness.khdl"
```

### 3. Runner: `runtime/khdl-app.mjs`

A thin host loop over the `kannaka-hdl` and `kannaka` CLIs (Node, zero
dependencies — Node is already on every fleet node and the dev machine).

- `khdl-app run <app-dir> [--variant N] [--dry-run]` — dispatch on
  `[run] mode`.
- **Env pinning**: the runner unsets experimental recall knobs
  (`KANNAKA_RECALL_*`, `KANNAKA_GLYPH_GRAVITY`) before every kannaka-hdl or
  kannaka invocation. A verdict must not depend on who ran it last
  (measured 2026-08-06: `KANNAKA_RECALL_TEMPORAL_EXP=1.0` buried a fresh
  anchor that clean-env recall ranked first).
- **Gate mode** = `kannaka-hdl grow <entry> --memory-provider <kannaka>
  --unresolved strict`. The exit code is the verdict; stderr (resolution +
  expect lines) is appended to `~/.kannaka/khdl-app.log`.
- **Provision mode** (the genesis loop, bounded to one seed round):
  1. Run the gate. Exit 0 → already provisioned, done (idempotent).
  2. Grow the **seed program** with `--unresolved speculative --emit memory
     --out <plan.json>` (written to a file, never piped).
  3. From `plan.json`, take node ids whose `resolved` is `null` and execute
     **only** the lowered commands referencing those ids, through the local
     `kannaka` CLI (`remember`/`dream`). Resolved anchors are never
     re-seeded.
  4. Re-run the gate. Its exit code is the app's exit code.
- `khdl-app list` — print the store index.

Binaries resolve via `KANNAKA_HDL_BIN` / `KANNAKA_BIN` (defaults:
`kannaka-hdl`, `kannaka` on PATH).

### 4. Seed programs must not carry `expect` lines

kannaka-hdl evaluates expectations in every mode and refuses to emit when
they fail ("evidence requirements not met, nothing emitted"). A seed program
whose anchors are dark would therefore never yield its own repair commands.
Provision apps split into `seed.khdl` (anchors only, same queries and floors)
and `gate.khdl` (same anchors + expects). Keeping the queries textually
identical keeps "dark" meaning the same thing in both programs.

### 5. Single-writer guard: `seed_via`

On witness nodes (O2), the HRM is written only by the witness service — the
CLI is NOT the write path, and seeding through it would violate the
single-writer rule. The manifest's `seed_via` names the write path; the
runner implements only `"cli"` and **refuses** any other value with an
explanatory error rather than guessing. A witness-service executor is future
work and belongs to whoever owns that service's write API.

### 6. Store index

`scripts/build-index.mjs` scans `apps/*/app.toml` and writes
`store/index.json` (sorted, deterministic, no timestamps). CI fails if the
committed index is stale (`--check`). The index is the machine-readable
storefront; the README table is the human one. A Pages storefront and a
composite-backed store provider (`base composite.architecture` queries
against registered app plans) are deliberate later steps.

### 7. Conventions

Same as kannaka-hdl: Space Child License, flaukowski commit identity, CI
must stay green (here: `node --check` on all scripts, index freshness,
`kannaka-hdl check` parse gate over every `.khdl` using the latest release
binary).

## Consequences

- The 08-06 fleet gate becomes an installable app (`preflight`) instead of a
  one-off script; role variants get a home.
- The queued O2 repair path has infrastructure waiting on exactly one
  missing piece (the witness write executor), and the runner physically
  cannot make the single-writer mistake meanwhile.
- Anchor queries double as seed content, so provision apps must write
  anchors as self-contained factual sentences — a feature: the plan is the
  documentation is the memory.
- One seed round is a deliberate bound; a converging re-resolve loop (§14)
  is the Research Scheduler's job (ADR-0002), not the runner's.

## Alternatives considered

- **Per-app repos from day one** — rejected: ceremony without content; the
  graduation path keeps the option open.
- **Runner as a kannaka-hdl subcommand (`khdl run`)** — deferred: the right
  long-term home, but proving the contract in a zero-compile script first
  keeps kannaka-hdl's scope clean and lets the app model iterate without
  cutting compiler releases.
- **JSON manifests** — rejected: the ecosystem is TOML-flavored; the subset
  parser is smaller than the argument about it.
