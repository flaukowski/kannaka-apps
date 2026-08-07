# preflight

The memory integrity gate as an installable app. Resolves four
operational anchors (identity, swarm, crystal, radio) against the live
HRM in strict mode; expect gates floor the worst survivor. Exit 0 means
"the memory still knows itself" — the checked precondition for every
one-way operation.

```sh
node runtime/khdl-app.mjs run apps/preflight
```

This is the same anchor set the fleet's 04:45 cron gate runs
(kannaka-hdl `examples/memory-gate.khdl`); the app form adds pinned
recall env via the runner and a home for role variants. When the fleet
crons migrate to the store, this app is the artifact they run.
