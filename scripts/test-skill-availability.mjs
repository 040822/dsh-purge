import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSkill, expandSkillPath } from "../lib/redteam/skill-availability.js";

const env = { DSH_HOME: "D:\\DeepSeek Harness\\.dsh", PATH: "" };
const expanded = expandSkillPath("~/.dsh/redteam/toolkit/fscan/fscan", env);
assert.equal(expanded.replace(/\//g, "\\"), "D:\\DeepSeek Harness\\.dsh\\redteam\\toolkit\\fscan\\fscan");
assert.ok(!expanded.includes(os.homedir()), "tilde .dsh must follow DSH_HOME, not the OS home");

const missingTool = checkSkill({
  name: "fscan-intranet",
  content: "run $DSH_HOME/redteam/toolkit/fscan/fscan\n",
}, { env });
assert.equal(missingTool.status, "available");
assert.equal(missingTool.problems.length, 0);
assert.ok(missingTool.checked.missing_paths.length > 0);

const fofa = checkSkill({
  name: "fofa-recon",
  content: 'KEY = os.environ["FOFA_KEY"]\n',
}, { env });
assert.equal(fofa.status, "broken");
assert.match(fofa.problems.join("\n"), /FOFA_KEY/);

const vps = checkSkill({
  name: "vps",
  content: "host <你的VPS_IP>\nkey $DSH_HOME/redteam/toolkit/vps/id_rsa\n",
}, { env });
assert.equal(vps.status, "available");
assert.equal(vps.problems.some((p) => p.includes("路径不存在")), false);

const skillDir = path.resolve("skills/redteam");
const broken = [];
for (const file of fs.readdirSync(skillDir).filter((f) => f.endsWith(".md"))) {
  const content = fs.readFileSync(path.join(skillDir, file), "utf8");
  const name = file.replace(/\.md$/, "");
  const verdict = checkSkill({ name, content, path: path.join(skillDir, file) }, { env });
  if (verdict.status !== "available") broken.push(name + " " + verdict.problems.join(" | "));
}
assert.deepEqual(broken.filter((line) => !line.startsWith("fofa-recon")), []);
console.log("ok: skill paths follow DSH_HOME");
console.log(broken.join("\n") || "(no broken skills)");
