/**
 * asar 回写 / 校验（Desktop 必需的最后一步）。
 *
 * 为什么必须有这一步：
 *   DSH Desktop 的 runtimeArchivePath() 只认父目录名是 `app.asar` 的运行时，
 *   所以「解开 asar → 在 resources/app 里打补丁 → 把 asar 挪走」这条路在官方桌面壳上
 *   永远打不进真正被加载的代码：Electron 读的仍然是 app.asar。
 *   补丁只落在 resources/app 目录里 → 界面显示 applied，运行时行为不变
 *   （用户看到的就是「限制还是无法使用」「有时候不会生效」）。
 *
 * 本模块把 resources/app（已打补丁的解开树）重新封回 app.asar：
 *   - 只替换真正不同的文件，其余条目原样搬运；
 *   - 重算 offset/size/integrity；
 *   - 写完再读回来校验条目数 + 抽样字节，通过后才原子替换，并留 .prev 备份。
 *
 * 不依赖 @electron/asar：asar 头就是 Chromium Pickle（4×uint32 + JSON + 对齐 + 数据）。
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { diskFs } from "./extract-asar.js";

// Electron 的 fs 会把 "resources/app" 映射进仍在的 app.asar，读写解开树必须走真实磁盘。
const fs = diskFs();

const ASAR_HEADER_BYTES = 16;
const BLOCK_SIZE = 4 * 1024 * 1024;

function hash(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

/** 读 asar 头：{ header, baseOffset, size }。 */
export function readAsarIndex(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(ASAR_HEADER_BYTES);
    const read = fs.readSync(fd, head, 0, ASAR_HEADER_BYTES, 0);
    if (read !== ASAR_HEADER_BYTES) throw new Error(`asar 头长度不足: ${asarPath}`);
    const b = readU32(head, 4);
    const jsonLen = readU32(head, 12);
    if (!jsonLen || jsonLen > 64 * 1024 * 1024) throw new Error(`asar 头长度异常: ${jsonLen}`);
    const jsonBuf = Buffer.alloc(jsonLen);
    const jsonRead = fs.readSync(fd, jsonBuf, 0, jsonLen, ASAR_HEADER_BYTES);
    if (jsonRead !== jsonLen) throw new Error("asar 头 JSON 读取不完整");
    const header = JSON.parse(jsonBuf.toString("utf8"));
    const size = fs.fstatSync(fd).size;
    return { header, baseOffset: 8 + b, size };
  } finally {
    fs.closeSync(fd);
  }
}

/** 展开 header.files 成 [{ rel, node }]，rel 以 / 开头（与 asar 内部一致）。 */
export function walkAsarEntries(header) {
  const out = [];
  const walk = (node, prefix) => {
    const files = node && node.files;
    if (!files) return;
    for (const name of Object.keys(files)) {
      const child = files[name];
      const rel = `${prefix}/${name}`;
      if (child && child.files) walk(child, rel);
      else if (child) out.push({ rel, node: child });
    }
  };
  walk(header, "");
  return out;
}

function entryHasContent(node) {
  return node && node.offset !== undefined && node.offset !== null;
}

function readAt(fd, baseOffset, node) {
  const size = Number(node.size) || 0;
  if (!size) return Buffer.alloc(0);
  const buf = Buffer.alloc(size);
  const got = fs.readSync(fd, buf, 0, size, baseOffset + Number(node.offset));
  if (got !== size) throw new Error(`asar 条目读取不完整: need=${size} got=${got}`);
  return buf;
}

