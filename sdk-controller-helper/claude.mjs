// Claude with the user's own subscription: runs their Claude Code CLI in the background and lends it
// SDK Controller's tools over MCP. Each tool call goes back to the panel, which approves and runs it
// exactly as it does for other providers, so Claude Code's own tools (shell, files) are all off.
//
// Panel side (JSON over POST, as the rest of the helper):
//   /claude/status      is Claude Code installed and signed in
//   /claude/login       open the browser sign-in
//   /claude/turn        { text, system, tools, sessionId?, model? } -> { turnId }
//   /claude/poll        { turnId, after } -> { events, next }  (waits up to 20 s for one)
//   /claude/tool-result { turnId, callId, content, isError }
//   /claude/stop        { turnId }
// Claude Code side: an MCP server at /mcp/<token>, one token per turn.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const POLL_WAIT = 20000;
const KEEP_DONE = 10 * 60 * 1000;

class Refused extends Error {}

/** Claude Code's CLI: the one on PATH, else where its installers put it. */
export function findClaude(env = process.env) {
  const candidates = [
    ...(env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, 'claude')),
    join(homedir(), '.local/bin/claude'),
    join(homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function capture(bin, args, { env, timeout = 20000 }) {
  return new Promise((done) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
    child.on('error', (e) => { clearTimeout(timer); done({ code: -1, out: e.message }); });
  });
}

export function createClaudeBridge({ port, claudeBin = findClaude(), spawnImpl = spawn, baseEnv = process.env } = {}) {
  const portOf = typeof port === 'function' ? port : () => port;
  const turns = new Map();
  const byToken = new Map();

  // The subscription, not an API key: a key in the environment would bill that instead.
  const env = () => {
    const e = { ...baseEnv };
    delete e.ANTHROPIC_API_KEY;
    delete e.ANTHROPIC_AUTH_TOKEN;
    // Approvals can take as long as the user takes: never time a tool call out or background it.
    return { ...e, MCP_TOOL_TIMEOUT: '86400000', CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' };
  };

  function emit(turn, event) {
    turn.events.push(event);
    for (const wake of turn.waiters.splice(0)) wake();
  }

  function finish(turn, event) {
    if (turn.finished) return;
    turn.finished = true;
    for (const [, call] of turn.calls) call.resolve({ content: 'The request ended before this ran.', isError: true });
    turn.calls.clear();
    emit(turn, event);
    setTimeout(() => { turns.delete(turn.id); byToken.delete(turn.token); }, KEEP_DONE).unref?.();
  }

  function onLine(turn, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'system' && msg.subtype === 'init') {
      turn.sessionId = msg.session_id ?? turn.sessionId;
      const ours = (msg.mcp_servers ?? []).find((s) => s.name === 'sdc');
      if (ours && ours.status !== 'connected' && ours.status !== 'pending') {
        emit(turn, { type: 'notice', text: `SDK Controller's tools did not connect to Claude (${ours.status}).` });
      }
    } else if (msg.type === 'stream_event' && msg.event?.delta?.type === 'text_delta' && !msg.parent_tool_use_id) {
      emit(turn, { type: 'text', text: msg.event.delta.text });
    } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
      emit(turn, { type: 'notice', text: `Claude is retrying (${msg.error}).` });
    } else if (msg.type === 'result') {
      turn.sessionId = msg.session_id ?? turn.sessionId;
      const failed = msg.is_error === true || (msg.subtype && msg.subtype !== 'success');
      finish(turn, { type: 'done', text: typeof msg.result === 'string' ? msg.result : '', sessionId: turn.sessionId, isError: failed, subtype: msg.subtype ?? null, ...(msg.record ? { record: msg.record } : {}) });
    }
  }

  async function startTurn({ text, system, tools, sessionId, model }) {
    if (!claudeBin) throw new Refused('Claude Code is not installed. Run Install SDK Controller again and choose to set up Claude.');
    if (typeof text !== 'string' || !text.trim()) throw new Refused('Nothing to send.');
    if (!Array.isArray(tools)) throw new Refused('tools is required.');
    const id = randomBytes(9).toString('hex');
    const token = randomBytes(18).toString('hex');
    const dir = join(tmpdir(), 'sdk-controller-claude', id);
    await mkdir(dir, { recursive: true });
    const config = join(dir, 'mcp.json');
    await writeFile(config, JSON.stringify({ mcpServers: { sdc: { type: 'http', url: `http://127.0.0.1:${portOf()}/mcp/${token}`, timeout: 86400000 } } }));
    const args = [
      '-p', text,
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', config, '--strict-mcp-config',
      // No shell, no files, no web: only SDK Controller's tools, which the panel approves.
      '--tools', '',
      '--allowedTools', 'mcp__sdc',
      '--system-prompt', system ?? '',
      // An empty folder, and only its own (absent) project settings: none of the user's hooks or memory.
      '--setting-sources', 'project',
    ];
    if (sessionId) args.push('--resume', String(sessionId));
    if (model) args.push('--model', String(model));
    const child = spawnImpl(claudeBin, args, { cwd: dir, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    const turn = { id, token, tools, child, events: [], waiters: [], calls: new Map(), sessionId: sessionId ?? null, finished: false, stderr: '' };
    turns.set(id, turn);
    byToken.set(token, turn);
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += d;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) onLine(turn, line);
    });
    child.stderr.on('data', (d) => { turn.stderr = (turn.stderr + d).slice(-4000); });
    child.on('error', (e) => finish(turn, { type: 'done', text: '', isError: true, subtype: 'spawn_failed', error: e.message }));
    child.on('close', (code) => {
      if (buffer.trim()) onLine(turn, buffer);
      finish(turn, { type: 'done', text: '', isError: true, subtype: turn.stopped ? 'stopped' : 'exited', error: turn.stopped ? null : `Claude Code stopped (exit ${code}). ${turn.stderr.trim().slice(-600)}` });
    });
    return { turnId: id };
  }

  const need = (turnId) => {
    const turn = turns.get(turnId);
    if (!turn) throw new Refused('That request has ended.');
    return turn;
  };

  const routes = {
    async '/claude/status'() {
      if (!claudeBin) return { installed: false, loggedIn: false };
      const r = await capture(claudeBin, ['auth', 'status', '--json'], { env: env() });
      try {
        const s = JSON.parse(r.out.slice(r.out.indexOf('{')));
        return { installed: true, loggedIn: s.loggedIn === true, authMethod: s.authMethod ?? null, subscription: s.subscriptionType ?? null };
      } catch {
        return { installed: true, loggedIn: false, error: r.out.trim().slice(-300) };
      }
    },
    async '/claude/login'() {
      if (!claudeBin) throw new Refused('Claude Code is not installed.');
      // Opens the browser; Claude Code finishes the sign-in when the user approves it there.
      const child = spawnImpl(claudeBin, ['auth', 'login', '--claudeai'], { env: env(), stdio: 'ignore', detached: true });
      child.unref?.();
      return { ok: true };
    },
    '/claude/turn': startTurn,
    async '/claude/poll'({ turnId, after = 0 }) {
      const turn = need(turnId);
      if (turn.events.length <= after && !turn.finished) {
        await new Promise((wake) => {
          turn.waiters.push(wake);
          setTimeout(wake, POLL_WAIT).unref?.();
        });
      }
      return { events: turn.events.slice(after), next: turn.events.length };
    },
    async '/claude/tool-result'({ turnId, callId, content, isError }) {
      const call = need(turnId).calls.get(callId);
      if (!call) throw new Refused('That tool call is not waiting.');
      need(turnId).calls.delete(callId);
      call.resolve({ content: typeof content === 'string' ? content : JSON.stringify(content), isError: isError === true });
      return { ok: true };
    },
    async '/claude/stop'({ turnId }) {
      const turn = turns.get(turnId);
      if (!turn || turn.finished) return { ok: true };
      turn.stopped = true;
      turn.child.kill('SIGINT');
      return { ok: true };
    },
  };

  /** One MCP JSON-RPC request from Claude Code. */
  async function mcp(turn, msg) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sdk-controller', version: '1.0.0' } });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: turn.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
      case 'tools/call': {
        if (turn.finished) return reply({ content: [{ type: 'text', text: 'The request has ended.' }], isError: true });
        const callId = randomBytes(8).toString('hex');
        const result = await new Promise((resolve) => {
          turn.calls.set(callId, { resolve });
          emit(turn, { type: 'tool', callId, name: msg.params?.name, input: msg.params?.arguments ?? {} });
        });
        return reply({ content: [{ type: 'text', text: result.content }], isError: result.isError });
      }
      default:
        if (msg.id === undefined) return null; // a notification
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } };
    }
  }

  /** Handles /mcp/<token>; answers false for any other path. */
  async function handleMcp(req, res, readBody) {
    const m = req.url.match(/^\/mcp\/([a-f0-9]{36})$/);
    if (!m) return false;
    const turn = byToken.get(m[1]);
    if (!turn) {
      res.writeHead(404).end();
      return true;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return true;
    }
    const body = await readBody();
    const batch = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(batch.map((msg) => mcp(turn, msg)))).filter(Boolean);
    if (!out.length) {
      res.writeHead(202).end();
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
    return true;
  }

  return { routes, handleMcp, turns };
}
