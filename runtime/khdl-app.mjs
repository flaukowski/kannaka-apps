#!/usr/bin/env node
// khdl-app — minimal host runtime for KannakaHDL apps (ADR-0001).
//
//   node khdl-app.mjs run <app-dir> [--variant NAME] [--dry-run]
//   node khdl-app.mjs list [store-root]
//
// Environment:
//   KANNAKA_HDL_BIN   kannaka-hdl binary (default: kannaka-hdl on PATH)
//   KANNAKA_BIN       kannaka binary     (default: kannaka on PATH)
//   KHDL_APP_LOG      append log         (default: ~/.kannaka/khdl-app.log)
//
// Exit codes: 0 = app succeeded (gate passed / provisioned and re-gated);
// nonzero = the verdict, propagated from kannaka-hdl where applicable.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const HDL = process.env.KANNAKA_HDL_BIN || "kannaka-hdl";
const KAN = process.env.KANNAKA_BIN || "kannaka";
const LOG =
  process.env.KHDL_APP_LOG || join(homedir(), ".kannaka", "khdl-app.log");

// Pin recall semantics: experimental ranking knobs left exported in a shell
// change what the live memory returns (measured 2026-08-06). A gate that
// inherits experiment flags is a gate whose verdict depends on who ran it
// last; apps always judge default recall.
const PINNED_ENV = { ...process.env };
for (const k of Object.keys(PINNED_ENV)) {
  if (k.startsWith("KANNAKA_RECALL_") || k === "KANNAKA_GLYPH_GRAVITY") {
    delete PINNED_ENV[k];
  }
}

function log(line) {
  const stamp = new Date().toISOString();
  try {
    mkdirSync(join(homedir(), ".kannaka"), { recursive: true });
    appendFileSync(LOG, `[${stamp}] ${line}\n`);
  } catch {
    // Logging must never change a verdict.
  }
}

function die(msg, code = 2) {
  console.error(`khdl-app: ${msg}`);
  process.exit(code);
}

// --- app.toml (deliberate subset: [sections] + flat key = value) ----------

function parseToml(text) {
  const doc = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (sec) {
      section = sec[1];
      doc[section] = doc[section] || {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`app.toml: cannot parse line: ${raw}`);
    if (!section) throw new Error(`app.toml: key before any [section]: ${raw}`);
    let value = kv[2].trim();
    const str = value.match(/^"(.*)"$/);
    if (str) value = str[1];
    else if (value === "true" || value === "false") value = value === "true";
    else if (!Number.isNaN(Number(value))) value = Number(value);
    else throw new Error(`app.toml: unquoted string value: ${raw}`);
    doc[section][kv[1]] = value;
  }
  return doc;
}

function loadManifest(appDir) {
  const path = join(appDir, "app.toml");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    die(`${path}: ${e.message}`);
  }
  const doc = parseToml(text);
  if (!doc.app?.name || !doc.run?.mode) {
    die(`${path}: [app] name and [run] mode are required`);
  }
  return doc;
}

// --- subprocess plumbing ---------------------------------------------------

function runCapture(bin, args) {
  const r = spawnSync(bin, args, { env: PINNED_ENV, encoding: "utf8" });
  if (r.error) die(`cannot run ${bin}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function scratchFile(name) {
  const dir = join(tmpdir(), "khdl-app");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${process.pid}-${name}`);
}

// --- modes -----------------------------------------------------------------

function runGate(appDir, gateRel, label) {
  const gate = join(appDir, gateRel);
  const out = scratchFile("gate-plan.json");
  const r = runCapture(HDL, [
    "grow", gate,
    "--memory-provider", KAN,
    "--unresolved", "strict",
    "--emit", "json",
    "--out", out,
  ]);
  rmSync(out, { force: true });
  const summary = r.stderr
    .split(/\r?\n/)
    .filter((l) => /resolved|warning|expect|error|strict/.test(l))
    .join("\n  ");
  log(`${label} gate=${gateRel} exit=${r.code}\n  ${summary}`);
  process.stderr.write(r.stderr);
  return r.code;
}

