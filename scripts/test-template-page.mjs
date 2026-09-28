import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch, RedteamStore } from "../lib/redteam/store-core.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tpl-"));
const templates = path.join(root, "templates");
fs.mkdirSync(path.join(templates, ".github"), { recursive: true });
fs.mkdirSync(path.join(templates, "http"), { recursive: true });
fs.writeFileSync(path.join(templates, ".github", "auto.yml"), "name: nope\n");
fs.writeFileSync(
  path.join(templates, "http", "cve.yml"),
  "id: x\ninfo:\n  name: CVE-2024-1 demo\n  severity: high\n  tags: cve\n",
);

const prev = process.env.NUCLEI_TEMPLATES_DIR;
process.env.NUCLEI_TEMPLATES_DIR = templates;
let store;
try {
  store = new RedteamStore(path.join(root, "rt"));
  const page = store.searchTemplates("", 40, 0);
  assert.equal(page.total, 2);
  assert.equal(page.matched, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].name, "CVE-2024-1 demo");
  assert.equal(page.items[0].severity, "high");
  const found = store.searchTemplates("CVE-2024-1");
  assert.equal(found.items.length, 1);
  const hidden = store.searchTemplates("nope");
  assert.equal(hidden.items[0].path.replace(/\\/g, "/"), ".github/auto.yml");
  const listed = dispatch(store, { op: "pocSearch", templateLimit: 40, templateOffset: 0 });
  assert.equal(listed.ok, true);
  assert.equal(listed.templates.items.length, 1);
  assert.equal(listed.templates.total, 2);
  console.log("ok: template page");
} finally {
  try { store?.close(); } catch { /* ignore */ }
  if (prev === undefined) delete process.env.NUCLEI_TEMPLATES_DIR;
  else process.env.NUCLEI_TEMPLATES_DIR = prev;
  fs.rmSync(root, { recursive: true, force: true });
}
