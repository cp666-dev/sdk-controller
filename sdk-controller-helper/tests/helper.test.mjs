// `node --test tests/` from sdk-controller-helper. Uses a temporary folder and a fake runner.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHelper } from '../server.mjs';

const ORIGIN = 'ua-content://com.cp.sdkcontroller';
let base; let workspace; let sdkRoot; let outside; let server; let url; const ran = []; const shareCalls = [];

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'sdc-'));
  workspace = join(base, 'work');
  outside = join(base, 'secret.txt');
  sdkRoot = join(base, 'sdk');
  await mkdir(join(workspace, 'demo', 'node_modules'), { recursive: true });
  await mkdir(join(workspace, 'branches', 'other'), { recursive: true });
  await mkdir(join(sdkRoot, 'docs'), { recursive: true });
  await writeFile(join(sdkRoot, 'docs', 'llms.txt'), 'docs here');
  await mkdir(join(sdkRoot, 'docs', 'api', 'classes'), { recursive: true });
  await writeFile(join(sdkRoot, 'docs', 'api', 'index.md'), '# Luna\n[Session](classes/Session.md)');
  await writeFile(join(sdkRoot, 'docs', 'api', 'classes', 'Session.md'), 'S'.repeat(65000));
  await writeFile(join(sdkRoot, 'docs', 'QUICKSTART.md'), 'quick');
  await writeFile(outside, 'private');
  await writeFile(join(workspace, 'demo', 'logic.js'), 'x');
  await symlink(base, join(workspace, 'demo', 'escape'));
  const runner = async (command, args, opts) => {
    ran.push({ command, args, cwd: opts.cwd });
    if (args[1] === 'new') await mkdir(join(opts.cwd, args[2]), { recursive: true });
    if (args[1] === 'pack') await writeFile(args[args.indexOf('--out') + 1], 'PK-fake');
    return { ok: true, code: 0, output: 'fine' };
  };
  const shareFetch = async (u, init) => {
    shareCalls.push({ u, body: init?.body ? JSON.parse(init.body) : null });
    if (u.endsWith('/submissions')) return new Response(JSON.stringify({ id: 'a'.repeat(24), status: 'pending', title: 'Demo' }), { status: 201 });
    return new Response(JSON.stringify({ id: 'a'.repeat(24), status: 'published', listing: { repo: 'r' } }));
  };
  // The page run needs Chrome and the real SDK; check/page-run.test.mjs covers it.
  server = createHelper({ workspace, sdkRoot, runner, shareUrl: 'https://share.test', fetchImpl: shareFetch, checkPage: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(base, { recursive: true, force: true });
});

const post = (path, body, headers = {}) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
  body: JSON.stringify(body),
});

