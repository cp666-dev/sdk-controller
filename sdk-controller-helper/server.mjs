#!/usr/bin/env node
// SDK Controller helper: gives the panel the file access a page does not have, for building Add Ons.
// No dependencies. Listens on 127.0.0.1 only and answers only the SDK Controller page, because any
// website the user visits could otherwise reach it. It can touch one folder, and it never sees an
// API key: the panel talks to the LLM itself.

import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { createClaudeBridge } from './claude.mjs';

const PORT = Number(process.env.SDK_CONTROLLER_PORT ?? 8795);
// Where Share to Universe sends an Add On for review (sdk-controller-share).
const SHARE_URL = (process.env.SDK_CONTROLLER_SHARE_URL ?? 'https://sdk-controller-share.fly.dev').replace(/\/+$/, '');
const SHARED = '.shared.json';
// The LUNA Builder SDK: SDK_CONTROLLER_SDK, else one the user installed themselves, else the copy
// SDK Controller's installer downloads from UA's public release (its ua-luna-builder plugin folder,
// with the repository's docs). The CLI is dist/cli.js in the first layout and sdk/cli.js in the second.
const SDK_CANDIDATES = [
  process.env.SDK_CONTROLLER_SDK,
  join(homedir(), 'Library/Application Support/LUNA Builder SDK'),
  join(homedir(), 'Library/Application Support/SDK Controller/luna-builder-sdk'),
].filter(Boolean);
export const cliIn = (root) => [join(root, 'dist/cli.js'), join(root, 'sdk/cli.js')].find((p) => existsSync(p)) ?? join(root, 'dist/cli.js');
const DEFAULT_SDK = SDK_CANDIDATES.find((root) => existsSync(join(root, 'dist/cli.js')) || existsSync(join(root, 'sdk/cli.js'))) ?? SDK_CANDIDATES[0];
const MAX_BODY = 4 * 1024 * 1024;
const MAX_OUTPUT = 20000;
const ALLOWED_ORIGINS = new Set(['ua-content://com.cp.sdkcontroller', 'http://localhost:8790', 'http://127.0.0.1:8790']);
const DOCS = new Set(['llms.txt', 'QUICKSTART.md', 'MANIFEST.md', 'CLIPS.md', 'DRAWING.md', 'FILES.md', 'FILES-GUIDE.md', 'RECIPES.md', 'EVIDENCE.md', 'PROTOCOL.md']);
const FOLDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const API_PAGE = /^api\/(index|(classes|functions|interfaces|type-aliases|variables)\/[A-Za-z0-9_.-]+)\.md$/;
const DOC_PART = 30000;
const HIDDEN = new Set(['node_modules', '.git', 'vendor']);
// Workspace folders that aren't Add Ons this panel builds: `branches` holds the repo's own Add Ons,
// which LUNA runs. The panel must not read, change or reinstall them.
const RESERVED = new Set(['branches']);

class Refused extends Error {}

export function folderPath(workspace, folder) {
  if (typeof folder !== 'string' || !FOLDER.test(folder)) throw new Refused('A folder name is lowercase letters, numbers and hyphens.');
  if (RESERVED.has(folder)) throw new Refused(`${folder} is reserved and holds no Add On built here.`);
  return join(workspace, folder);
}

/** A path inside an Add On folder, refusing anything that leaves it, including through a symlink. */
export async function filePath(workspace, folder, path) {
  const root = folderPath(workspace, folder);
  if (!existsSync(root)) throw new Refused(`There is no Add On called ${folder}.`);
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Refused('A file path is required.');
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== full) throw new Refused('That path is outside the Add On.');
  if (rel.split(sep).some((part) => HIDDEN.has(part))) throw new Refused(`${path} is managed by the SDK and cannot be changed.`);
  // The deepest part that exists has to resolve inside the folder as well.
  const realRoot = await realpath(root);
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = await realpath(probe);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Refused('That path is outside the Add On.');
  return full;
}

function run(command, args, { cwd, timeout }) {
  return new Promise((done) => {
    // Only what npm and the CLI need: no tokens or keys from the user's shell reach generated code.
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, CI: '1' };
    if (process.env.UA_ADDONS_FOLDER) env.UA_ADDONS_FOLDER = process.env.UA_ADDONS_FOLDER;
    execFile(command, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      done({
        ok: !error,
        timedOut: error?.killed === true,
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        output: output.length > MAX_OUTPUT ? `[Earlier output cut]\n${output.slice(-MAX_OUTPUT)}` : output,
      });
    });
  });
}

