// Opens real pages in headless Chrome with the real SDK: needs Chrome and the LUNA Builder SDK.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageRunProblems } from '../server.mjs';

const SDK = join(homedir(), 'Library/Application Support/LUNA Builder SDK');
const cli = join(SDK, 'dist/cli.js');
const runner = (command, args, { cwd, timeout }) => new Promise((done) => execFile(command, args, { cwd, timeout }, (e, out, err) => done({ ok: !e, output: `${out}${err}` })));

async function page(main) {
  const dir = await mkdtemp(join(tmpdir(), 'page-'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: 'com.x.t', title: 'T', html: 'index.html', target: 'browser' }));
  await writeFile(join(dir, 'index.html'), '<div id="out"></div><script src="vendor/luna.global.js"></script><script src="main.js"></script>');
  await cp(join(SDK, 'dist/luna.global.js'), join(dir, 'vendor/luna.global.js'), { recursive: true });
  await writeFile(join(dir, 'main.js'), main);
  return dir;
}

describe('opening the page', { timeout: 120000 }, () => {
  it('passes a page that connects', async () => {
    const dir = await page("Luna.connect().then(async (luna) => { const s = await luna.session(); document.getElementById('out').textContent = s.name.value; });");
    assert.equal(await pageRunProblems(dir, { node: process.execPath, cli, runner }), null);
  });

  it('fails a page that calls an API that does not exist', async () => {
    const dir = await page('Luna.onLoad(() => {});');
    const problems = await pageRunProblems(dir, { node: process.execPath, cli, runner });
    assert.ok(Array.isArray(problems) && problems.some((p) => /onLoad is not a function|page error/.test(p)), String(problems));
  });

  it('fails a page that never connects', async () => {
    const dir = await page("document.getElementById('out').textContent = 'waiting';");
    assert.ok(Array.isArray(await pageRunProblems(dir, { node: process.execPath, cli, runner })));
  });
});
