// For check/share-check.sh: a stand-in GitHub (device sign-in approves on the second poll), the
// share service run locally with no GitHub access behind a host that is waking it up, and a helper on port 8807 pointed at both, using
// $RIG_DIR for its folders. Nothing reaches real GitHub or the live share service.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
const H = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { createHelper } = await import(`${H}/sdk-controller-helper/server.mjs`);
const { createShare } = await import(`${H}/sdk-controller-share/server.mjs`);
let polls = 0;
const gh = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks); const body = raw.length && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : raw;
  const u = new URL(req.url, 'http://x'); const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/login/device/code') return send(200, { device_code: 'd', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
  if (u.pathname === '/login/oauth/access_token') return send(200, polls++ < 1 ? { error: 'authorization_pending' } : { access_token: 'tok' });
  if (u.pathname === '/user') return send(200, { login: 'henryhoover', name: 'Henry Hoover' });
  if (/^\/repos\/henryhoover\/[^/]+$/.test(u.pathname) && req.method === 'GET') return send(404, { message: 'Not Found' });
  if (u.pathname === '/user/repos') return send(201, { name: body.name, default_branch: 'main', html_url: `https://github.com/henryhoover/${body.name}` });
  if (u.pathname.endsWith('/git/ref/heads/main')) return send(200, { object: { sha: 'b' } });
  if (/git\/(blobs|trees|commits)$/.test(u.pathname)) return send(201, { sha: 'x' });
  if (u.pathname.endsWith('/git/refs/heads/main')) return send(200, {});
  if (/\/releases$/.test(u.pathname)) return send(201, { id: 1, html_url: 'https://github.com/henryhoover/marker-jump/releases/tag/v1.0.0' });
  if (/\/assets$/.test(u.pathname)) return send(201, {});
  send(404, { message: 'nope' });
});
gh.listen(8808, '127.0.0.1');
createShare({ dataDir: `${process.env.RIG_DIR}/data`, adminToken: 'x' }).listen(8809, '127.0.0.1');
// In front of it, a host that answers 502 while the service "wakes", as Fly does after it sleeps.
let waking = 3;
createServer(async (req, res) => {
  const sharing = req.url === '/health' || (req.method === 'POST' && req.url === '/submissions');
  if (sharing && waking-- > 0) { res.writeHead(502); return res.end(); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const reply = await fetch(`http://127.0.0.1:8809${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
  res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await reply.arrayBuffer()));
}).listen(8810, '127.0.0.1');
process.env.SDK_CONTROLLER_SHARE_URL = 'http://127.0.0.1:8810';
const runner = async (command, args) => {
  if (args[1] === 'pack') execFileSync('ditto', ['-c', '-k', '--keepParent', args[2], args[args.indexOf('--out') + 1]]);
  return { ok: true, code: 0, output: '' };
};
createHelper({ workspace: `${process.env.RIG_DIR}/work`, runner, checkPage: false, shareUrl: 'http://127.0.0.1:8810', shareWaitMs: 200, githubClientId: 'cid', githubUrls: { web: 'http://127.0.0.1:8808', api: 'http://127.0.0.1:8808', uploads: 'http://127.0.0.1:8808' } }).listen(8807, '127.0.0.1');
console.log('rig up');
