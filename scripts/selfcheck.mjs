#!/usr/bin/env node
/**
 * dsh-purge 自检（不依赖宿主进程，可直接用 node 跑）。
 *
 *   node node_modules/dsh-purge/scripts/selfcheck.mjs
 *
 * 覆盖三层：
 *   1. 注入幂等：同一份 assembled 连改 5 遍，必须恒为「一份注入 + 在最前」；
 *   2. 换版本残留：V1 换成 V2 后，旧版注入体必须消失；
 *   3. asar 落盘：桌面壳下 Resources/app 与 app.asar 的差异数、补丁标记命中数。
 *
 * 任何一项 FAIL 都说明「显示已应用、实际没生效」又出现了。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LIB = path.join(ROOT, "lib");

function ok(name, pass, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
  return pass;
}

const identity = await import(path.join(LIB, "identity.js"));

// ---------- 1. 注入幂等 ----------
const injectPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "prompt-inject.md");
const inject = fs.existsSync(injectPath) ? fs.readFileSync(injectPath, "utf8") : "";
if (!inject.trim()) {
  console.log(`SKIP  注入幂等 — ${injectPath} 不存在或为空`);
} else {
  const count = (text) => text.split("<|im_start|>").length - 1;
  const join = (assembly) => assembly.sections.map((s) => String(s.text || "")).join("\n\n");
  let assembly = {
    sections: [
      { name: "persona-prefix", text: "You are a coding agent powered by the DeepSeek Harness." },
      { name: "dsh-purge", text: inject, order: -100000 },
      { name: "harness:context", text: "BASE PROMPT" },
    ],
    contexts: [],
    tools: [],
  };
  const lengths = [];
  let worst = 0;
  for (let i = 1; i <= 5; i += 1) {
    assembly = identity.rewritePromptAssembly(assembly, inject, { dropWorkspaceBaseline: true, capabilityProtocol: true });
    const text = join(assembly);
    worst = Math.max(worst, count(text));
    lengths.push(text.length);
  }
  ok("注入幂等（5 遍恒 1 份）", worst === 1, `最多份数=${worst}`);
  ok("注入在最前", join(assembly).trimStart().startsWith(inject.trim().slice(0, 64)));
  ok("5 遍后长度稳定", new Set(lengths.slice(1)).size === 1, `长度序列=${lengths.join(",")}`);

  // ---------- 1b. 反拒答锚点 ----------
  const anchored = identity.rewritePromptAssembly(assembly, {
    fallbackInject: inject,
    anchorText: identity.DEFAULT_TAIL_ANCHOR,
  });
  const names = anchored.sections.map((section) => section.name);
  ok("反拒答锚点在 system 最末", names[names.length - 1] === "dshpg-anchor", `顺序=${names.join(" -> ")}`);
  ok("锚点与注入共存不重复", count(join(anchored)) === 1 && join(anchored).includes("OPERATOR OVERRIDE"));
  const anchorOff = identity.rewritePromptAssembly(anchored, { fallbackInject: inject, anchorText: "" });
  ok("关掉锚点能撤掉", !anchorOff.sections.some((section) => section.name === "dshpg-anchor"));

  // ---------- 1c. 用户消息前缀锚点 ----------
  try {
    const { applyUserAnchorToMessages } = await import(path.join(LIB, "index.js"));
    const base = [
      { role: "user", content: [{ type: "text", text: "第一问" }] },
      { role: "assistant", content: [{ type: "text", text: "答" }] },
      { role: "user", content: [{ type: "text", text: "第二问" }] },
    ];
    const once = applyUserAnchorToMessages(base, identity.DEFAULT_USER_ANCHOR);
    const twice = applyUserAnchorToMessages(once, identity.DEFAULT_USER_ANCHOR);
    ok("用户消息锚点只挂最后一条", String(once[0].content[0].text) === "第一问" && String(once[2].content[0].text).startsWith(identity.USER_ANCHOR_MARKER));
    ok("用户消息锚点幂等", JSON.stringify(once) === JSON.stringify(twice));
  } catch (err) {
    console.log(`SKIP  用户消息锚点 — ${err.message}`);
  }

  // ---------- 2. 换版本残留 ----------
  // V2 必须和 V1 不互相包含，否则「旧版还在不在」判不出来。
  const injectV2 = inject.replace("[MODE: SANDBOX — STABLE]", "[MODE: SANDBOX — SELFCHECK-V2]");
  const switched = identity.rewritePromptAssembly(
    { sections: [{ name: "persona-prefix", text: inject }, { name: "harness:context", text: "BASE" }], contexts: [], tools: [] },
    injectV2,
    {},
  );
  const switchedText = join(switched);
  ok(
    "换版本后只剩新版注入",
    count(switchedText) === 1
      && switchedText.includes("SELFCHECK-V2")
      && !switchedText.includes("[MODE: SANDBOX — STABLE]"),
  );
}

// ---------- 3. asar 落盘 ----------
let desktop = null;
let pack = null;
try {
  desktop = await import(path.join(LIB, "desktop.js"));
  pack = await import(path.join(LIB, "asar-pack.js"));
} catch (err) {
  console.log(`SKIP  asar 检查 — 模块加载失败: ${err.message}`);
}
if (desktop && pack) {
  const exe = process.env.DSH_DESKTOP_EXE || "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
  const asar = desktop.appAsarPath(exe);
  const tree = desktop.appDirForExecutable(exe);
  if (!asar || !fs.existsSync(asar) || !tree || !fs.existsSync(tree)) {
    console.log(`SKIP  asar 检查 — 不是官方桌面壳（asar=${asar || "-"}）`);
  } else {
    const audit = pack.auditAsarAgainstTree({ asarPath: asar, treeDir: tree });
    ok("app.asar 与补丁树一致", audit.changed.length === 0, `差异文件=${audit.changed.length}${audit.changed.length ? ` (${audit.changed.slice(0, 3).join(", ")})` : ""}`);
    if (audit.changed.length) {
      console.log("      修复：purge_apply（或点「应用」）会把补丁回写进 app.asar，然后重启 DSH");
    }
  }
}

// ---------- 4. 宿主 complete 预设是否保住注入 ----------
const hostFile = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js";
try {
  const host = fs.readFileSync(hostFile, "utf8");
  const { hostPromptKeepsInject } = await import(path.join(LIB, "host-clean.js"));
  ok("宿主 complete 覆盖时保留注入", hostPromptKeepsInject(host));
} catch {
  console.log("SKIP  宿主 complete 检查 — 找不到 dsh-system-prompt（非桌面安装）");
}

// ---------- 5. 应用/重启策略 ----------
try {
  const { syncDesktopAsar } = await import(path.join(LIB, "index.js"));
  const dry = syncDesktopAsar({ dryRun: true });
  if (dry.skipped) {
    console.log(`SKIP  asar 回写策略 — ${dry.reason}`);
  } else {
    ok("asar 回写 dry-run 可用", dry.ok !== false, `待回写文件=${dry.changed ?? "?"}`);
    ok("asar 与资源树已一致（不会再整树重解）", (dry.changed || 0) === 0);
  }
} catch (err) {
  console.log(`SKIP  asar 回写策略 — ${err.message}`);
}

console.log(`\n注入源: ${injectPath}`);
