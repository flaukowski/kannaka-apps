# kannaka-apps — session conventions

- App model + store contract: `docs/adr/0001-app-model-and-store.md`. Read it
  before changing the runner or manifest format.
- Zero runtime dependencies: the runner and scripts are plain Node (≥20.11,
  `import.meta.dirname`). Do not add node_modules.
- `app.toml` is a deliberate TOML **subset** ([sections] + flat key = value);
  the parsers in `runtime/khdl-app.mjs` and `scripts/build-index.mjs` must
  stay in sync.
- After adding/changing any `app.toml`: `node scripts/build-index.mjs`
  (CI fails on a stale `store/index.json`).
- Seed programs must not contain `expect` lines (ADR-0001 §4); gate and seed
  queries must stay textually identical.
- Never implement a `seed_via` other than `"cli"` without the owning
  service's write API — single-writer rule (ADR-0001 §5).
- Push as flaukowski identity; CI = `node --check` + index freshness +
  `kannaka-hdl check` over every `.khdl`.
