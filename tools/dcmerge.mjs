import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class DcParseError extends Error {
  constructor(message, line, column, offset, sourceFile, snippet) {
    super(sourceFile ? `${message} (${sourceFile}:${line}:${column})` : message);
    this.name = 'DcParseError';
    this.code = 'PARSE_ERROR';
    this.line = line;
    this.column = column;
    this.offset = offset;
    this.file = sourceFile ?? null;
    this.snippet = snippet ?? '';
  }
}

export class DcConflictError extends Error {
  constructor(details) {
    const d = details[0];
    super(
      `image 与 build 互斥，不能同时出现：${d.image.file} 第 ${d.image.line} 行声明 image，${d.build.file} 第 ${d.build.line} 行声明 build`
    );
    this.name = 'DcConflictError';
    this.code = 'IMAGE_BUILD_CONFLICT';
    this.details = details;
  }
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function makeLoc(pos, starts, file) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: pos - starts[lo] + 1, offset: pos, file };
}

export function parseJsonc(textInput, sourceFile) {
  const text = textInput.charCodeAt(0) === 0xfeff ? textInput.slice(1) : textInput;
  const starts = lineStarts(text);
  const len = text.length;
  let i = 0;

  const err = (message, at) => {
    const pos = at ?? i;
    const loc = makeLoc(pos, starts, sourceFile);
    const ls = starts[loc.line - 1];
    const le = loc.line < starts.length ? starts[loc.line] - 1 : len;
    const snippet = text.slice(ls, le).replace(/\r$/, '');
    return new DcParseError(message, loc.line, loc.column, pos, sourceFile ?? null, snippet);
  };

  function skipWs() {
    while (i < len) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        i += 2;
        while (i < len && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        i += 2;
        let closed = false;
        while (i < len) {
          if (text[i] === '*' && text[i + 1] === '/') {
            i += 2;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) throw err('注释未闭合');
      } else {
        break;
      }
    }
  }

  function parseString() {
    const start = i;
    i++;
    let out = '';
    while (i < len) {
      const c = text[i];
      if (c === '"') {
        i++;
        return { value: out, start, end: i };
      }
      if (c === '\n') throw err('字符串未闭合', start);
      if (c === '\\') {
        const e = text[i + 1];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e in simple) {
          out += simple[e];
          i += 2;
        } else if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw err('无效的 unicode 转义');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          throw err('无效的转义字符', i + 1 < len ? i + 1 : i);
        }
      } else {
        out += c;
        i++;
      }
    }
    throw err('字符串未闭合', start);
  }

  function parseNumber() {
    const start = i;
    if (text[i] === '-') i++;
    while (i < len && /[0-9]/.test(text[i])) i++;
    if (text[i] === '.') {
      i++;
      while (i < len && /[0-9]/.test(text[i])) i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      while (i < len && /[0-9]/.test(text[i])) i++;
    }
    const raw = text.slice(start, i);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw err('无效的数字', start);
    return { value, start, end: i };
  }

  function parseValue() {
    skipWs();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') {
      const s = parseString();
      return { value: s.value, start: s.start, end: s.end };
    }
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        const after = text[i + word.length];
        if (after === undefined || /[\s,\]}]/.test(after) || after === '/') {
          const start = i;
          i += word.length;
          return { value: word === 'null' ? null : word === 'true', start, end: i };
        }
      }
    }
    throw err(c === undefined ? '意外的文件结束，期待一个值' : '无法识别的符号');
  }
  function parseObject() {
    const start = i;
    i++;
    const value = {};
    const locs = {};
    skipWs();
    if (text[i] === '}') {
      i++;
      return { value, locs, start, end: i };
    }
    while (true) {
      skipWs();
      if (text[i] !== '"') throw err('对象键必须是字符串');
      const keyStart = i;
      const key = parseString().value;
      skipWs();
      if (text[i] !== ':') throw err('键后缺少冒号');
      i++;
      const child = parseValue();
      value[key] = child.value;
      const propertyLocation = makeLoc(keyStart, starts, sourceFile);
      propertyLocation.valueLine = makeLoc(child.start, starts, sourceFile).line;
      if (Array.isArray(child.locs)) propertyLocation.elements = child.locs;
      locs[key] = propertyLocation;
      skipWs();
      if (text[i] === ',') {
        i++;
        skipWs();
        if (text[i] === '}') {
          i++;
          break;
        }
        continue;
      }
      if (text[i] === '}') {
        i++;
        break;
      }
      throw err('对象成员后应为逗号或右花括号');
    }
    return { value, locs, start, end: i };
  }

  function parseArray() {
    const start = i;
    i++;
    const value = [];
    const locs = [];
    skipWs();
    if (text[i] === ']') {
      i++;
      return { value, locs, start, end: i };
    }
    while (true) {
      const child = parseValue();
      value.push(child.value);
      locs.push(child.locs && Object.keys(child.locs).length > 0 ? child.locs : makeLoc(child.start, starts, sourceFile));
      skipWs();
      if (text[i] === ',') {
        i++;
        skipWs();
        if (text[i] === ']') {
          i++;
          break;
        }
        continue;
      }
      if (text[i] === ']') {
        i++;
        break;
      }
      throw err('数组元素后应为逗号或右方括号');
    }
    return { value, locs, start, end: i };
  }

  const root = parseValue();
  skipWs();
  if (i < len) throw err('根值之后存在多余内容', i);
  if (root.value === null || typeof root.value !== 'object' || Array.isArray(root.value)) {
    throw err('devcontainer 配置必须是对象');
  }
  return { value: root.value, locations: root.locs ?? {} };
}
const APPEND_KEYS = ['extensions', 'mounts'];

