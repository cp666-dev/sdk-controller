// "Use my GitHub account": GitHub's device sign-in and publishing to the user's own account,
// against a stand-in for github.com and its API.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHelper } from '../server.mjs';
import { readZip } from '../publish/addon.mjs';

const ORIGIN = 'ua-content://com.cp.sdkcontroller';
let base; let workspace; let gh; let ghUrl; let helper; let url;
const state = { pollsBeforeYes: 1, deny: false, repos: new Map(), releases: [], assets: [], tokens: new Set(['tok-1']) };

function fakeGitHub() {
  return createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = (req.headers['content-type'] ?? '').includes('json') && raw.length ? JSON.parse(raw) : raw;
    const u = new URL(req.url, 'http://x');
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (u.pathname === '/login/device/code') return send(200, body.client_id === 'client-123' ? { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0 } : { error: 'unauthorized_client' });
    if (u.pathname === '/login/oauth/access_token') {
      if (state.deny) return send(200, { error: 'access_denied' });
      if (state.pollsBeforeYes-- > 0) return send(200, { error: 'authorization_pending' });
      return send(200, { access_token: 'tok-1', token_type: 'bearer', scope: 'public_repo' });
    }
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (!state.tokens.has(token)) return send(401, { message: 'Bad credentials' });
    let m;
    if (req.method === 'GET' && u.pathname === '/user') return send(200, { login: 'Sam-Rivera', name: 'Sam Rivera' });
    if (req.method === 'GET' && (m = u.pathname.match(/^\/repos\/Sam-Rivera\/([^/]+)$/))) return state.repos.has(m[1]) ? send(200, state.repos.get(m[1])) : send(404, { message: 'Not Found' });
    if (req.method === 'GET' && (m = u.pathname.match(/^\/repos\/Sam-Rivera\/([^/]+)\/releases\/latest$/))) {
      const r = state.releases.filter((x) => x.repo === m[1]).at(-1);
      return r ? send(200, { tag_name: r.tag }) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && u.pathname === '/user/repos') {
      const repo = { name: body.name, default_branch: 'main', html_url: `https://github.com/Sam-Rivera/${body.name}`, private: body.private };
      state.repos.set(body.name, repo);
      return send(201, repo);
    }
    if (u.pathname.endsWith('/git/ref/heads/main')) return send(200, { object: { sha: 'base' } });
    if (u.pathname.endsWith('/git/blobs')) return send(201, { sha: 'b' });
    if (u.pathname.endsWith('/git/trees')) return send(201, { sha: 't' });
    if (u.pathname.endsWith('/git/commits')) return send(201, { sha: 'c' });
    if (u.pathname.endsWith('/git/refs/heads/main')) return send(200, {});
    if (req.method === 'POST' && (m = u.pathname.match(/^\/repos\/Sam-Rivera\/([^/]+)\/releases$/))) {
      state.releases.push({ repo: m[1], tag: body.tag_name });
      return send(201, { id: state.releases.length, html_url: `https://github.com/Sam-Rivera/${m[1]}/releases/tag/${body.tag_name}` });
    }
    if (u.pathname.match(/\/releases\/\d+\/assets$/)) { state.assets.push({ name: u.searchParams.get('name'), data: raw }); return send(201, {}); }
    send(404, { message: `no route ${req.method} ${u.pathname}` });
  });
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'ghu-'));
  workspace = join(base, 'work');
  const dir = join(workspace, 'big-clock');
  await mkdir(join(dir, 'vendor'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: 'com.cp.built.bigclock', title: 'big-clock', html: 'index.html', target: 'window', width: 400, height: 300 }));
  await writeFile(join(dir, 'index.html'), '<script src="vendor/luna.global.js"></script>');
  await writeFile(join(dir, 'vendor/luna.global.js'), 'var Luna={};');
  await writeFile(join(dir, 'package.json'), '{"devDependencies":{"x":"file:../../Users/someone/sdk"}}');
  gh = fakeGitHub();
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  ghUrl = `http://127.0.0.1:${gh.address().port}`;
  // Pack as LUNA does: a zip holding one folder.
  const runner = async (command, args) => {
    if (args[1] === 'pack') {
      const src = args[2];
      const out = args[args.indexOf('--out') + 1];
      execFileSync('ditto', ['-c', '-k', '--keepParent', src, out]);
    }
    return { ok: true, code: 0, output: '' };
  };
  helper = createHelper({ workspace, runner, checkPage: false, githubClientId: 'client-123', githubUrls: { web: ghUrl, api: ghUrl, uploads: ghUrl } });
  await new Promise((r) => helper.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${helper.address().port}`;
});
after(async () => { gh.close(); helper.close(); await rm(base, { recursive: true, force: true }); });

const post = async (path, body) => {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

describe('connecting GitHub', () => {
  it('gives a short code to type on GitHub, waits, then connects', async () => {
    const { body: start } = await post('/github/connect/start', {});
    assert.equal(start.code, 'ABCD-1234');
    assert.equal(start.url, 'https://github.com/login/device');
    assert.equal((await post('/github/connect/poll', { flowId: start.flowId })).body.status, 'waiting');
    const done = (await post('/github/connect/poll', { flowId: start.flowId })).body;
    assert.deepEqual({ status: done.status, login: done.login, name: done.name, token: done.token }, { status: 'connected', login: 'Sam-Rivera', name: 'Sam Rivera', token: 'tok-1' });
  });

  it('says so when they press Cancel on GitHub', async () => {
    state.deny = true;
    const { body: start } = await post('/github/connect/start', {});
    assert.equal((await post('/github/connect/poll', { flowId: start.flowId })).body.status, 'denied');
    state.deny = false;
  });

  it('treats an unknown sign-in as expired, so the page offers a new code', async () => {
    assert.equal((await post('/github/connect/poll', { flowId: 'nope' })).body.status, 'expired');
  });

  it('asks them to connect again when the token stops working', async () => {
    const r = await post('/github/user', { token: 'revoked' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Connect GitHub again/);
  });

  it('says plainly when this copy has no GitHub app set up', async () => {
    const plain = createHelper({ workspace, checkPage: false, githubClientId: '' });
    await new Promise((r) => plain.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${plain.address().port}/github/connect/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' });
    assert.match((await r.json()).error, /Share it for me/);
    plain.close();
  });
});

describe('publishing to their own account', () => {
  it('makes a public repository and a release LUNA can install, credited to them', async () => {
    const { status, body } = await post('/github/publish', { token: 'tok-1', folder: 'big-clock', title: 'Big Clock', description: 'Bar and beat, huge.', categories: ['Utility'], builderName: 'Sam Rivera' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.repo, 'https://github.com/Sam-Rivera/big-clock');
    assert.equal(body.version, '1.0.0');
    assert.equal(state.repos.get('big-clock').private, false);
    const { names, read } = readZip(state.assets.at(-1).data);
    const manifest = JSON.parse(read('Big Clock/manifest.json').toString());
    assert.equal(manifest.id, 'io.github.samrivera.bigclock');
    assert.equal(manifest.manufacturer, 'Sam Rivera');
    assert.equal(manifest.icon, 'icon.png');
    assert.match(manifest.description, /Made with SDK Controller\.$/);
    assert.ok(!names.some((n) => /package\.json/.test(n)), 'no build files');
    assert.equal(names.filter((n) => /readme\.md$/i.test(n)).length, 1);
  });

  it('publishes the next share of the same Add On to the same repository, as an update', async () => {
    const { body } = await post('/github/publish', { token: 'tok-1', folder: 'big-clock', title: 'Big Clock', description: 'Now with flashing.', builderName: 'Sam Rivera' });
    assert.equal(body.repo, 'https://github.com/Sam-Rivera/big-clock');
    assert.equal(body.version, '1.1.0');
    assert.equal(body.isUpdate, true);
  });

  it('picks a free name when one is taken by something else', async () => {
    state.repos.set('pads', { name: 'pads', default_branch: 'main', html_url: 'x' });
    await mkdir(join(workspace, 'pads'), { recursive: true });
    for (const f of ['manifest.json', 'index.html']) await writeFile(join(workspace, 'pads', f), await readFile(join(workspace, 'big-clock', f)));
    await mkdir(join(workspace, 'pads', 'vendor'), { recursive: true });
    await writeFile(join(workspace, 'pads', 'vendor/luna.global.js'), 'var Luna={};');
    const { body } = await post('/github/publish', { token: 'tok-1', folder: 'pads', title: 'Pads', builderName: 'Sam' });
    assert.equal(body.repo, 'https://github.com/Sam-Rivera/pads-2');
  });

  it('remembers it, so the panel can show where it went', async () => {
    const { body } = await post('/share-status', { folder: 'big-clock' });
    assert.equal(body.github.repo, 'big-clock');
    assert.equal(body.github.version, '1.1.0');
  });
});
