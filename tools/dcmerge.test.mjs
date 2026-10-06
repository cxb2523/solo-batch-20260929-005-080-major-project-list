import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  DcConflictError,
  MergeStore,
  mergeConfigs,
  normalizePort,
  parseJsonc,
  startServer
} from './dcmerge.mjs';

const parse = (text, file = 'sample.json') => parseJsonc(text, file);

test('JSONC parser accepts comments, trailing commas, and root-key locations', () => {
  const result = parse(`{
  // comment
  "name": "a", /* block */
  "list": [1, 2,],
}`);
  assert.equal(result.value.name, 'a');
  assert.deepEqual(result.value.list, [1, 2]);
  assert.equal(result.locations.name.line, 3);
  assert.equal(result.locations.list.line, 4);
});

test('JSONC parser reports exact error file, line, and column', () => {
  assert.throws(() => parse('{\n  "ok": 1,\n  bad\n}', 'bad.json'), (error) => {
    assert.equal(error.line, 3);
    assert.equal(error.file, 'bad.json');
    assert.match(error.snippet, /bad/);
    return true;
  });
});

test('bare ports and host:port strings normalize to the same numeric key', () => {
  assert.deepEqual(normalizePort(3000), { key: '3000', original: 3000 });
  assert.deepEqual(normalizePort('3000'), { key: '3000', original: '3000' });
  assert.deepEqual(normalizePort('127.0.0.1:3000'), { key: '3000', original: '127.0.0.1:3000' });
  assert.equal(normalizePort('nope:3000x'), null);
});

test('outer object is the base and inner object replaces non-special keys', () => {
  const result = mergeConfigs([
    { file: 'outer', parsed: parse('{ "settings": { "a": 1, "b": 2 }, "keep": true }') },
    { file: 'inner', parsed: parse('{ "settings": { "b": 20 } }') }
  ]);
  assert.deepEqual(result.merged.settings, { b: 20 });
  assert.equal(result.merged.keep, true);
});

test('extensions and mounts append without de-duplication', () => {
  const result = mergeConfigs([
    { file: 'outer', parsed: parse('{ "extensions": ["a"], "mounts": ["m1"] }') },
    { file: 'inner', parsed: parse('{ "extensions": ["a", "b"], "mounts": ["m2"] }') }
  ]);
  assert.deepEqual(result.merged.extensions, ['a', 'a', 'b']);
  assert.deepEqual(result.merged.mounts, ['m1', 'm2']);
});

test('forwardPorts de-duplicates and first declaration owns displayed value', () => {
  const result = mergeConfigs([
    { file: 'outer', parsed: parse('{\n  "forwardPorts": [\n    3000,\n    8080\n  ]\n}', 'outer') },
    { file: 'inner', parsed: parse('{\n  "forwardPorts": [\n    "127.0.0.1:3000",\n    "9000"\n  ]\n}', 'inner') }
  ]);
  assert.deepEqual(result.merged.forwardPorts, [3000, 8080, '9000']);
  const port3000 = result.ports.find((item) => item.key === '3000');
  assert.equal(port3000.owner.file, 'outer');
  assert.equal(port3000.owner.line, 3);
  assert.equal(port3000.alsoSeenIn[0].file, 'inner');
  assert.equal(port3000.alsoSeenIn[0].line, 3);
});

test('extensions, mounts, and forwardPorts must be arrays', () => {
  const result = mergeConfigs([
    { file: 'outer', parsed: parse('{\n  "extensions": "not-array",\n  "mounts": ["ok"]\n}') }
  ]);
  assert.equal(result.invalidArrays[0].key, 'extensions');
  assert.equal(result.invalidArrays[0].line, 2);
});

test('image and build across files is a hard conflict with both line numbers', () => {
  assert.throws(() => mergeConfigs([
    { file: 'outer.json', parsed: parse('{\n  "image": "img:1"\n}', 'outer.json') },
    { file: 'inner.json', parsed: parse('{\n  "build": { "dockerfile": "D" }\n}', 'inner.json') }
  ]), (error) => {
    assert.ok(error instanceof DcConflictError);
    assert.equal(error.details[0].image.file, 'outer.json');
    assert.equal(error.details[0].image.line, 2);
    assert.equal(error.details[0].build.file, 'inner.json');
    assert.equal(error.details[0].build.line, 2);
    return true;
  });
});