/**
 * The scripts an Add On page loads, checked the way the page loads them: as classic scripts, where
 * `import` and `export` are syntax errors that leave the page blank. Answers one line per problem.
 */
export async function pageScriptProblems(root) {
  const problems = [];
  let html;
  try {
    html = await readFile(join(root, JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).html ?? 'index.html'), 'utf8');
  } catch (e) {
    return [`The manifest or its page could not be read: ${e.message}`];
  }
  for (const [, type, src] of html.matchAll(/<script\b([^>]*?)\bsrc=["']([^"']+)["']/gi)) {
    if (/^(https?:)?\/\//.test(src)) continue;
    if (/type=["']module["']/i.test(type)) {
      problems.push(`${src} is loaded as a module, which LUNA on Windows blocks. Load it as a classic script.`);
      continue;
    }
    let code;
    try {
      code = await readFile(join(root, src.split('?')[0]), 'utf8');
    } catch {
      problems.push(`The page loads ${src}, which is missing.`);
      continue;
    }
    try {
      new Script(code, { filename: src });
    } catch (e) {
      problems.push(`${src}: ${e.message}. The page loads it as a classic script: no import or export; use the Luna global.`);
    }
  }
  return problems;
}

const freePort = () => new Promise((done) => {
  const probe = netServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});

/**
 * Open the page in headless Chrome against a mock session, as `ua-builder probe --mock` does, and
 * answer what went wrong: page errors, or a page that never connected. Null when it ran clean, or
 * `{ skipped }` when this Mac has no Chrome for it. It catches a page that throws, cannot load a
 * script or never connects; it cannot tell whether a page that runs shows the right thing.
 */
export async function pageRunProblems(root, { node, cli, runner }) {
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  const serve = spawn(node, [cli, 'serve', root, '--port', String(port)], { cwd: root, env, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const r = await runner(node, [cli, 'probe', `http://localhost:${port}/`, '--mock', '--timeout', '20000', '--settle', '400', '--expr', 'document.body.innerText.length'], { cwd: root, timeout: 60000 });
    if (/chrome/i.test(r.output) && /not found|could not find|no chrome|install/i.test(r.output) && !r.ok) return { skipped: 'Chrome is not installed, so the page could not be opened to check it.' };
    const errors = r.output.split('\n').filter((l) => /page error|timed out|refused|failed/i.test(l));
    return r.ok && errors.length === 0 ? null : (errors.length ? errors : [r.output.trim().slice(-600)]);
  } finally {
    serve.kill();
  }
}

/**
 * The model draws icons as SVG (it writes text files), but LUNA and UA Universe want a PNG. macOS
 * renders SVG with its own Quick Look, so turn icon.svg into icon.png and point the manifest at it.
 * Answers a line for the test output, or null when there was nothing to do.
 */
export async function iconFromSvg(root, runner) {
  const svg = join(root, 'icon.svg');
  if (!existsSync(svg)) return null;
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.icon && !/\.svg$/i.test(manifest.icon) && existsSync(join(root, manifest.icon))) return null;
  const out = await mkdtemp(join(tmpdir(), 'sdc-icon-'));
  try {
    const r = await runner('qlmanage', ['-t', '-s', '512', '-o', out, svg], { cwd: root, timeout: 30000 });
    const made = join(out, 'icon.svg.png');
    if (!r.ok || !existsSync(made)) return 'icon.svg could not be turned into a PNG, so the Add On has no icon yet.';
    await writeFile(join(root, 'icon.png'), await readFile(made));
    manifest.icon = 'icon.png';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
    return 'Made icon.png from icon.svg, and set it as the manifest icon.';
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function listFiles(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (HIDDEN.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out;
}

export function createHelper({ workspace, sdkRoot = DEFAULT_SDK, node = process.execPath, runner = run, shareUrl = SHARE_URL, fetchImpl = fetch, checkPage = true, port = PORT, claude = {} } = {}) {
  let listening = null;
  // The port the helper really listens on, which Claude Code's MCP config has to name.
  const bridge = createClaudeBridge({ port: () => listening?.address()?.port ?? port, ...claude });
  const sharedFile = join(workspace, SHARED);
  const readShared = async () => (existsSync(sharedFile) ? JSON.parse(await readFile(sharedFile, 'utf8')) : {});

  async function toShare(path, init) {
    let response;
    try {
      response = await fetchImpl(`${shareUrl}${path}`, init);
    } catch {
      throw new Refused('Could not reach the Universe sharing service. Check your internet connection and try again.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Refused(body.error ?? `The sharing service answered ${response.status}.`);
    return body;
  }
  const cli = cliIn(sdkRoot);
  const npm = 'npm';

  // Install only what passed its tests since its last change.
  const tested = new Map();

  const routes = {
    async '/docs'({ name, offset = 0 }) {
      // The guides, and the generated API reference: api/index.md lists every class, function
      // and type, each on its own page (api/classes/Session.md).
      const isApi = typeof name === 'string' && API_PAGE.test(name);
      if (!DOCS.has(name) && !isApi) throw new Refused(`Available docs: ${[...DOCS].join(', ')}, and the API reference: api/index.md, then pages it links such as api/classes/Session.md.`);
      const docs = join(sdkRoot, 'docs');
      const full = resolve(docs, name);
      if (!full.startsWith(docs + sep) || !existsSync(full)) throw new Refused(`There is no ${name}. api/index.md lists the API reference pages.`);
      const text = await readFile(full, 'utf8');
      // Long pages come in parts, so none is cut off by the size limit on a tool result.
      const start = Math.max(0, Math.floor(Number(offset) || 0));
      const part = text.slice(start, start + DOC_PART);
      const next = start + DOC_PART < text.length ? start + DOC_PART : null;
      return { name, text: part, ...(start || next ? { from: start, total: text.length, next, more: next ? `Read on with offset ${next}.` : 'This is the end.' } : {}) };
    },
    async '/list'({ folder }) {
      await mkdir(workspace, { recursive: true });
      if (folder === undefined) {
        const entries = await readdir(workspace, { withFileTypes: true });
        return { workspace, addOns: entries.filter((e) => e.isDirectory() && !RESERVED.has(e.name)).map((e) => e.name).sort() };
      }
      const root = folderPath(workspace, folder);
      if (!existsSync(root)) throw new Refused(`There is no Add On called ${folder}.`);
      return { files: (await listFiles(root)).sort() };
    },
    async '/read'({ folder, path }) {
      const full = await filePath(workspace, folder, path);
      if (!existsSync(full)) throw new Refused(`${path} does not exist.`);
      return { path, contents: await readFile(full, 'utf8') };
    },
    async '/write'({ folder, path, contents }) {
      if (typeof contents !== 'string') throw new Refused('File contents are required.');
      const full = await filePath(workspace, folder, path);
      if (existsSync(full) && (await lstat(full)).isSymbolicLink()) throw new Refused('That path is a symlink.');
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
      tested.set(folder, false);
      return { ok: true, path, bytes: Buffer.byteLength(contents) };
    },
    async '/scaffold'({ folder, name, target, description }) {
      const root = folderPath(workspace, folder);
      if (existsSync(root)) throw new Refused(`${folder} already exists. Change it with build_write_file.`);
      if (!['window', 'browser', 'editor', 'app'].includes(target)) throw new Refused('target must be window, browser, editor or app.');
      if (typeof name !== 'string' || !name.trim()) throw new Refused('A name is required.');
      await mkdir(workspace, { recursive: true });
      const args = [cli, 'new', folder, '--name', name, '--id', `com.cp.built.${folder.replaceAll('-', '')}`, '--manufacturer', 'CP', '--target', target];
      if (description) args.push('--description', description);
      const made = await runner(node, args, { cwd: workspace, timeout: 60000 });
      if (!made.ok) return made;
      const installed = await runner(npm, ['install', '--no-audit', '--no-fund'], { cwd: root, timeout: 300000 });
      return { ...installed, folder };
    },
    async '/test'({ folder }) {
      const root = folderPath(workspace, folder);
      if (!existsSync(root)) throw new Refused(`There is no Add On called ${folder}.`);
      const iconNote = await iconFromSvg(root, runner).catch((e) => `The icon could not be made: ${e.message}`);
      const problems = await pageScriptProblems(root);
      const result = await runner(npm, ['test'], { cwd: root, timeout: 180000 });
      if (iconNote) result.output = `${iconNote}\n\n${result.output}`;
      // Last, open the page itself: the unit tests never load it.
      let pageRun = null;
      if (result.ok && problems.length === 0 && checkPage) {
        pageRun = await pageRunProblems(root, { node, cli, runner });
        if (Array.isArray(pageRun)) problems.push(...pageRun.map((p) => `Opening the page against a mock session: ${p}`));
      }
      const ok = result.ok && problems.length === 0;
      tested.set(folder, ok);
      if (problems.length) result.output = `Page check failed:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n${result.output}`;
      if (pageRun?.skipped) result.output = `${pageRun.skipped}\n\n${result.output}`;
      return { ...result, ok };
    },
    async '/share'({ folder, builderName, title, description, categories, agreed, builderKey }) {
      const root = folderPath(workspace, folder);
      if (!existsSync(root)) throw new Refused(`There is no Add On called ${folder}.`);
      if (typeof builderName !== 'string' || !builderName.trim()) throw new Refused('Add your name, so the listing can credit you.');
      if (agreed !== true) throw new Refused('Agree to the sharing terms first.');
      const dir = await mkdtemp(join(tmpdir(), 'sdc-share-'));
      try {
        const out = join(dir, 'addon.lunaaddon');
        // Pack checks the manifest and that every script and stylesheet the page loads is there.
        const packed = await runner(node, [cli, 'pack', root, '--out', out], { cwd: root, timeout: 60000 });
        if (!packed.ok) throw new Refused(`It could not be packed for sharing:\n${packed.output}`);
        const addOn = (await readFile(out)).toString('base64');
        const submission = await toShare('/submissions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ addOn, builderName, title, description, categories, agreed, origin: { builderKey, sdkController: '1.0.0' } }),
        });
        const shared = await readShared();
        shared[folder] = { id: submission.id, title: submission.title, submittedAt: submission.submittedAt };
        await writeFile(sharedFile, JSON.stringify(shared, null, 2));
        return submission;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async '/share-status'({ folder }) {
      folderPath(workspace, folder);
      const entry = (await readShared())[folder];
      if (!entry) return { shared: false };
      return { shared: true, ...(await toShare(`/submissions/${entry.id}`, {})) };
    },
    async '/install'({ folder }) {
      const root = folderPath(workspace, folder);
      if (!existsSync(root)) throw new Refused(`There is no Add On called ${folder}.`);
      if (tested.get(folder) !== true) throw new Refused(`${folder} has not passed its tests since it last changed. Run them, fix what fails, then install.`);
      return runner(node, [cli, 'install'], { cwd: root, timeout: 60000 });
    },
  };

  Object.assign(routes, bridge.routes);

  const readJsonBody = async (req) => {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Refused('That request is too large.');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };

  listening = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const answer = (status, body, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    // A browser always names its origin on a cross-site request, and the Host check stops a
    // website re-pointing its own domain at 127.0.0.1.
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return answer(403, { error: 'Wrong host.' });
    if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return answer(403, { error: 'Only the SDK Controller panel can use this helper.' });
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};

    if (req.method === 'OPTIONS') {
      return answer(204, undefined, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
    }
    if (req.method === 'GET' && req.url === '/health') return answer(200, { ok: true, workspace, sdk: existsSync(cli) }, cors);
    // Claude Code reaches the MCP endpoint from this Mac, with no Origin; its token names the turn.
    if (req.url.startsWith('/mcp/')) {
      if (origin !== undefined) return answer(403, { error: 'Not for pages.' });
      try {
        if (await bridge.handleMcp(req, res, () => readJsonBody(req))) return undefined;
      } catch (e) {
        return answer(400, { error: e?.message ?? String(e) });
      }
    }

    const route = req.method === 'POST' ? routes[req.url] : undefined;
    if (!route) return answer(404, { error: 'Not found.' }, cors);
    // A JSON content type forces a preflight, so no page can get here with a plain form post.
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return answer(415, { error: 'Send JSON.' }, cors);

    try {
      const body = await readJsonBody(req);
      answer(200, await route(body ?? {}), cors);
    } catch (e) {
      const refused = e instanceof Refused || e?.constructor?.name === 'Refused';
      answer(refused ? 400 : 500, { error: e?.message ?? String(e) }, cors);
    }
  });
  return listening;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const workspace = process.env.SDK_CONTROLLER_WORKSPACE ?? join(homedir(), 'LUNA Built Add Ons');
  createHelper({ workspace }).listen(PORT, '127.0.0.1', () => {
    console.log(`SDK Controller helper on http://127.0.0.1:${PORT}, building Add Ons in ${workspace}`);
  });
}
