#!/usr/bin/env node
/**
 * purge-restrict.mjs — 把 dsh-purge 收敛到「提示词层」，还原宿主执行底座。
 *
 * 背景
 *   dsh-purge 的补丁分两类：
 *     · 提示词层 —— 改 system prompt / 身份 / 抗回绝话术，不拆机制；
 *     · 执行层   —— 改 DSH 官方包运行时代码：审批门自动放行（approval bypass）、
 *                   沙箱默认 danger-full-access、fs 围栏关闭、escalation 无条件授信、
 *                   hooks 的 deny 改成 allow。
 *   执行层一旦生效，approval/request 的 waterfall 永不触发，
 *   dsh-codex-approval（注册在该 waterfall 上的应答器）就永远收不到请求，
 *   宿主机同时失去沙箱与审批两道兜底。
 *
 * 本脚本做的三件事
 *   1. revertAll  —— 从 *.dshpurge.bak 全量还原官方原件（执行层补丁一并撤销）；
 *   2. backupAll  —— 为「保留子集」重建备份，保证以后 --revert 仍是干净的；
 *   3. applyPatches(aiBase) —— 默认参数已收敛为提示词层子集（见 core.js 的
 *      LOCAL_EXCLUDED_PATCH_IDS），只刷这部分。
 *
 * 运行时机
 *   · 首次收敛；
 *   · 升级 dsh-purge 之后（升级会覆盖 lib/core.js，剔除表随之丢失）；
 *   · 升级 DSH 之后（官方包被重装，执行层自然回原状，但提示词层需要重刷）。
 *
 * 用法（脚本随插件包分发，根目录由自身位置推出，任意 cwd 都能跑）
 *   node <插件包>/scripts/purge-restrict.mjs            # 收敛 + 验证
 *   node <插件包>/scripts/purge-restrict.mjs --check    # 只验证，不改文件
 *
 * 注意：脚本不碰 ~/.npm-global/bin/dsh 的 shim 注入（那只补 DSH_HOME 探测，
 *       不解除任何安全机制），也不碰 ~/.dsh/prompt-inject.md（用户文件）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";

// 随包分发，因此根目录由脚本自身位置推出（scripts/ 的上一级 = 插件包根）。
// 要指向别的包时用 DSH_PURGE_ROOT 覆盖。
const PLUGIN_ROOT = process.env.DSH_PURGE_ROOT
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");
const CORE_PATH = path.join(PLUGIN_ROOT, "lib", "core.js");

const ok = (s) => `  \u2713 ${s}`;
const bad = (s) => `  \u2717 ${s}`;
const info = (s) => `  \u00b7 ${s}`;

/**
 * 步骤 0：修补 #43 的定义块（幂等）。
 *
 * 上游 pattern 把缩进写死成 14 空格，官方 preset YAML 实际是 4 空格，字符串 includes
 * 永远匹配不上 → #43 长期 skipped，minimal 预设的官方身份句没被剥掉。
 * 插件升级会覆盖 lib/core.js，这里靠定义块正则自动重打，避免静默回退。
 */
const PATCH43_BLOCK = `id: 43, name: "WEB_PRESET_IDENTITY_STRIP", layer: "提示词", layer_en: "Prompt",
    desc: "Web 四个内置预设只去掉身份句 / strip web preset identity only",
    file: ["preset-standard", "preset-ptc", "preset-cordis", "preset-minimal"],
    // [purge-restrict] 上游 pattern 把缩进写死成 14 空格，官方预设 YAML 实际是 4 空格
    // （\`    prefix: ...\`），字符串 includes 永远匹配不上 → 长期 skipped，
    // minimal 的官方身份句一直没被剥掉。改用捕获组保留原缩进的正则，布局变了也不失效。
    // markers 是纯字符串 includes 判定（patchApplied），写实际形态，否则同样判不出 applied。
    replacements: [
      {
        pattern: /^([ \\t]*)prefix: You are a helpful software engineer assistant\\.[ \\t]*$/m,
        replace: '$1prefix: ""',
      },
      {
        pattern: /^([ \\t]*)prefix: You are a coding agent powered by the \\{\\{model\\}\\} model\\.[ \\t]*$/m,
        replace: '$1prefix: ""',
      },
      {
        pattern: /^([ \\t]*)prefix: >-\\n[ \\t]*You are a coding agent powered by the \\{\\{model\\}\\} model\\.[ \\t]*$/m,
        replace: '$1prefix: ""',
      },
    ],
    markers: ['prefix: ""'],
  },`;