async function withTempRoot(block) {
  const root = await mkdtemp(join(tmpdir(), 'dcmerge-'));
  await mkdir(join(root, '.devcontainer', '.devcontainer'), { recursive: true });
  try {
    await block(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const outerPath = (root) => join(root, '.devcontainer', 'devcontainer.json');
const innerPath = (root) => join(root, '.devcontainer', '.devcontainer', 'devcontainer.json');

test('content hash cache updates immediately and parse failure keeps last clean result', async () => {
  await withTempRoot(async (root) => {
    await writeFile(outerPath(root), JSON.stringify({ image: 'img:1', extensions: ['a'], mounts: ['m1'] }));
    await writeFile(innerPath(root), JSON.stringify({ forwardPorts: [3000] }));
    const store = new MergeStore([outerPath(root), innerPath(root)]);
    const first = await store.refresh();
    assert.equal(first.ok, true);
    await writeFile(innerPath(root), '{\n// comment\nbroken\n}');
    const broken = await store.refresh();
    assert.equal(broken.ok, false);
    assert.equal(broken.stale, true);
    assert.equal(broken.merged.image, 'img:1');
    assert.equal(broken.errors.at(-1).line, 3);
    await writeFile(innerPath(root), JSON.stringify({ name: 'fresh' }));
    const fixed = await store.refresh();
    assert.equal(fixed.ok, true);
    assert.equal(fixed.merged.name, 'fresh');
    assert.equal((await store.refresh()).version, fixed.version);
  });
});

test('unstable reads return the last clean snapshot instead of mixing versions', async () => {
  await withTempRoot(async (root) => {
    const outer = outerPath(root);
    const inner = innerPath(root);
    await writeFile(outer, JSON.stringify({ image: 'v1' }));
    await writeFile(inner, JSON.stringify({ name: 'same' }));
    const store = new MergeStore([outer, inner], { readAttempts: 4, readDelayMs: 1 });
    const good = await store.refresh();
    let toggle = false;
    store.readOnce = async () => [
      { file: store.files[0], content: JSON.stringify({ image: toggle ? 'v2' : 'v3' }) },
      { file: store.files[1], content: JSON.stringify({ name: 'same' }) }
    ].map((entry) => {
      if (entry.file === store.files[0]) toggle = !toggle;
      return entry;
    });
    const unstable = await store.refresh();
    assert.equal(unstable.ok, false);
    assert.equal(unstable.merged, good.merged);
    assert.equal(unstable.errors[0].kind, 'unstable');
  });
});

test('server emits a change event and /api/merge remains usable without a 500', async () => {
  await withTempRoot(async (root) => {
    await writeFile(outerPath(root), JSON.stringify({ image: 'img:1', extensions: ['a'], mounts: ['m1'], forwardPorts: [3000] }));
    await writeFile(innerPath(root), JSON.stringify({ extensions: ['b'] }));
    const store = new MergeStore([outerPath(root), innerPath(root)]);
    const server = startServer(store, { port: 0, host: '127.0.0.1' });
    await new Promise((resolveListening, rejectListening) => {
      server.once('listening', resolveListening);
      server.once('error', rejectListening);
    });
    const port = server.address().port;
    try {
      let data = await fetch(`http://127.0.0.1:${port}/api/merge`).then((response) => response.json());
      assert.equal(data.ok, true);
      assert.deepEqual(data.counts, { extensions: 2, mounts: 1, forwardPorts: 1 });
      const page = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
      assert.match(page, /源文件与错误行/);
      const stream = await fetch(`http://127.0.0.1:${port}/events`);
      const reader = stream.body.getReader();
      await reader.read();
      await writeFile(innerPath(root), JSON.stringify({ extensions: ['b', 'c'] }));
      let event = '';
      for (let index = 0; index < 60 && !event.includes('changed'); index += 1) {
        await delay(50);
        const chunk = await reader.read();
        event += new TextDecoder().decode(chunk.value);
      }
      assert.match(event, /event: changed/);
      await reader.cancel();
      data = await fetch(`http://127.0.0.1:${port}/api/merge`).then((response) => response.json());
      assert.equal(data.counts.extensions, 3);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});