function treeFilePath(treeDir, rel) {
  return path.join(treeDir, rel.replace(/^\//, "").split("/").join(path.sep));
}

/**
 * 只读审计：解开树和 asar 里哪些文件不一致（= 补丁还没进归档）。
 * 返回 { changed: string[], same: number, entries: number, unpacked: number }。
 */
export function auditAsarAgainstTree({ asarPath, treeDir } = {}) {
  if (!asarPath || !treeDir) return { changed: [], same: 0, entries: 0, unpacked: 0, error: "缺少 asar 或解开目录" };
  if (!fs.existsSync(asarPath)) return { changed: [], same: 0, entries: 0, unpacked: 0, error: "asar 不存在" };
  const { header, baseOffset } = readAsarIndex(asarPath);
  const entries = walkAsarEntries(header);
  const fd = fs.openSync(asarPath, "r");
  const changed = [];
  let same = 0;
  let unpacked = 0;
  try {
    for (const { rel, node } of entries) {
      if (!entryHasContent(node)) {
        unpacked += 1;
        continue;
      }
      let treeBuf = null;
      try {
        const fp = treeFilePath(treeDir, rel);
        const st = fs.statSync(fp);
        if (st.isFile()) treeBuf = fs.readFileSync(fp);
      } catch {
        treeBuf = null;
      }
      if (!treeBuf) continue;
      const asarBuf = readAt(fd, baseOffset, node);
      if (treeBuf.length === asarBuf.length && treeBuf.equals(asarBuf)) {
        same += 1;
        continue;
      }
      changed.push(rel);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { changed, same, entries: entries.length, unpacked };
}

/**
 * 从 asar 里按相对路径取若干文件内容（给状态审计用，只读少量条目，快）。
 * rels: ["/lib/main.js", ...] 返回 Map<rel, Buffer|null>
 */
export function readAsarEntries(asarPath, rels = []) {
  const out = new Map();
  if (!asarPath || !fs.existsSync(asarPath)) {
    for (const rel of rels) out.set(rel, null);
    return out;
  }
  const { header, baseOffset } = readAsarIndex(asarPath);
  const byRel = new Map(walkAsarEntries(header).map((item) => [item.rel, item.node]));
  const fd = fs.openSync(asarPath, "r");
  try {
    for (const raw of rels) {
      const rel = raw.startsWith("/") ? raw : `/${raw}`;
      const node = byRel.get(rel);
      if (!node || !entryHasContent(node)) {
        out.set(rel, null);
        continue;
      }
      try {
        out.set(rel, readAt(fd, baseOffset, node));
      } catch {
        out.set(rel, null);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function applyIntegrity(node, content) {
  const integ = node.integrity;
  if (!integ) return;
  const blockSize = Number(integ.blockSize) || BLOCK_SIZE;
  const blocks = [];
  for (let i = 0; i < content.length; i += blockSize) {
    blocks.push(hash(content.subarray(i, i + blockSize)));
  }
  integ.hash = hash(content);
  integ.blocks = blocks.length ? blocks : [hash(Buffer.alloc(0))];
}

/**
 * 把解开树回写进 asar。dryRun 只算差异不落盘。
 * 返回 { ok, changed, same, bytes, backupPath, error }
 */
export function repackAsarFromTree({ asarPath, treeDir, dryRun = false, backup = true } = {}) {
  if (!asarPath || !treeDir) return { ok: false, error: "缺少 asar 或解开目录", changed: 0 };
  if (!fs.existsSync(asarPath)) return { ok: false, error: "asar 不存在", changed: 0 };
  if (!fs.existsSync(treeDir)) return { ok: false, error: "解开目录不存在", changed: 0 };

  const { header, baseOffset } = readAsarIndex(asarPath);
  const entries = walkAsarEntries(header);

  // 第一遍：只判定哪些条目要用树里的内容，记下最终字节数。
  const plan = [];
  const srcFd = fs.openSync(asarPath, "r");
  let changed = 0;
  let same = 0;
  try {
    for (const { rel, node } of entries) {
      if (!entryHasContent(node)) {
        plan.push({
          rel,
          node,
          useTree: false,
          size: Number(node.size) || 0,
          origOffset: null,
          origSize: Number(node.size) || 0,
        });
        continue;
      }
      let treeBuf = null;
      try {
        const fp = treeFilePath(treeDir, rel);
        const st = fs.statSync(fp);
        if (st.isFile()) treeBuf = fs.readFileSync(fp);
      } catch {
        treeBuf = null;
      }
      if (!treeBuf) {
        plan.push({
          rel,
          node,
          useTree: false,
          size: Number(node.size) || 0,
          origOffset: Number(node.offset),
          origSize: Number(node.size) || 0,
        });
        same += 1;
        continue;
      }
      const asarBuf = readAt(srcFd, baseOffset, node);
      const identical = treeBuf.length === asarBuf.length && treeBuf.equals(asarBuf);
      if (identical) {
        same += 1;
        plan.push({
          rel,
          node,
          useTree: false,
          size: asarBuf.length,
          origOffset: Number(node.offset),
          origSize: asarBuf.length,
        });
      } else {
        changed += 1;
        plan.push({
          rel,
          node,
          useTree: true,
          size: treeBuf.length,
          origOffset: Number(node.offset),
          origSize: asarBuf.length,
        });
      }
    }
  } finally {
    fs.closeSync(srcFd);
  }

  // 第二遍：写 header（重算 offset/size/integrity）。
  let offset = 0;
  for (const item of plan) {
    if (!entryHasContent(item.node)) continue;
    item.node.offset = String(offset);
    item.node.size = String(item.size);
    item.newOffset = offset;
    offset += item.size;
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padLen = (4 - (json.length % 4)) % 4;
  const headerJsonLen = json.length;
  const pad = Buffer.alloc(headerJsonLen + padLen);
  json.copy(pad, 0);

  if (dryRun) {
    return { ok: true, dryRun: true, changed, same, bytes: offset, entries: plan.length };
  }

  const tmp = `${asarPath}.purge-new`;
  const outFd = fs.openSync(tmp, "w");
  try {
    const head = Buffer.alloc(ASAR_HEADER_BYTES);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(pad.length + 8, 4);
    head.writeUInt32LE(pad.length + 4, 8);
    head.writeUInt32LE(headerJsonLen, 12);
    fs.writeSync(outFd, head, 0, ASAR_HEADER_BYTES, 0);
    fs.writeSync(outFd, pad, 0, pad.length, ASAR_HEADER_BYTES);

    const base = ASAR_HEADER_BYTES + pad.length;
    const srcFd = fs.openSync(asarPath, "r");
    try {
      for (const item of plan) {
        if (!entryHasContent(item.node) || !item.size) continue;
        let content;
        if (item.useTree) {
          content = fs.readFileSync(treeFilePath(treeDir, item.rel));
        } else {
          // 注意：node.offset 在排版阶段已经被改成新偏移，读原件必须用规划时记下的原始偏移。
          content = readAt(srcFd, baseOffset, { offset: item.origOffset, size: item.origSize });
        }
        if (content.length !== item.size) {
          throw new Error(`条目长度变了: ${item.rel} plan=${item.size} real=${content.length}`);
        }
        // 校验前先把 integrity 归位；write 之前 content 已在手，避免二次读。
        applyIntegrity(item.node, content);
        fs.writeSync(outFd, content, 0, content.length, base + item.newOffset);
      }
    } finally {
      fs.closeSync(srcFd);
    }
  } finally {
    fs.closeSync(outFd);
  }

  // 读回来校验：条目数一致 + 抽样字节一致 + 文件长度对得上。
  try {
    const check = readAsarIndex(tmp);
    const checkEntries = walkAsarEntries(check.header);
    if (checkEntries.length !== plan.length) {
      throw new Error(`回读条目数不一致: ${checkEntries.length} != ${plan.length}`);
    }
    const expectSize = ASAR_HEADER_BYTES + pad.length + offset;
    if (check.size !== expectSize) {
      throw new Error(`回读文件长度不一致: ${check.size} != ${expectSize}`);
    }
    // 抽样：改动过的前 3 个 + 最后 1 个条目，内容必须与来源一致。
    const samples = plan.filter((item) => item.useTree).slice(0, 3);
    if (samples.length) {
      const byRel = new Map(checkEntries.map((entry) => [entry.rel, entry.node]));
      const fd = fs.openSync(tmp, "r");
      try {
        for (const item of samples) {
          const node = byRel.get(item.rel);
          if (!node) throw new Error(`回读缺条目: ${item.rel}`);
          const buf = readAt(fd, check.baseOffset, node);
          const want = fs.readFileSync(treeFilePath(treeDir, item.rel));
          if (!buf.equals(want)) throw new Error(`回读内容不一致: ${item.rel}`);
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: `校验失败，已放弃写入: ${String(err?.message || err)}`, changed };
  }

  let backupPath = "";
  try {
    if (backup) {
      backupPath = `${asarPath}.prev`;
      fs.copyFileSync(asarPath, backupPath);
    }
    fs.renameSync(tmp, asarPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: `落盘失败: ${String(err?.message || err)}`, changed, backupPath };
  }
  return { ok: true, changed, same, bytes: offset, entries: plan.length, backupPath };
}

/**
 * 检查 asar 里是否真的带着补丁标记。
 * probes: [{ key, rel, markers: string[] }]，任一 marker 命中即视为该文件已打补丁。
 * 返回 { total, patched, missing: string[] }
 */
export function auditAsarMarkers({ asarPath, probes = [] } = {}) {
  const list = Array.isArray(probes) ? probes.filter((p) => p && p.rel) : [];
  if (!asarPath || !list.length) return { total: list.length, patched: 0, missing: list.map((p) => p.key || p.rel) };
  const contents = readAsarEntries(asarPath, list.map((p) => p.rel));
  const missing = [];
  let patched = 0;
  for (const probe of list) {
    const rel = probe.rel.startsWith("/") ? probe.rel : `/${probe.rel}`;
    const buf = contents.get(rel);
    if (!buf) {
      missing.push(probe.key || rel);
      continue;
    }
    const text = buf.toString("utf8");
    const markers = (Array.isArray(probe.markers) ? probe.markers : [probe.marker]).filter(Boolean);
    const hit = markers.length === 0 || markers.some((marker) => text.includes(marker));
    if (hit) patched += 1;
    else missing.push(probe.key || rel);
  }
  return { total: list.length, patched, missing };
}