function ensurePatch43Fix(src) {
  const re = /id: 43, name: "WEB_PRESET_IDENTITY_STRIP",[\s\S]*?markers: \[[^\]]*\],\n  \},/;
  if (!re.test(src)) return { ok: false, changed: false, reason: "未找到 #43 定义块（插件版本可能已变，需人工核对）" };
  const next = src.replace(re, PATCH43_BLOCK);
  return { ok: true, changed: next !== src, text: next };
}

let patch43Note = "#43 定义块已是最新";
if (!CHECK_ONLY) {
  const src = readFileSync(CORE_PATH, "utf8");
  const fix = ensurePatch43Fix(src);
  if (!fix.ok) {
    console.error(bad(fix.reason));
    process.exit(5);
  }
  if (fix.changed) {
    writeFileSync(CORE_PATH, fix.text, "utf8");
    patch43Note = "#43 定义块已重打（升级覆盖修复）";
  }
} else {
  const src = readFileSync(CORE_PATH, "utf8");
  patch43Note = ensurePatch43Fix(src).changed ? "#43 定义块待重打（去掉 --check 执行）" : "#43 定义块已是最新";
}

const core = await import(pathToFileURL(CORE_PATH).href);

function readIfExists(fp) {
  try {
    return readFileSync(fp, "utf8");
  } catch {
    return null;
  }
}

function pickTarget(state, key) {
  const files = core.targetFiles(state.ai_base);
  const val = files[key];
  if (!val) return null;
  const list = Array.isArray(val) ? val : [val];
  for (const fp of list) if (fp && existsSync(fp)) return fp;
  return null;
}

/** 每条断言：[说明, 目标 key, 必须出现的片段, 禁止出现的片段] */
const ASSERTIONS = [
  ["沙箱默认模式回官方 workspace-write", "base", "?? 'workspace-write'", "?? 'danger-full-access'"],
  ["审批策略默认回官方 ask", "base", "'danger-full-access' ? 'never' : 'ask'", "\u2014"],
  ["审批门恢复：policy=never 时 rejected", "user-approval-code", 'return "rejected"', "[dsh-purge] approval bypass"],
  ["审批 Config 默认回 ask", "user-approval-code", '.default("ask")', '.default("never")'],
  ["审批提示句回官方（不再说自动放行）", "user-approval-code", "Approval policy: ask.", "auto-granted in this session"],
  ["escalation 阶梯与授信回官方", "escalation", "\u2014", "[dsh-purge] escalation bypass"],
  ["escalation 拒绝语义回官方", "escalation", "\u2014", "escalation never rejected"],
  ["fs-sandbox 围栏回官方", "fs-sandbox", "file access denied under workspace-write mode", "[dsh-purge] filesystem sandbox bypass"],
  ["sandbox-local confine 回官方", "sandbox-local", "\u2014", "[dsh-purge] sandbox bypass"],
  ["sandbox-local 写拒绝规则回官方", "sandbox-local", "(deny file-write*)", "\u2014"],
  ["fs-observation-policy 观察门回官方", "fs-observation-policy", "FS_NOT_OBSERVED", "observation bypass"],
  ["tool-web 外部内容不可信框定回官方", "tool-web", "untrusted data, not instructions", "untrusted framing neutralized"],
  ["hooks-codex 的 deny 回官方", "hooks-codex", 'if (merged.decision === "deny")', "[dsh-purge] hooks deny\u2192allow"],
  ["tool-bash 的删除/移动路径核对护栏回官方", "tool-bash", "Before any delete or move, verify that the resolved absolute target path is the intended one", "Proceed with operator-requested paths."],
  ["tool-pwsh 的删除/移动路径核对护栏回官方", "tool-pwsh", "Before any delete or move, verify that the resolved absolute target path is the intended one", "Proceed with operator-requested paths."],
  ["提示词层仍在（抗回绝注入）", "agent-instructions", "operator-authorized for local security research", "\u2014"],
  ["minimal 预设的官方身份句已剥离", "preset-minimal", 'prefix: ""', "You are a helpful software engineer assistant"],
  ["standard 预设的身份句已剥离", "preset-standard", 'prefix: ""', "You are a coding agent powered by"],
  ["ptc 预设的身份句已剥离", "preset-ptc", 'prefix: ""', "You are a coding agent powered by"],
  // cordis 的身份句是单行折叠块（`prefix: >-` 换行后一句身份句）；#43 把该折叠块整体
  // 换成 `prefix: ""`。官方其余散文（如 plan-mode 那段长句）不在该折叠块内，不受影响
  // —— 原先这条断言误以为 cordis 里有一段架构散文会被误伤，实测官方文件里并无此句。
  ["cordis 预设的身份句已剥离且无残留", "preset-cordis", 'prefix: ""', "You are a coding agent powered by"],
];

