const http = require('http');
const fs = require('fs');
const path = require('path');

function listenOnce() {
  return new Promise((resolveOnce, rejectOnce) => {
    const req = http.get('http://127.0.0.1:5179/events', (res) => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); rejectOnce(new Error('timeout waiting for changed event')); }, 8000);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        if (buf.includes('event: changed')) {
          clearTimeout(timer);
          req.destroy();
          resolveOnce(true);
        }
      });
    });
    req.on('error', () => {});
  });
}

(async () => {
  const inner = path.resolve('.devcontainer', '.devcontainer', 'devcontainer.json');
  const wait = listenOnce();
  await new Promise((r) => setTimeout(r, 400));
  let text = fs.readFileSync(inner, 'utf8');
  text = text.replace('merged-space', 'merged-space-live');
  const tmp = inner + '.swp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, inner);
  const got = await wait;
  console.log('SSE changed event received=' + got);
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
