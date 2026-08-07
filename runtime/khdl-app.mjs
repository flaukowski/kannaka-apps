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
import { readFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
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
  die(`unknown [run] mode "${mode}" (gate | provision)`);
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
