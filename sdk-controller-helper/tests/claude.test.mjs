// The subscription bridge end to end, with a stand-in for Claude Code's CLI.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelper } from '../server.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.mjs');
const ORIGIN = 'ua-content://com.cp.sdkcontroller';
let base; let server; let url;

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'claude-'));
  server = createHelper({ workspace: base, checkPage: false, port: 0, claude: { claudeBin: FAKE, baseEnv: { ...process.env, ANTHROPIC_API_KEY: 'sk-should-not-pass' } } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await rm(base, { recursive: true, force: true }); });

const post = async (path, body) => {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

let lastRecord = null;
async function events(turnId, until) {
  const all = [];
  let after = 0;
  for (let i = 0; i < 20; i++) {
    const { body } = await post('/claude/poll', { turnId, after });
    all.push(...body.events);
    after = body.next;
    if (body.events.some(until)) return all;
  }
  return all;
}

const TOOLS = [{ name: 'set_track', description: 'Change a track', schema: { type: 'object', properties: { track: { type: 'string' } } } }];

describe('Claude with the user\'s subscription', () => {
  it('reports the sign-in', async () => {
    const { body } = await post('/claude/status', {});
    assert.deepEqual(body, { installed: true, loggedIn: true, authMethod: 'claude.ai', subscription: 'max' });
  });

  it('hands Claude the tools, waits for the panel to run each call, and streams the reply', async () => {
    // The fake CLI was started with the helper's port, which the MCP url carries.
    const { body: { turnId } } = await post('/claude/turn', { text: 'mute the bass', system: 'Be brief.', tools: TOOLS });
    const first = await events(turnId, (e) => e.type === 'tool');
    const call = first.find((e) => e.type === 'tool');
    assert.equal(call.name, 'set_track');
    assert.deepEqual(call.input, { track: 'Bass' });
    await post('/claude/tool-result', { turnId, callId: call.callId, content: '{"ok":true}', isError: false });
    const rest = await events(turnId, (e) => e.type === 'done');
    const done = rest.find((e) => e.type === 'done');
    assert.equal(done.isError, false);
    assert.equal(done.text, 'Done: {"ok":true}');
    assert.equal(done.sessionId, 'sess-1');
    assert.equal(rest.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Done: {"ok":true}');
  });

  it('runs Claude locked down, on the subscription, and resumes a conversation', async () => {
    const { body: { turnId } } = await post('/claude/turn', { text: 'again', system: 'S', tools: TOOLS, sessionId: 'sess-9' });
    const call = (await events(turnId, (e) => e.type === 'tool')).find((e) => e.type === 'tool');
    await post('/claude/tool-result', { turnId, callId: call.callId, content: 'ok' });
    const done = (await events(turnId, (e) => e.type === 'done')).find((e) => e.type === 'done');
    assert.equal(done.sessionId, 'sess-9');
    const { args: bridgeArgs, apiKey, idle } = done.record;
    assert.equal(apiKey, null, 'an API key in the environment would bill it instead of the subscription');
    assert.equal(idle, '0');
    const after = (name) => bridgeArgs[bridgeArgs.indexOf(name) + 1];
    assert.equal(after('--tools'), '');
    assert.equal(after('--allowedTools'), 'mcp__sdc');
    assert.equal(after('--setting-sources'), 'project');
    assert.equal(after('--resume'), 'sess-9');
    assert.ok(bridgeArgs.includes('--strict-mcp-config'));
  });

  it('keeps pages off the MCP endpoint, and unknown tokens out', async () => {
    const r = await fetch(`${url}/mcp/${'a'.repeat(36)}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' });
    assert.equal(r.status, 403);
    const r2 = await fetch(`${url}/mcp/${'a'.repeat(36)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 404);
  });
});

describe('finding Claude Code', async () => {
  const { findClaude } = await import('../claude.mjs');
  const { mkdtemp: tmp, mkdir: md, writeFile: wf, chmod } = await import('node:fs/promises');

  it('finds an npm install under nvm, which the helper\'s login PATH never includes', async () => {
    const home = await tmp(join(tmpdir(), 'home-'));
    const bin = join(home, '.nvm/versions/node/v22.11.0/bin');
    await md(bin, { recursive: true });
    await wf(join(bin, 'claude'), '#!/usr/bin/env node');
    await chmod(join(bin, 'claude'), 0o755);
    assert.equal(findClaude({ PATH: '/usr/bin:/bin' }, { home, loginShell: () => null }), join(bin, 'claude'));
  });

  it('asks the login shell when no known folder has it', () => {
    assert.equal(findClaude({ PATH: '/usr/bin:/bin' }, { home: '/nonexistent', loginShell: () => '/somewhere/claude' }), '/somewhere/claude');
  });

  it('says not found rather than guessing', () => {
    assert.equal(findClaude({ PATH: '/usr/bin:/bin' }, { home: '/nonexistent', loginShell: () => null }), null);
  });
});