export function normalizePort(entry) {
  if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) {
    return entry <= 65535 ? { key: String(entry), original: entry } : null;
  }
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    const colon = trimmed.lastIndexOf(':');
    if (colon !== -1) {
      const host = trimmed.slice(0, colon);
      const port = trimmed.slice(colon + 1);
      if (/^\d+$/.test(port) && host.length > 0 && Number(port) <= 65535) {
        return { key: port, original: trimmed };
      }
    }
    if (/^\d+$/.test(trimmed) && Number(trimmed) <= 65535) return { key: trimmed, original: trimmed };
    return null;
  }
  return null;
}

function collectImageBuild(docs) {
  const found = [];
  for (const doc of docs) {
    for (const key of ['image', 'build']) {
      if (doc.parsed.value[key] !== undefined) {
        const loc = doc.parsed.locations[key];
        found.push({ kind: key, file: doc.file, line: loc && typeof loc.line === 'number' ? loc.line : null });
      }
    }
  }
  return found;
}

export function mergeConfigs(docs) {
  const hits = collectImageBuild(docs);
  const hasImage = hits.some((h) => h.kind === 'image');
  const hasBuild = hits.some((h) => h.kind === 'build');
  if (hasImage && hasBuild) {
    const details = [];
    for (const a of hits.filter((h) => h.kind === 'image')) {
      for (const b of hits.filter((h) => h.kind === 'build')) {
        details.push({ image: a, build: b });
      }
    }
    throw new DcConflictError(details);
  }

  const invalidArrays = [];
  for (const doc of docs) {
    for (const key of APPEND_KEYS) {
      const value = doc.parsed.value[key];
      if (value !== undefined && !Array.isArray(value)) {
        const location = doc.parsed.locations[key];
        invalidArrays.push({ file: doc.file, key, line: location?.line ?? null, column: location?.column ?? null, value, reason: `${key} 必须是数组` });
      }
    }
  }
  if (invalidArrays.length > 0) return { merged: {}, ports: [], invalidPorts: [], invalidArrays };

  let merged = {};
  for (const doc of docs) {
    const next = { ...merged, ...doc.parsed.value };
    for (const key of APPEND_KEYS) {
      const added = Array.isArray(doc.parsed.value[key]) ? doc.parsed.value[key] : [];
      const existing = Array.isArray(merged[key]) ? merged[key] : [];
      if (existing.length > 0 || added.length > 0) next[key] = [...existing, ...added];
    }
    merged = next;
  }

  const ports = [];
  const invalidPorts = [];
  const byKey = new Map();
  for (const doc of docs) {
    const rawPorts = doc.parsed.value.forwardPorts;
    if (rawPorts !== undefined && !Array.isArray(rawPorts)) {
      invalidPorts.push({ file: doc.file, line: doc.parsed.locations.forwardPorts?.line ?? null, value: rawPorts, reason: 'forwardPorts 必须是数组' });
      continue;
    }
    const entries = Array.isArray(rawPorts) ? rawPorts : [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const norm = normalizePort(entry);
      if (!norm) {
        const location = doc.parsed.locations.forwardPorts?.elements?.[index] ?? doc.parsed.locations.forwardPorts;
        invalidPorts.push({ file: doc.file, line: location?.line ?? null, column: location?.column ?? null, value: entry, reason: '无法识别的端口格式' });
        continue;
      }
      const existing = byKey.get(norm.key);
      if (existing) {
        const location = doc.parsed.locations.forwardPorts?.elements?.[index] ?? doc.parsed.locations.forwardPorts;
        const seen = { file: doc.file, line: location?.line ?? null, value: norm.original };
        if (!existing.alsoSeenIn.some((item) => item.file === seen.file && item.line === seen.line)) {
          existing.alsoSeenIn.push(seen);
        }
        if (!existing.sources.includes(doc.file)) existing.sources.push(doc.file);
        continue;
      }
      const location = doc.parsed.locations.forwardPorts?.elements?.[index] ?? doc.parsed.locations.forwardPorts;
      const rec = {
        key: norm.key,
        value: norm.original,
        owner: { file: doc.file, line: location?.line ?? null, value: norm.original },
        sources: [doc.file],
        alsoSeenIn: []
      };
      byKey.set(norm.key, rec);
      ports.push(rec);
    }
  }
  if (ports.length > 0) merged.forwardPorts = ports.map((p) => p.value);

  return { merged, ports, invalidPorts, invalidArrays };
}

