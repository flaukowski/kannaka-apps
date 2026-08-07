# crystal-worker

The supply side of the §14 loop (ADR-0002). Consumes the research
scheduler's **order book** (`~/.kannaka/research-scheduler.json`) — the
durable record; the NATS announce is best-effort transport, and core
NATS does not persist an order published while no worker listens.

One run = one **shift**:

1. Open orders = recorded orders without `fulfilled_at`.
2. Per order, up to `attempts` bounded `kannaka-crystal evolve` runs,
   cycling materials and alternating robust mode, seeds derived from the
   order's persistent attempt counter (shifts never repeat a strategy).
3. After each attempt the registry is re-read; a primitive matching the
   order's class (hdl-normalized) at or above its floors fulfils the
   order (`fulfilled_at`, `fulfilled_by`, and the attempt log are
   stamped into the order book).
4. Unfulfilled orders stay standing with their attempt history — rare
   classes are supposed to take many shifts; that is what research
   demand means.

The next `research-scheduler` pass then re-grows the demand programs;
satisfied demand leaves the backlog and logs
`RESOLVED <key> (attributed to order <id>)` — the full
demand → order → growth → resolution cycle.

```sh
KANNAKA_CRYSTAL_BIN=path/to/kannaka-crystal \
  node runtime/khdl-app.mjs run apps/crystal-worker            # one shift
node runtime/khdl-app.mjs run apps/crystal-worker --dry-run    # show plan only
```

Lane note: this app only RUNS the kannaka-crystal CLI; it never touches
crystal source. Registry writes happen through crystal's own evolve
registration path.
