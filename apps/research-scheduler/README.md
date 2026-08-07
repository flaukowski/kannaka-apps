# research-scheduler

Closes the kannaka-hdl §14 loop (ADR-0002). One pass:

1. **Collect demand** — grow every store program (each app's entry / gate /
   seed / variants, plus this app's `demand/*.khdl`) speculatively and
   harvest `discovery_requests` from the sealed plans. Expect-gated
   programs that refuse to emit while failing still contribute: their
   unresolved-component warnings are parsed as degraded requests.
2. **Rank** — group by `domain|class`; blocked-plan count first, floor
   stringency as tiebreak.
3. **Order** — for the top `max_orders` non-memory entries with no
   standing order, enqueue a `crystal_work_order` onto the swarm queue
   (`kannaka swarm enqueue`). Memory-domain demand is recall supply —
   provisioner territory, never a crystal order. **The scheduler only
   enqueues; crystal work executes in the crystal lane.**
4. **Attribute** — state lives in `~/.kannaka/research-scheduler.json`
   (`KHDL_SCHEDULER_STATE` overrides). A request that disappears from the
   backlog on a later pass is logged `RESOLVED`, attributed to its order
   id. Two plans demanding the same class share one order with two
   attributions.

```sh
node runtime/khdl-app.mjs run apps/research-scheduler --dry-run   # report only
node runtime/khdl-app.mjs run apps/research-scheduler             # enqueue + persist
```

The shipped demand program (`demand/memory-seed-bank.khdl`) requests the
"Memory Seed" crystal class — a real registry gap, not a synthetic one —
so a fresh install has one honest standing order from its first pass.
