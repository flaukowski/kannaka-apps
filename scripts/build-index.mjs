#!/usr/bin/env node
// Regenerate store/index.json from apps/*/app.toml (ADR-0001 §6).
// Deterministic: sorted by name, no timestamps — CI diffs it.
//
//   node scripts/build-index.mjs           # write store/index.json
//   node scripts/build-index.mjs --check   # exit 1 if committed index is stale

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const INDEX = join(ROOT, "store", "index.json");

// Same deliberate TOML subset as the runner (ADR-0001 §2).
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
    if (!kv || !section) throw new Error(`cannot parse line: ${raw}`);
    let value = kv[2].trim();
    const str = value.match(/^"(.*)"$/);
    value = str ? str[1] : Number.isNaN(Number(value)) ? value : Number(value);
    doc[section][kv[1]] = value;
  }
  return doc;
}

const apps = [];
for (const entry of readdirSync(join(ROOT, "apps"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = parseToml(
    readFileSync(join(ROOT, "apps", entry.name, "app.toml"), "utf8")
  );
  const { name, version, description, kind } = manifest.app;
  if (name !== entry.name) {
    console.error(`apps/${entry.name}: manifest name "${name}" must match directory`);
    process.exit(1);
  }
  apps.push({
    name,
    version,
    description,
    kind,
    path: `apps/${entry.name}`,
    source: "store", // graduated apps become {source: "external", git: url}
    variants: Object.keys(manifest.variants || {}),
  });
}
apps.sort((a, b) => a.name.localeCompare(b.name));

const index = { schema: "kannaka-apps-index-v1", apps };
const rendered = JSON.stringify(index, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const committed = readFileSync(INDEX, "utf8");
  if (committed !== rendered) {
    console.error("store/index.json is stale — run: node scripts/build-index.mjs");
    process.exit(1);
  }
  console.log(`index fresh: ${apps.length} app(s)`);
} else {
  writeFileSync(INDEX, rendered);
  console.log(`wrote store/index.json: ${apps.length} app(s)`);
}