export const __APPEND_KEYS = APPEND_KEYS;
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function countEntries(merged) {
  return {
    extensions: Array.isArray(merged.extensions) ? merged.extensions.length : 0,
    mounts: Array.isArray(merged.mounts) ? merged.mounts.length : 0,
    forwardPorts: Array.isArray(merged.forwardPorts) ? merged.forwardPorts.length : 0
  };
}

export class MergeStore {
  constructor(files, options = {}) {
    this.files = files.map((f) => resolve(f).replace(/\\/g, '/'));
    this.lastGood = null;
    this.inflight = null;
    this.cache = new Map();
    this.readAttempts = options.readAttempts ?? 6;
    this.readDelayMs = options.readDelayMs ?? 8;
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this._doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async readOnce() {
    return Promise.all(this.files.map(async (file) => {
      try {
        const content = await readFile(file, 'utf8');
        return { file, content };
      } catch (cause) {
        if (cause?.code === 'ENOENT') return { file, missing: true, cause };
        return { file, unreadable: true, cause };
      }
    }));
  }

  async readStable() {
    let previous = null;
    for (let attempt = 0; attempt < this.readAttempts; attempt += 1) {
      const readings = await this.readOnce();
      const hashes = {};
      for (const reading of readings) {
        hashes[reading.file] = reading.missing || reading.unreadable ? null : sha256(reading.content);
      }
      const version = createHash('sha256')
        .update(readings.map((r) => `${r.file}:${hashes[r.file] ?? (r.unreadable ? 'unreadable' : 'missing')}:${r.content?.length ?? 0}`).join('\n'))
        .digest('hex');
      const current = { readings, hashes, version, stable: true, attempts: attempt + 1 };
      if (previous && previous.version === version) return current;
      previous = current;
      if (attempt < this.readAttempts - 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, this.readDelayMs));
      }
    }
    return { ...previous, stable: false };
  }

  fallbackSnapshot(version, hashes, readings, errors = [], conflict = null) {
    const fallback = this.lastGood;
    return {
      version,
      hashes,
      ok: false,
      stable: true,
      stale: Boolean(fallback),
      errors,
      conflict,
      files: this.files,
      contents: readings.map((r) => ({
        file: r.file,
        content: r.content ?? null,
        missing: Boolean(r.missing),
        unreadable: Boolean(r.unreadable)
      })),
      merged: fallback ? fallback.merged : null,
      portDetails: fallback ? fallback.portDetails : [],
      counts: fallback ? fallback.counts : { extensions: 0, mounts: 0, forwardPorts: 0 },
      lastGoodVersion: fallback ? fallback.version : null,
      updatedAt: new Date().toISOString()
    };
  }

  async _doRefresh() {
    const snapshot = await this.readStable();
    const { readings, hashes, version } = snapshot;
    const cached = this.cache.get(version);
    if (cached) return cached;

    if (!snapshot.stable) {
      const unstable = this.fallbackSnapshot(version, hashes, readings, [{
        file: null,
        kind: 'unstable',
        line: null,
        column: null,
        message: '文件在合并读取过程中发生变化；继续展示上一版同一版本结果。'
      }]);
      this.cache.set(version, unstable);
      return unstable;
    }

    const errors = [];
    const docs = [];
    for (const reading of readings) {
      if (reading.missing) {
        errors.push({ file: reading.file, kind: 'missing', line: null, column: null, message: `文件缺失：${reading.file}` });
        continue;
      }
      if (reading.unreadable) {
        errors.push({ file: reading.file, kind: 'read', line: null, column: null, message: reading.cause?.message ?? '文件不可读' });
        continue;
      }
      try {
        docs.push({ file: reading.file, parsed: parseJsonc(reading.content, reading.file) });
      } catch (error) {
        if (error instanceof DcParseError) {
          errors.push({ file: error.file, kind: 'parse', line: error.line, column: error.column, message: error.message, snippet: error.snippet });
        } else {
          errors.push({ file: reading.file, kind: 'parse', line: null, column: null, message: String(error && error.message ? error.message : error) });
        }
      }
    }

    let merged = null;
    let ports = [];
    let conflict = null;
    if (errors.length === 0) {
      try {
        const result = mergeConfigs(docs);
        merged = result.merged;
        ports = result.ports;
        for (const bad of result.invalidArrays) {
          errors.push({ file: bad.file, kind: 'type', line: bad.line, column: bad.column, message: `${bad.reason}: ${JSON.stringify(bad.value)}` });
        }
        for (const bad of result.invalidPorts) {
          errors.push({ file: bad.file, kind: 'port', line: bad.line, column: bad.column, message: `${bad.reason}: ${JSON.stringify(bad.value)}` });
        }
      } catch (error) {
        if (error instanceof DcConflictError) {
          conflict = { kind: 'conflict', code: error.code, message: error.message, details: error.details };
          for (const detail of error.details) {
            errors.push({ file: detail.image.file, kind: 'conflict', line: detail.image.line, column: null, message: `image 与 build 互斥：此处声明 image，${detail.build.file} 第 ${detail.build.line} 行声明 build` });
            errors.push({ file: detail.build.file, kind: 'conflict', line: detail.build.line, column: null, message: `image 与 build 互斥：此处声明 build，${detail.image.file} 第 ${detail.image.line} 行声明 image` });
          }
        } else {
          throw error;
        }
      }
    }

    if (merged && errors.length === 0) {
      this.lastGood = {
        version,
        hashes,
        ok: true,
        stable: true,
        errors: [],
        files: this.files,
        contents: readings.map((r) => ({ file: r.file, content: r.content, missing: false, unreadable: false })),
        merged,
        portDetails: ports,
        counts: countEntries(merged),
        updatedAt: new Date().toISOString()
      };
      this.cache.set(version, this.lastGood);
      return this.lastGood;
    }

    const result = this.fallbackSnapshot(version, hashes, readings, errors, conflict);
    this.cache.set(version, result);
    return result;
  }
}
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderErrorList(snapshot) {
  if (!snapshot.errors || snapshot.errors.length === 0) return '';
  const items = snapshot.errors
    .map((e) => {
      const where = e.line ? `${escHtml(e.file)} 第 ${e.line} 行${e.column ? `:${e.column}` : ''}` : escHtml(e.file);
      const tag = e.kind === 'missing' ? '缺失' : e.kind === 'conflict' ? '冲突' : '语法';
      const snippet = e.snippet ? `<pre class="snippet">${escHtml(e.snippet)}</pre>` : '';
      return `<li class="err err-${escHtml(e.kind)}" data-file="${escHtml(e.file)}" data-line="${e.line ?? ''}">
        <span class="tag">${tag}</span><span class="where">${where}</span>
        <div class="msg">${escHtml(e.message)}</div>${snippet}</li>`;
    })
    .join('\n');
  return `<ul class="errors">${items}</ul>`;
}

