const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const root = path.resolve('.devcontainer');
const outer = path.join(root, 'devcontainer.json');
const inner = path.join(root, '.devcontainer', 'devcontainer.json');
const enc = 'utf8';

function writeAtomic(file, text) {
  const tmp = file + '.swp-' + process.pid;
  fs.writeFileSync(tmp, text, enc);
  fs.renameSync(tmp, file);
}

function get(url) {
  return new Promise((resolveGet, rejectGet) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolveGet({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', rejectGet);
  });
}

const CRLF = '\r\n';
const outerGood = [
  '{',
  '  // 外层基准',
  '  "image": "mcr.microsoft.com/devcontainers/universal:2",',
  '  "features": {},',
  '  "extensions": ["dbaeumer.vscode-eslint"],',
  '  "mounts": ["source=${localWorkspaceFolder}/outer,target=/outer,type=bind"],',
  '  "forwardPorts": [3000, 8080]',
  '}',
  ''
].join(CRLF);
const innerGood = [
  '{',
  '  // 内层覆盖',
  '  "name": "merged-space",',
  '  "extensions": ["esbenp.prettier-vscode"],',
  '  "mounts": ["source=${localWorkspaceFolder}/inner,target=/inner,type=bind"],',
  '  "forwardPorts": ["127.0.0.1:3000", "9000"],',
  '  "settings": { "editor.fontSize": 14 }',
  '}',
  ''
].join(CRLF);
const innerBroken = [
  '{',
  '  "name": "merged-space",',
  '  OOPS',
  '}',
  ''
].join(CRLF);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mode = process.argv[2];
  if (mode === 'good') {
    writeAtomic(outer, outerGood);
    writeAtomic(inner, innerGood);
    console.log('wrote good pair');
  } else if (mode === 'break') {
    writeAtomic(inner, innerBroken);
    console.log('wrote broken inner');
  } else if (mode === 'show') {
    const r = await get('http://127.0.0.1:5179/api/merge');
    const j = JSON.parse(r.body);
    console.log(`HTTP=${r.status} ok=${j.ok} stale=${j.stale} ver=${String(r.headers['x-merge-version']).slice(0, 12)} stable=${j.stable}`);
    console.log(`counts ext=${j.counts.extensions} mounts=${j.counts.mounts} ports=${j.counts.forwardPorts}`);
    if (j.merged) console.log(`merged name=${j.merged.name} image=${j.merged.image} ports=[${(j.merged.forwardPorts || []).map((p) => JSON.stringify(p)).join(',')}]`);
    for (const p of j.portDetails || []) {
      console.log(`port ${p.key} value=${JSON.stringify(p.value)} owner=${path.basename(p.owner.file)}:${p.owner.line} sources=[${p.sources.map((s) => path.basename(s)).join(',')}] also=[${p.alsoSeenIn.map((s) => path.basename(s.file) + ':' + s.line).join(',')}]`);
    }
    for (const e of j.errors || []) console.log(`ERR ${e.kind} ${path.basename(e.file || '-')}:${e.line} ${e.message.slice(0, 80)}`);
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