// memory-plan-v1 lowered command shapes (kannaka-hdl src/emit.rs):
//   kannaka remember "<text> (node mN, plan HASH)" --importance F.FF
//   kannaka dream --mode deep   # node mN
function seedCommands(plan, importanceOverride) {
  const dark = new Set(
    (plan.nodes || []).filter((n) => n.resolved == null).map((n) => n.id)
  );
  const seeds = [];
  for (const cmd of plan.commands || []) {
    const rem = cmd.match(/^kannaka remember "(.+)" --importance ([0-9.]+)$/);
    if (rem) {
      const node = [...dark].find((id) => rem[1].includes(`(node ${id},`));
      if (!node) continue; // resolved anchors are never re-seeded
      const importance = importanceOverride ?? Number(rem[2]);
      seeds.push({ node, args: ["remember", rem[1], "--importance", importance.toFixed(2)] });
      continue;
    }
    const dream = cmd.match(/^kannaka dream --mode (\w+)\s+# node (m\d+)$/);
    if (dream && dark.has(dream[2])) {
      seeds.push({ node: dream[2], args: ["dream", "--mode", dream[1]] });
    }
  }
  return seeds;
}

function runProvision(appDir, manifest, variant, dryRun) {
  const run = { ...manifest.run };
  if (variant) {
    const alt = manifest.variants?.[variant];
    if (!alt) die(`variant "${variant}" not in [variants]`);
    run.seed = alt;
  }
  if (!run.seed || !run.gate) die(`provision mode requires [run] seed and gate`);
  const seedVia = run.seed_via ?? "cli";
  if (seedVia !== "cli") {
    die(
      `seed_via = "${seedVia}" is not implemented. Only "cli" exists; on ` +
        `single-writer nodes (witness) seeding must go through the owning ` +
        `service's write path — refusing to guess (ADR-0001 §5).`
    );
  }

  const name = manifest.app.name;
  if (runGate(appDir, run.gate, `${name} pre`) === 0) {
    console.error(`${name}: gate already passes — nothing to provision`);
    return 0;
  }

  const planFile = scratchFile("seed-plan.json");
  const grow = runCapture(HDL, [
    "grow", join(appDir, run.seed),
    "--memory-provider", KAN,
    "--unresolved", "speculative",
    "--emit", "memory",
    "--out", planFile,
  ]);
  process.stderr.write(grow.stderr);
  if (grow.code !== 0) {
    log(`${name} seed-grow FAILED exit=${grow.code}`);
    die(`seed program failed to grow (exit ${grow.code})`, grow.code);
  }
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  rmSync(planFile, { force: true });

  const seeds = seedCommands(plan, run.seed_importance);
  if (seeds.length === 0) {
    log(`${name} gate fails but seed plan has no dark anchors — floors disagree?`);
    console.error(
      `${name}: gate fails yet nothing to seed. Gate and seed programs ` +
        `disagree about what "dark" means — fix the app, not the memory.`
    );
    return 1;
  }

  console.error(`${name}: seeding ${seeds.length} dark anchor(s) via ${KAN}`);
  for (const s of seeds) {
    console.error(`  ${s.node}: kannaka ${s.args.join(" ")}`);
    if (dryRun) continue;
    const r = runCapture(KAN, s.args);
    log(`${name} seed ${s.node} exit=${r.code} args=${JSON.stringify(s.args)}`);
    if (r.code !== 0) {
      process.stderr.write(r.stderr);
      die(`seed command failed on ${s.node} (exit ${r.code})`, r.code);
    }
  }
  if (dryRun) {
    console.error(`${name}: dry run — no seeds executed, gate not re-run`);
    return 0;
  }

  const verdict = runGate(appDir, run.gate, `${name} post`);
  console.error(
    verdict === 0
      ? `${name}: provisioned — gate now passes`
      : `${name}: seeded but gate STILL fails (exit ${verdict}) — one round is the bound, investigate before re-running`
  );
  return verdict;
}

// --- schedule mode (ADR-0002: research scheduler) -------------------------
//
// Closes the kannaka-hdl §14 loop: sweep the store's programs for unresolved
// queries (capability demand), rank by how many programs each blocks, emit
// crystal work orders onto the swarm queue, and attribute resolved flips to
// the order that requested them. The scheduler only ENQUEUES — crystal work
// executes in the crystal lane, never here.

function statePath() {
  return process.env.KHDL_SCHEDULER_STATE ||
    join(homedir(), ".kannaka", "research-scheduler.json");
}

// Swarm enqueue needs NATS credentials; crons source ~/.kannaka-nats.env for
// the same reason (anonymous NATS publishes are silently dropped). Merge that
// file into the child env when the shell doesn't already carry creds.
function natsEnv() {
  if (PINNED_ENV.NATS_USER) return PINNED_ENV;
  try {
    const env = { ...PINNED_ENV };
    for (const line of readFileSync(join(homedir(), ".kannaka-nats.env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return env;
  } catch {
    return PINNED_ENV;
  }
}

// `kannaka swarm enqueue` is request-reply: it publishes the task, then waits
// for a WORKER to answer. No crystal-work worker exists yet, so a reply
// timeout after a successful publish still means the order is on the queue.
function enqueueOrder(order) {
  const r = spawnSync(
    KAN,
    ["swarm", "enqueue", "crystal_work_order", JSON.stringify(order), "--timeout", "5"],
    { env: natsEnv(), encoding: "utf8" }
  );
  if (r.error) return { posted: false, why: r.error.message };
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status === 0) return { posted: true, why: "worker replied" };
  if (out.includes("[enqueue] KANNAKA.work.")) {
    return { posted: true, why: "published; no worker reply yet" };
  }
  return { posted: false, why: `exit ${r.status}: ${out.trim().split("\n").pop()}` };
}

function sweepPrograms(storeRoot, appDir, manifest) {
  const programs = [];
  const appsDir = join(storeRoot, "apps");
  for (const name of readdirSync(appsDir)) {
    let m;
    try {
      m = parseToml(readFileSync(join(appsDir, name, "app.toml"), "utf8"));
    } catch {
      continue;
    }
    for (const key of ["entry", "gate", "seed"]) {
      if (m.run?.[key]) {
        programs.push({ app: name, file: join(appsDir, name, m.run[key]) });
      }
    }
    for (const rel of Object.values(m.variants || {})) {
      programs.push({ app: name, file: join(appsDir, name, rel) });
    }
  }
  const demandRel = manifest.run.demand_dir || "demand";
  const demandDir = join(appDir, demandRel);
  try {
    for (const f of readdirSync(demandDir)) {
      if (f.endsWith(".khdl")) {
        programs.push({ app: `${manifest.app.name}/${demandRel}`, file: join(demandDir, f) });
      }
    }
  } catch {
    // no demand dir — sweep is just the store apps
  }
  // A program may be referenced twice (e.g. preflight default = a variant);
  // dedupe by absolute path.
  const seen = new Set();
  return programs.filter((p) => !seen.has(p.file) && seen.add(p.file));
}

function harvestDemand(program) {
  const out = scratchFile(`sweep-${program.app.replace(/[\\/]/g, "_")}.json`);
  const r = runCapture(HDL, [
    "grow", program.file,
    "--memory-provider", KAN,
    "--unresolved", "speculative",
    "--emit", "json",
    "--out", out,
  ]);
  const requests = [];
  if (r.code === 0) {
    try {
      const plan = JSON.parse(readFileSync(out, "utf8"));
      for (const req of plan.discovery_requests || []) {
        requests.push({
          domain: req.domain,
          class: req.class,
          component_type: req.component_type,
          constraints: req.constraints,
          plan_hash: plan.plan_hash,
        });
      }
    } catch (e) {
      log(`schedule: unparseable plan for ${program.file}: ${e.message}`);
    }
  } else {
    // Expect-gated programs refuse to emit while failing ("nothing emitted"),
    // but their unresolved anchors ARE demand — harvest from the warnings.
    const warn = /warning: (\w+): no component \(class "(.+?)", min_persistence ([0-9.eE+-]+), min_noise_tolerance ([0-9.eE+-]+)/g;
    for (const m of r.stderr.matchAll(warn)) {
      requests.push({
        domain: "unknown",
        class: m[2],
        component_type: null,
        constraints: { min_persistence: Number(m[3]), min_noise_tolerance: Number(m[4]), material: null },
        plan_hash: null,
        degraded: true,
      });
    }
  }
  rmSync(out, { force: true });
  return { grewClean: r.code === 0, requests };
}

function runSchedule(appDir, manifest, dryRun) {
  const storeRoot = resolve(join(appDir, "..", ".."));
  const maxOrders = manifest.run.max_orders ?? 3;
  const programs = sweepPrograms(storeRoot, appDir, manifest);
  console.error(`research-scheduler: sweeping ${programs.length} program(s)`);

  // 1-2. Collect demand across every program.
  const backlog = new Map(); // key = domain|class
  const cleanPrograms = new Set();
  for (const p of programs) {
    const { grewClean, requests } = harvestDemand(p);
    if (grewClean) cleanPrograms.add(p.app + ":" + p.file);
    for (const req of requests) {
      const key = `${req.domain}|${req.class}`;
      const entry = backlog.get(key) || {
        key, domain: req.domain, class: req.class,
        component_type: req.component_type,
        constraints: { min_persistence: 0, min_noise_tolerance: 0, material: null },
        requesters: [],
      };
      entry.requesters.push({ app: p.app, file: p.file, plan_hash: req.plan_hash });
      entry.constraints.min_persistence = Math.max(entry.constraints.min_persistence, req.constraints.min_persistence || 0);
      entry.constraints.min_noise_tolerance = Math.max(entry.constraints.min_noise_tolerance, req.constraints.min_noise_tolerance || 0);
      entry.constraints.material = entry.constraints.material || req.constraints.material;
      backlog.set(key, entry);
    }
  }

  // 3. Rank: blocked-plan count first, floor stringency as tiebreak.
  const ranked = [...backlog.values()].sort((a, b) =>
    b.requesters.length - a.requesters.length ||
    (b.constraints.min_persistence + b.constraints.min_noise_tolerance) -
    (a.constraints.min_persistence + a.constraints.min_noise_tolerance)
  );

  // 4. State: attribution across runs.
  let state = { requests: {}, orders: [] };
  try {
    state = JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    // first run
  }
  const now = new Date().toISOString();

  // 5. Flips: previously-demanded, now absent from the backlog → resolved.
  for (const [key, rec] of Object.entries(state.requests)) {
    if (!backlog.has(key) && !rec.resolved_at) {
      rec.resolved_at = now;
      const via = rec.order_id ? ` (attributed to order ${rec.order_id})` : " (no order issued)";
      console.error(`research-scheduler: RESOLVED ${key}${via}`);
      log(`schedule RESOLVED ${key}${via}`);
    }
  }
  for (const entry of ranked) {
    const rec = state.requests[entry.key] || { first_seen: now };
    rec.last_seen = now;
    rec.blocked_plans = entry.requesters.length;
    delete rec.resolved_at; // demand is back (or still) live
    state.requests[entry.key] = rec;
  }

  // 6. Orders for the top of the backlog. Memory-domain demand is recall
  // supply (provisioner territory), not crystal-growable — skip it here.
  const orderable = ranked.filter((e) => e.domain !== "memory");
  let issued = 0;
  for (const entry of orderable.slice(0, maxOrders)) {
    const rec = state.requests[entry.key];
    if (rec.order_id) continue; // one standing order per request
    const orderId = `rs-${Date.now().toString(36)}-${issued}`;
    const order = {
      order_type: "crystal_work_order",
      order_id: orderId,
      domain: entry.domain,
      class: entry.class,
      component_type: entry.component_type,
      constraints: entry.constraints,
      blocked_plans: entry.requesters.length,
      attributions: entry.requesters.map((r) => `${r.app}:${r.plan_hash ?? "unsealed"}`),
      suggested_procedure:
        "kannaka-crystal evolve toward this class, then promote --procedure replicate; " +
        "behavior contracts (promote --procedure behavior) once L2",
      issued_at: now,
      issued_by: "kannaka-apps/research-scheduler",
    };
    console.error(`research-scheduler: order ${orderId} → ${entry.domain}.${entry.class} (blocks ${entry.requesters.length} plan(s))`);
    if (!dryRun) {
      const { posted, why } = enqueueOrder(order);
      order.enqueued = posted;
      order.enqueue_note = why;
      if (!posted) {
        console.error(`  enqueue failed (${why}) — order recorded locally only`);
        log(`schedule enqueue FAILED ${orderId}: ${why}`);
      } else {
        console.error(`  enqueued (${why})`);
      }
    } else {
      order.enqueued = false;
      order.dry_run = true;
    }
    rec.order_id = orderId;
    state.orders.push(order);
    issued++;
  }

  // 7. Report + persist.
  console.error(
    `research-scheduler: backlog ${ranked.length} (memory-domain ${ranked.length - orderable.length}), ` +
    `orders issued ${issued}, programs clean ${cleanPrograms.size}/${programs.length}`
  );
  for (const e of ranked) {
    console.error(`  ${String(e.requesters.length).padStart(2)}x ${e.domain}.${e.class}`);
  }
  if (!dryRun) {
    mkdirSync(join(homedir(), ".kannaka"), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
  }
  return 0;
}

function runApp(appDir, opts) {
  const manifest = loadManifest(appDir);
  const mode = manifest.run.mode;
  if (mode === "gate") {
    let entry = manifest.run.entry;
    if (opts.variant) {
      entry = manifest.variants?.[opts.variant];
      if (!entry) die(`variant "${opts.variant}" not in [variants]`);
    }
    if (!entry) die(`gate mode requires [run] entry`);
    return runGate(appDir, entry, manifest.app.name);
  }
  if (mode === "provision") {
    return runProvision(appDir, manifest, opts.variant, opts.dryRun);
  }
  if (mode === "schedule") {
    return runSchedule(appDir, manifest, opts.dryRun);
  }
  die(`unknown [run] mode "${mode}" (gate | provision | schedule)`);
}

function listStore(root) {
  let index;
  try {
    index = JSON.parse(readFileSync(join(root, "store", "index.json"), "utf8"));
  } catch (e) {
    die(`store index unreadable: ${e.message}`);
  }
  for (const app of index.apps) {
    console.log(
      `${app.name.padEnd(20)} ${String(app.version).padEnd(8)} ${app.kind.padEnd(10)} ${app.description}`
    );
  }
  return 0;
}

// --- entry -----------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (cmd === "run") {
  const opts = { variant: null, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--variant") opts.variant = argv[++i];
    else if (argv[i] === "--dry-run") opts.dryRun = true;
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) die("usage: khdl-app run <app-dir> [--variant N] [--dry-run]");
  process.exit(runApp(resolve(rest[0]), opts));
} else if (cmd === "list") {
  // Default store root: this script lives in <root>/runtime/.
  process.exit(listStore(resolve(argv[0] || join(import.meta.dirname, ".."))));
} else {
  die("usage: khdl-app <run|list> …");
}