function renderPortRows(snapshot) {
  return (snapshot.portDetails ?? [])
    .map((p) => {
      const ownerLine = p.owner.line ? `:${p.owner.line}` : '';
      const others = (p.alsoSeenIn ?? [])
        .map((s) => `<span class="src">${escHtml(`${s.file}:${s.line ?? '?'} (${JSON.stringify(s.value)})`)}</span>`)
        .join(' ');
      return `<tr><td>${escHtml(p.key)}</td><td><code>${escHtml(JSON.stringify(p.value))}</code></td><td>${escHtml(p.owner.file + ownerLine)}</td><td>${others || '-'}</td></tr>`;
    })
    .join('\n');
}

function renderSourcePanes(snapshot) {
  const errorsByFile = new Map();
  for (const error of snapshot.errors ?? []) {
    if (!error.file || !error.line) continue;
    if (!errorsByFile.has(error.file)) errorsByFile.set(error.file, new Map());
    errorsByFile.get(error.file).set(error.line, error.message);
  }
  return (snapshot.contents ?? []).map((item) => {
    const marked = errorsByFile.get(item.file) ?? new Map();
    if (item.missing || item.unreadable || item.content == null) {
      return `<section class="source"><h2>${escHtml(item.file)}</h2><p class="empty">文件当前不可读，仍展示上一版合并结果。</p></section>`;
    }
    const rows = item.content.split(/\r?\n/).map((line, index) => {
      const number = index + 1;
      const bad = marked.has(number) ? ' class="bad-line"' : '';
      const title = marked.has(number) ? ` title="${escHtml(marked.get(number))}"` : '';
      return `<div class="ln">${number}</div><div${bad}${title}>${escHtml(line || ' ')}</div>`;
    }).join('');
    return `<section class="source"><h2>${escHtml(item.file)}</h2><div class="codegrid">${rows}</div></section>`;
  }).join('\n');
}