describe('who can call it', () => {
  it('answers the panel, with CORS for its origin', async () => {
    const r = await fetch(`${url}/health`, { headers: { origin: ORIGIN } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  });

  it('refuses any other website, even before reading the body', async () => {
    const r = await post('/write', { folder: 'demo', path: 'evil.js', contents: 'x' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(existsSync(join(workspace, 'demo', 'evil.js')), false);
  });

  it('refuses a preflight from another website', async () => {
    const r = await fetch(`${url}/write`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });

  it('refuses a form post, which a browser sends without a preflight', async () => {
    const r = await fetch(`${url}/write`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: '{}' });
    assert.equal(r.status, 415);
  });
});

describe('where it can write', () => {
  it('writes inside an Add On, making folders', async () => {
    assert.equal((await post('/write', { folder: 'demo', path: 'ui/a.css', contents: 'body{}' })).status, 200);
    assert.equal(await readFile(join(workspace, 'demo', 'ui/a.css'), 'utf8'), 'body{}');
  });

  for (const [what, path] of [['a parent path', '../../secret.txt'], ['an absolute path', '/tmp/sdc-evil'], ['node_modules', 'node_modules/x.js'], ['the SDK bundle', 'vendor/luna.global.js'], ['git', '.git/config'], ['a symlink out of the folder', 'escape/secret.txt']]) {
    it(`refuses ${what}`, async () => {
      assert.equal((await post('/write', { folder: 'demo', path, contents: 'x' })).status, 400);
      assert.equal((await post('/read', { folder: 'demo', path })).status, 400);
    });
  }

  it('leaves the file outside alone', async () => {
    assert.equal(await readFile(outside, 'utf8'), 'private');
  });

  for (const folder of ['..', '../work', 'a/b', 'UPPER', '', '.hidden', 'branches']) {
    it(`refuses the folder name ${JSON.stringify(folder)}`, async () => {
      assert.equal((await post('/list', { folder })).status, 400);
    });
  }
});

describe('building', () => {
  it('lists, reads and serves known docs only', async () => {
    assert.deepEqual((await (await post('/list', {})).json()).addOns, ['demo']);
    assert.equal((await (await post('/read', { folder: 'demo', path: 'logic.js' })).json()).contents, 'x');
    assert.equal((await (await post('/docs', { name: 'llms.txt' })).json()).text, 'docs here');
    assert.equal((await post('/docs', { name: '../../secret.txt' })).status, 400);
  });

  it('scaffolds with a stable id and installs test tools', async () => {
    ran.length = 0;
    const r = await post('/scaffold', { folder: 'new-tool', name: 'New Tool', target: 'browser' });
    assert.equal(r.status, 200);
    assert.ok(ran[0].args.includes('com.cp.built.newtool'));
    assert.deepEqual(ran[1].args.slice(0, 1), ['install']);
  });

  it('will not scaffold over an existing Add On', async () => {
    assert.equal((await post('/scaffold', { folder: 'demo', name: 'D', target: 'app' })).status, 400);
  });

  it('runs tests and install in the Add On folder', async () => {
    ran.length = 0;
    await writeFile(join(workspace, 'demo', 'manifest.json'), JSON.stringify({ html: 'index.html' }));
    await writeFile(join(workspace, 'demo', 'index.html'), '<script src="logic.js"></script>');
    await post('/test', { folder: 'demo' });
    await post('/install', { folder: 'demo' });
    assert.equal(ran[0].cwd, join(workspace, 'demo'));
    assert.deepEqual(ran[0].args, ['test']);
    assert.equal(ran[1].args[1], 'install');
  });
});

describe('sharing to Universe', () => {
  it('needs a name and the agreement', async () => {
    assert.equal((await post('/share', { folder: 'demo', builderName: '', agreed: true })).status, 400);
    assert.equal((await post('/share', { folder: 'demo', builderName: 'Sam', agreed: false })).status, 400);
  });

  it('packs the Add On, sends it with the name, and remembers the submission', async () => {
    const r = await post('/share', { folder: 'demo', builderName: 'Sam', title: 'Demo', description: 'd', agreed: true, builderKey: 'k' });
    assert.equal(r.status, 200);
    const sent = shareCalls.find((c) => c.u === 'https://share.test/submissions').body;
    assert.equal(sent.builderName, 'Sam');
    assert.equal(Buffer.from(sent.addOn, 'base64').toString(), 'PK-fake');
    const status = await (await post('/share-status', { folder: 'demo' })).json();
    assert.equal(status.status, 'published');
  });

  it('says an Add On that was never shared is not shared', async () => {
    await mkdir(join(workspace, 'other'), { recursive: true });
    assert.equal((await (await post('/share-status', { folder: 'other' })).json()).shared, false);
  });
});

describe('a sharing service that is asleep', () => {
  // Its host answers 502 to 504 until the service is up again: wait for it rather than fail.
  async function sharing(answers) {
    const calls = [];
    const fetchImpl = async (u, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(u).pathname}`);
      const status = answers.shift() ?? 200;
      if (status >= 500) return new Response('', { status });
      return new Response(JSON.stringify(u.endsWith('/submissions') ? { id: 'b'.repeat(24), title: 'Demo' } : { ok: true }), { status: u.endsWith('/submissions') ? 201 : 200 });
    };
    const runner = async (command, args) => {
      if (args[1] === 'pack') await writeFile(args[args.indexOf('--out') + 1], 'PK-fake');
      return { ok: true, code: 0, output: '' };
    };
    const helper = createHelper({ workspace, sdkRoot, runner, shareUrl: 'https://share.test', fetchImpl, checkPage: false, shareWaitMs: 1 });
    await new Promise((r) => helper.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${helper.address().port}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ folder: 'demo', builderName: 'Sam', title: 'Demo', agreed: true }),
    });
    helper.close();
    return { status: r.status, body: await r.json(), calls };
  }

  it('wakes it first, then shares once', async () => {
    const { status, calls } = await sharing([502, 503, 200, 201]);
    assert.equal(status, 200);
    assert.deepEqual(calls, ['GET /health', 'GET /health', 'GET /health', 'POST /submissions']);
  });

  it('sends the share again when the host was still waking it', async () => {
    const { status, calls } = await sharing([200, 502, 201]);
    assert.equal(status, 200);
    assert.deepEqual(calls.filter((c) => c.startsWith('POST')).length, 2);
  });

  it('says plainly that nothing was shared when it never wakes', async () => {
    const { status, body } = await sharing(Array(40).fill(502));
    assert.equal(status, 400);
    assert.match(body.error, /isn't answering right now\. Nothing was shared/);
  });
});

describe('only working Add Ons get installed', () => {
  it('fails the tests when a page script would not load, and then refuses to install', async () => {
    await post('/write', { folder: 'demo', path: 'logic.js', contents: "import { Luna } from 'luna';\nexport const x = 1;" });
    const r = await (await post('/test', { folder: 'demo' })).json();
    assert.equal(r.ok, false);
    assert.match(r.output, /logic\.js: Cannot use import statement/);
    assert.equal((await post('/install', { folder: 'demo' })).status, 400);
  });

  it('installs once the tests pass again, and not after a later change', async () => {
    await post('/write', { folder: 'demo', path: 'logic.js', contents: 'globalThis.ok = 1;' });
    assert.equal((await (await post('/test', { folder: 'demo' })).json()).ok, true);
    assert.equal((await post('/install', { folder: 'demo' })).status, 200);
    await post('/write', { folder: 'demo', path: 'logic.js', contents: 'globalThis.ok = 2;' });
    assert.equal((await post('/install', { folder: 'demo' })).status, 400);
  });

  it('names a script the page loads that is missing', async () => {
    await writeFile(join(workspace, 'demo', 'index.html'), '<script src="gone.js"></script>');
    const r = await (await post('/test', { folder: 'demo' })).json();
    assert.match(r.output, /gone\.js, which is missing/);
    await writeFile(join(workspace, 'demo', 'index.html'), '<script src="logic.js"></script>');
  });
});

describe('the SDK docs', () => {
  it('serves the API reference index and its pages', async () => {
    assert.match((await (await post('/docs', { name: 'api/index.md' })).json()).text, /classes\/Session\.md/);
    assert.equal((await post('/docs', { name: 'api/classes/Session.md' })).status, 200);
  });

  it('serves a long page in parts, losing nothing', async () => {
    let text = '';
    let offset = 0;
    for (let i = 0; i < 5 && offset !== null; i++) {
      const part = await (await post('/docs', { name: 'api/classes/Session.md', offset })).json();
      text += part.text;
      offset = part.next;
    }
    assert.equal(text.length, 65000);
    assert.equal(offset, null);
  });

  it('serves a short page whole, with no paging fields', async () => {
    assert.deepEqual(await (await post('/docs', { name: 'QUICKSTART.md' })).json(), { name: 'QUICKSTART.md', text: 'quick' });
  });

  for (const name of ['api/../../secret.txt', 'api/classes/../../../secret.txt', '../secret.txt', 'api/classes/Missing.md', '/etc/passwd', 'api/other/X.md']) {
    it(`refuses ${name}`, async () => {
      assert.equal((await post('/docs', { name })).status, 400);
    });
  }
});

describe('icons', () => {
  it('turns icon.svg into icon.png with Quick Look and points the manifest at it', async () => {
    const { iconFromSvg } = await import('../server.mjs');
    const { execFile } = await import('node:child_process');
    const dir = join(workspace, 'icon-test');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: 'x', title: 'T', html: 'index.html' }));
    await writeFile(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="16" y="16" width="480" height="480" rx="96" fill="#2a2e31"/><circle cx="256" cy="256" r="120" fill="#ffba00"/></svg>');
    const realRunner = (command, args, { cwd, timeout }) => new Promise((done) => execFile(command, args, { cwd, timeout }, (e, out, err) => done({ ok: !e, output: `${out}${err}` })));
    const note = await iconFromSvg(dir, realRunner);
    assert.match(note, /Made icon\.png/);
    assert.equal(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).icon, 'icon.png');
    const png = await readFile(join(dir, 'icon.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 512);
  });

  it('leaves an Add On with a PNG icon alone', async () => {
    const { iconFromSvg } = await import('../server.mjs');
    const dir = join(workspace, 'icon-test2');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: 'x', title: 'T', html: 'index.html', icon: 'art.png' }));
    await writeFile(join(dir, 'art.png'), 'png');
    await writeFile(join(dir, 'icon.svg'), '<svg/>');
    assert.equal(await iconFromSvg(dir, async () => { throw new Error('should not run'); }), null);
  });
});