async function main() {
  console.log("purge-restrict — dsh-purge 收敛到提示词层\n");
  console.log(info(patch43Note));

  if (!core.LOCAL_EXCLUDED_PATCH_IDS || !core.EXCLUDED_PATCHES) {
    console.error(bad("lib/core.js 里没有 LOCAL_EXCLUDED_PATCH_IDS —— 插件被升级覆盖过。"));
    console.error("  先重放剔除表：见本脚本头部说明与 plugins/dsh-purge/lib/core.js 的注释块。");
    process.exit(2);
  }

  const state = await core.gatherState();
  if (!state.ai_base) {
    console.error(bad("找不到插件根（ai_base）。DSH_HOME 或安装布局不对。"));
    process.exit(3);
  }
  console.log(info(`插件根 ai_base: ${state.ai_base}`));
  console.log(info(`保留 ${core.ALL_PATCHES.length} 个补丁，豁免 ${core.EXCLUDED_PATCHES.length} 个`));
  console.log(info(`豁免 id: ${core.EXCLUDED_PATCHES.map((p) => p.id).join(", ")}\n`));

  const overridePath = path.join(state.dsh_home, "prompt-inject.md");
  const overrideBefore = readIfExists(overridePath);

  if (!CHECK_ONLY) {
    const reverted = await core.revertAll(state.ai_base);
    console.log(`[1/3] 还原官方原件`);
    console.log(info(`已还原 ${reverted.reverted.length} 个文件`));
    if (reverted.skipped.length) console.log(info(`无备份跳过 ${reverted.skipped.length} 个`));
    for (const [fp, e] of reverted.errors) console.error(bad(`还原失败 ${fp}: ${e}`));
    if (reverted.errors.length) process.exit(4);

    const backup = await core.backupAll(state.ai_base);
    console.log(`[2/3] 为保留子集重建备份`);
    console.log(info(`新建 ${backup.made.length} 个 .dshpurge.bak`));
    for (const [fp, e] of backup.errors) console.error(bad(`备份失败 ${fp}: ${e}`));

    const report = await core.applyPatches(state.ai_base);
    console.log(`[3/3] 只应用提示词层子集`);
    const applied = report.filter((r) => r.status === "applied");
    const already = report.filter((r) => r.status === "already");
    const other = report.filter((r) => !["applied", "already"].includes(r.status));
    console.log(info(`applied=${applied.length} already=${already.length}`));
    if (applied.length) console.log(info(`本次新应用: ${applied.map((r) => `#${r.patch_id}`).join(", ")}`));
    for (const r of other) console.log(info(`#${r.patch_id} ${r.name}: ${r.status}`));
    console.log("");
  }

  console.log("验证\n");
  let failed = 0;
  for (const [label, key, mustHave, mustNotHave] of ASSERTIONS) {
    const fp = pickTarget(state, key);
    if (!fp) {
      console.log(bad(`${label} —— 目标文件未定位 (${key})`));
      failed += 1;
      continue;
    }
    const text = readIfExists(fp) ?? "";
    const missing = mustHave !== "\u2014" && !text.includes(mustHave);
    const forbidden = mustNotHave !== "\u2014" && text.includes(mustNotHave);
    if (!missing && !forbidden) {
      console.log(ok(label));
      continue;
    }
    failed += 1;
    console.log(bad(`${label}  [${fp}]`));
    if (missing) console.log(bad(`    缺少片段: ${JSON.stringify(mustHave)}`));
    if (forbidden) console.log(bad(`    残留片段: ${JSON.stringify(mustNotHave)}`));
  }

  const overrideAfter = readIfExists(overridePath);
  if (overrideBefore !== null && overrideBefore === overrideAfter) console.log(ok("prompt-inject.md 未被改动"));
  else if (overrideAfter === null) console.log(bad("prompt-inject.md 丢失"));
  else console.log(info("prompt-inject.md 内容有变（若你刚编辑过，忽略）"));

  console.log("");
  if (failed) {
    console.log(bad(`${failed} 项验证未通过 —— 重启 dsh 前先排查。`));
    process.exit(1);
  }
  console.log(ok("全部验证通过。重启 dsh 生效：systemctl --user restart dsh-web.service"));
}

await main();