export function renderPage(snapshot) {
  const status = snapshot.ok
    ? '<span class="ok">● 已同步</span>'
    : `<span class="bad">● ${snapshot.stale ? '当前文件有误，展示上一版可用结果' : '当前文件有误，尚无可用合并结果'}</span>`;
  const json = snapshot.merged ? JSON.stringify(snapshot.merged, null, 2) : '{}';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>devcontainer 合并结果</title>
<style>
:root { color-scheme: light; }
body { font: 14px/1.5 system-ui, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #1f2328; }
header { padding: 14px 20px; background: #0d1117; color: #e6edf3; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; }
.ok { color: #3fb950; } .bad { color: #f85149; }
main { padding: 18px 20px; max-width: 1080px; margin: 0 auto; }
.cards { display: flex; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 10px 16px; min-width: 130px; }
.card b { font-size: 22px; display: block; }
.card span { color: #57606a; font-size: 12px; }
.errors { list-style: none; padding: 0; margin: 0 0 14px; }
.err { background: #fff5f5; border: 1px solid #f0b8b8; border-left: 4px solid #cf222e; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
.err-missing { border-left-color: #9a6700; background: #fff8c5; border-color: #d4a72c; }
.err-conflict { border-left-color: #8250df; background: #fbefff; border-color: #c297ff; }
.tag { display: inline-block; font-size: 11px; background: #cf222e; color: #fff; border-radius: 10px; padding: 0 8px; margin-right: 8px; }
.err-missing .tag { background: #9a6700; } .err-conflict .tag { background: #8250df; }
.where { font-weight: 600; } .msg { margin-top: 4px; }
.snippet { margin: 6px 0 0; background: #f6f8fa; padding: 6px 8px; border-radius: 4px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; background: #fff; margin-bottom: 14px; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eaeef2; font-size: 13px; }
th { background: #f6f8fa; } .src { display: inline-block; font-size: 11px; color: #57606a; margin-left: 4px; }
pre.json { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; overflow: auto; max-height: 60vh; }
.sources { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.source h2 { font-size: 13px; margin: 0 0 6px; }
.codegrid { display: grid; grid-template-columns: 54px 1fr; max-height: 420px; overflow: auto; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; font: 12px/1.55 Consolas, monospace; }
.codegrid div { padding: 0 8px; white-space: pre; }
.ln { text-align: right; color: #6e7781; background: #eaeef2; user-select: none; }
.bad-line { background: #ffebe9; color: #86181d; display: block; }
.empty { color: #57606a; }
.meta { color: #57606a; font-size: 12px; }
</style>
</head>
<body>
<header><h1>devcontainer 合并结果</h1>${status}
<a href="/api/merge" style="color:#58a6ff">/api/merge</a></header>
<main>
<section class="cards">
  <div class="card"><b id="c-ext">${snapshot.counts.extensions}</b><span>extensions</span></div>
  <div class="card"><b id="c-mounts">${snapshot.counts.mounts}</b><span>mounts</span></div>
  <div class="card"><b id="c-ports">${snapshot.counts.forwardPorts}</b><span>forwardPorts（去重后）</span></div>
</section>
<section id="errors">${renderErrorList(snapshot)}</section>
<h2>forwardPorts 归属</h2>
<table><thead><tr><th>归一化键</th><th>保留值</th><th>持有者（先声明）</th><th>后续来源</th></tr></thead>
<tbody>${renderPortRows(snapshot)}</tbody></table>
<h2>合并后配置</h2>
<pre class="json" id="merged">${escHtml(json)}</pre>
<h2>源文件与错误行</h2>
<div class="sources">${renderSourcePanes(snapshot)}</div>
<p class="meta">version <code id="ver">${escHtml(snapshot.version.slice(0, 12))}</code> · 更新于 <span id="ts">${escHtml(snapshot.updatedAt)}</span> · 文件改动自动刷新</p>
</main>
<script>
(async function () {
  function connect() {
    const es = new EventSource('/events');
    es.addEventListener('changed', () => location.reload());
    es.addEventListener('ping', () => {});
    es.onerror = () => { es.close(); setTimeout(connect, 1500); };
  }
  connect();
})();
</script>
</body>
</html>`;
}
export function startServer(store, options = {}) {
  const port = options.port ?? 5179;
  const host = options.host ?? '127.0.0.1';
  const clients = new Set();
  let timer = null;
  const watchers = [];
  const dirs = new Set(store.files.map((f) => dirname(f)));

  function schedulePing() {
    const data = 'event: ping\ndata: 1\n\n';
    for (const res of clients) res.write(data);
  }
  const pingTimer = setInterval(schedulePing, 25000);

  async function notifyChange() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await store.refresh();
      const data = `event: changed\ndata: ${new Date().toISOString()}\n\n`;
      for (const res of clients) res.write(data);
    }, 60);
  }

  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) return notifyChange();
        const changed = resolve(dir, filename).replace(/\\/g, '/');
        if (store.files.includes(changed)) notifyChange();
      });
      watcher.on('error', () => {});
      if (options.unref) watcher.unref();
      watchers.push(watcher);
    } catch {
      // 目录暂不可监听时忽略：请求路径仍会即时读取并刷新缓存。
    }
  }

  const server = createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'local'}`);
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/api/merge') {
        const snapshot = await store.refresh();
        const body = JSON.stringify(snapshot, null, 2);
        res.writeHead(snapshot.ok ? 200 : 200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Merge-Version': snapshot.version
        });
        res.end(body);
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const snapshot = await store.refresh();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderPage(snapshot));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, errors: [{ kind: 'internal', message: String(error && error.message ? error.message : error) }] }));
    }
  });

  server.listen(port, host);
  if (options.unref) server.unref();
  server.on('close', () => {
    clearInterval(pingTimer);
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    for (const socket of sockets) socket.destroy();
  });
  return server;
}

function defaultFiles(rootDir) {
  return [
    resolve(rootDir, '.devcontainer', 'devcontainer.json'),
    resolve(rootDir, '.devcontainer', '.devcontainer', 'devcontainer.json')
  ].map((f) =>
    f.replace(/\\/g, '/')
  );
}

async function parseArgs(argv) {
  const args = { port: 5179, host: '127.0.0.1', root: PROJECT_ROOT, files: [], print: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--port') args.port = Number(argv[++i]);
    else if (token === '--host') args.host = argv[++i];
    else if (token === '--root') args.root = resolve(argv[++i]);
    else if (token === '--file') args.files.push(resolve(args.root, argv[++i]));
    else if (token === '--print' || token === '-p') args.print = true;
    else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  if (args.files.length === 0) args.files = defaultFiles(args.root);
  return args;
}

async function main() {
  const args = await parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('用法: node tools/dcmerge.mjs [--root PROJECT_DIR] [--file PATH ...] [--port 5179] [--host 127.0.0.1]\n');
    return;
  }
  const store = new MergeStore(args.files);
  const snapshot = await store.refresh();
  if (args.print) {
    if (!snapshot.ok) {
      for (const error of snapshot.errors) {
        process.stderr.write(`[${error.kind}] ${error.file ?? 'merge'}${error.line ? `:${error.line}` : ''} ${error.message}\n`);
      }
      process.exitCode = 1;
    }
    process.stdout.write(JSON.stringify(snapshot.merged ?? {}, null, 2) + '\n');
    return;
  }
  const hasConflict = !snapshot.ok && snapshot.errors.some((e) => e.kind === 'conflict');
  if (hasConflict) {
    process.stderr.write(JSON.stringify({ ok: false, version: snapshot.version, errors: snapshot.errors }, null, 2) + '\n');
    process.exit(1);
  }
  if (!snapshot.ok) {
    const lines = snapshot.errors.map((e) => `  - ${e.file}${e.line ? ` 第 ${e.line} 行` : ''}: ${e.message}`);
    process.stderr.write(`当前配置存在错误，仍启动服务并在页面标出错误行（展示上一版可用结果）：\n${lines.join('\n')}\n`);
  }
  const server = startServer(store, { port: args.port, host: args.host });
  await new Promise((resolveListen, reject) => {
    server.once('listening', resolveListen);
    server.once('error', reject);
  });
  const address = server.address();
  process.stdout.write(`dcmerge 服务已启动: http://${args.host}:${address.port}/  (Ctrl+C 停止)\n`);
  process.stdout.write(`合并文件（外层在前）:\n${args.files.map((f) => `  - ${f}`).join('\n')}\n`);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((error) => {
    process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
    process.exit(1);
  });
}
