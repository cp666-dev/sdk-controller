// The adapters against canned streams, and the conversation loop with a scripted model. No network.
import { describe, expect, it } from 'vitest';

await import('../providers.js');
await import('../agent.js');
const { PROVIDERS, ProviderError, checkBaseUrl, toOpenAIMessages } = globalThis.Providers;
const { Agent, checkSchema } = globalThis.AgentCore;

function sse(events) {
  const text = events.map((e) => (typeof e === 'string' ? `data: ${e}\n\n` : `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function capture(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return typeof response === 'function' ? response(calls.length) : response;
  };
  return { calls, fetchImpl };
}

const TOOL = { name: 'set', description: 'd', schema: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'], additionalProperties: false } };
const base = { apiKey: 'sk-test', model: 'claude-opus-5-5', system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [TOOL], retryDelay: 1 };

describe('Anthropic', () => {
  const stream = PROVIDERS.anthropic.stream;

  it('sends the headers and fields the model needs', async () => {
    const { calls, fetchImpl } = capture(sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]));
    await stream({ ...base, fetchImpl });
    const { url, headers, body } = calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.effort).toBe('high');
    expect(body.thinking).toBeUndefined();
    expect(body.tools[0]).toMatchObject({ input_schema: TOOL.schema, eager_input_streaming: true });
  });

  it('leaves out what an unknown model might reject', async () => {
    const { calls, fetchImpl } = capture(sse([]));
    await stream({ ...base, model: 'claude-3-haiku', fetchImpl });
    expect(calls[0].body.output_config).toBeUndefined();
    expect(calls[0].body.fallbacks).toBeUndefined();
  });

  it('assembles text, a tool call and thinking from the stream', async () => {
    const { fetchImpl } = capture(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'On ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'it' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'set', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"x"' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':1}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]));
    let shown = '';
    const r = await stream({ ...base, fetchImpl, onText: (t) => { shown += t; } });
    expect(shown).toBe('On it');
    expect(r.text).toBe('On it');
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'set', input: { x: 1 } }]);
    expect(r.native.content[0]).toMatchObject({ type: 'thinking', signature: 'sig' });
    expect(r.native.content[2].input).toEqual({ x: 1 });
  });

  it('flags tool input that is not valid JSON instead of guessing', async () => {
    const { fetchImpl } = capture(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'set', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    ]));
    const r = await stream({ ...base, fetchImpl });
    expect(r.stopReason).toBe('max_tokens');
    expect(r.toolCalls[0].parseError).toMatch(/INVALID_JSON/);
  });

  it('replays its own thinking blocks unchanged', async () => {
    const content = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'x' }];
    const { calls, fetchImpl } = capture(sse([]));
    await stream({ ...base, fetchImpl, messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'x', native: { provider: 'anthropic', content } }, { role: 'user', text: 'b' }] });
    expect(calls[0].body.messages[1].content).toEqual(content);
  });

  it('retries a 529, then succeeds', async () => {
    const { calls, fetchImpl } = capture((n) => (n === 1 ? new Response('{}', { status: 529 }) : sse([])));
    await stream({ ...base, fetchImpl });
    expect(calls.length).toBe(2);
  });

  it('does not retry a bad key, and the message does not contain it', async () => {
    const { calls, fetchImpl } = capture(new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }));
    const err = await stream({ ...base, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(calls.length).toBe(1);
    expect(err.message).toMatch(/401.*Check the API key/);
    expect(err.message).not.toContain('sk-test');
  });
});

describe('OpenAI-style', () => {
  const stream = PROVIDERS.openai.stream;
  const delta = (d, finish = null) => JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] });

  it('assembles a tool call that arrives in pieces', async () => {
    const { calls, fetchImpl } = capture(sse([
      delta({ content: 'Sure' }),
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'set', arguments: '{"x"' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ':2}' } }] }),
      delta({}, 'tool_calls'),
      '[DONE]',
    ]));
    const r = await stream({ ...base, model: 'gpt-5', fetchImpl });
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer sk-test');
    expect(calls[0].body.max_completion_tokens).toBe(16000);
    expect(r).toMatchObject({ text: 'Sure', stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'set', input: { x: 2 } }] });
  });

  it('treats a content filter as a refusal', async () => {
    const { fetchImpl } = capture(sse([delta({}, 'content_filter'), '[DONE]']));
    expect((await stream({ ...base, model: 'gpt-5', fetchImpl })).stopReason).toBe('refusal');
  });

  it('runs a local server with no key at its own base URL', async () => {
    const { calls, fetchImpl } = capture(sse(['[DONE]']));
    await PROVIDERS.compatible.stream({ ...base, apiKey: '', baseUrl: 'http://localhost:11434/v1/', model: 'llama', fetchImpl });
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body.max_tokens).toBe(16000);
  });

  it('needs a base URL when none is built in', async () => {
    await expect(PROVIDERS.compatible.stream({ ...base, apiKey: '', model: 'x', fetchImpl: async () => { throw new Error('no'); } })).rejects.toThrow(/base URL/);
  });

  it('rebuilds a conversation that started on another provider', () => {
    const out = toOpenAIMessages('sys', [
      { role: 'user', text: 'a' },
      { role: 'assistant', text: '', toolCalls: [{ id: 't', name: 'set', input: { x: 1 } }], native: { provider: 'anthropic', content: [{ type: 'thinking' }] } },
      { role: 'tool', results: [{ id: 't', name: 'set', content: 'ok' }] },
    ]);
    expect(out[2].tool_calls[0].function.arguments).toBe('{"x":1}');
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 't', content: 'ok' });
  });
});

describe('base URLs', () => {
  it('only sends a key over https or to this machine', () => {
    expect(checkBaseUrl('https://openrouter.ai/api/v1')).toBeNull();
    expect(checkBaseUrl('http://localhost:11434/v1')).toBeNull();
    expect(checkBaseUrl('http://example.com/v1')).toMatch(/https/);
    expect(checkBaseUrl('nonsense')).toMatch(/valid/);
  });
});

describe('checking tool input', () => {
  it('finds missing, wrong and unknown fields', () => {
    expect(checkSchema(TOOL.schema, { x: 1 })).toEqual([]);
    expect(checkSchema(TOOL.schema, {})[0]).toMatch(/required/);
    expect(checkSchema(TOOL.schema, { x: 'a' })[0]).toMatch(/number/);
    expect(checkSchema(TOOL.schema, { x: 1, y: 2 })[0]).toMatch(/known field/);
  });
});

describe('the conversation loop', () => {
  const read = { name: 'read', description: '', schema: { type: 'object', properties: {} }, mode: 'read', describe: () => 'read' };
  const edit = { name: 'edit', description: '', schema: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] }, mode: 'edit', describe: () => 'edit' };

  function agentWith(turns, { approve = async (c) => c.map(() => true), seen = [] } = {}) {
    let i = 0;
    return new Agent({
      provider: () => ({ model: 'm', stream: async ({ messages }) => { seen.push(structuredClone(messages)); return turns[i++]; } }),
      system: () => 's',
      tools: [read, edit],
      execute: async (calls) => calls.map((c) => ({ content: { ran: c.tool.name } })),
      approve,
    });
  }
  const call = (name, input = {}, id = name) => ({ id, name, input });

  it('runs reads without asking and goes round until the model is done', async () => {
    let asked = 0;
    const a = agentWith([{ text: '', toolCalls: [call('read')], stopReason: 'tool_use' }, { text: 'done', toolCalls: [], stopReason: 'end' }], { approve: async () => { asked++; return []; } });
    expect(await a.send('go')).toMatchObject({ outcome: 'done', text: 'done' });
    expect(asked).toBe(0);
    expect(a.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('runs build steps marked auto without asking, so a build needs no clicks', async () => {
    let asked = 0;
    const auto = { name: 'build', description: '', schema: { type: 'object', properties: {} }, mode: 'auto', describe: () => 'build' };
    let i = 0;
    const turns = [{ text: '', toolCalls: [call('build')], stopReason: 'tool_use' }, { text: 'built', toolCalls: [], stopReason: 'end' }];
    const a = new Agent({
      provider: () => ({ model: 'm', stream: async () => turns[i++] }),
      system: () => 's',
      tools: [read, edit, auto],
      execute: async (calls) => calls.map(() => ({ content: 'ok' })),
      approve: async (c) => { asked += c.length; return c.map(() => true); },
    });
    expect((await a.send('go')).outcome).toBe('done');
    expect(asked).toBe(0);
  });

  it('tells the model when an edit is declined, and does not run it', async () => {
    const a = agentWith([{ text: '', toolCalls: [call('edit', { x: 1 })], stopReason: 'tool_use' }, { text: 'ok', toolCalls: [], stopReason: 'end' }], { approve: async () => [false] });
    await a.send('go');
    expect(a.messages[2].results[0]).toMatchObject({ isError: true, content: expect.stringMatching(/declined/) });
  });

  it('never runs input that fails its schema', async () => {
    let approved = 0;
    const a = agentWith([{ text: '', toolCalls: [call('edit', { x: 'no' })], stopReason: 'tool_use' }, { text: 'ok', toolCalls: [], stopReason: 'end' }], { approve: async (c) => { approved += c.length; return c.map(() => true); } });
    await a.send('go');
    expect(approved).toBe(0);
    expect(a.messages[2].results[0].content).toMatch(/INVALID_INPUT/);
  });

  it('never runs a call from a reply cut off at the token limit', async () => {
    let approved = 0;
    const a = agentWith([{ text: '', toolCalls: [call('edit', { x: 1 })], stopReason: 'max_tokens' }, { text: 'ok', toolCalls: [], stopReason: 'end' }], { approve: async (c) => { approved += c.length; return c.map(() => true); } });
    await a.send('go');
    expect(approved).toBe(0);
    expect(a.messages[2].results[0].content).toMatch(/cut off/);
  });

  it('drops a refused turn without running anything in it', async () => {
    const a = agentWith([{ text: 'no', toolCalls: [call('edit', { x: 1 })], stopReason: 'refusal' }]);
    expect((await a.send('go')).outcome).toBe('refused');
    expect(a.messages).toEqual([]);
  });

  it('answers every open call when the request fails, so the next one is valid', async () => {
    let n = 0;
    const a = new Agent({
      provider: () => ({ model: 'm', stream: async () => { if (n++ === 0) return { text: '', toolCalls: [call('edit', { x: 1 })], stopReason: 'tool_use' }; throw new Error('boom'); } }),
      system: () => 's',
      tools: [read, edit],
      execute: async () => { throw new Error('engine gone'); },
      approve: async (c) => c.map(() => true),
    });
    await expect(a.send('go')).rejects.toThrow('engine gone');
    expect(a.messages.at(-1).role).toBe('tool');
    expect(a.messages.at(-1).results[0].isError).toBe(true);
    expect(a.running).toBe(false);
  });

  it('stops when told to while waiting for approval', async () => {
    const a = agentWith([{ text: '', toolCalls: [call('edit', { x: 1 })], stopReason: 'tool_use' }], {
      approve: (c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(c.map(() => false)))),
    });
    const running = a.send('go');
    await new Promise((r) => setTimeout(r, 5));
    a.stop();
    expect((await running).outcome).toBe('stopped');
    expect(a.messages.at(-1).role).toBe('tool');
  });
});

describe('free providers', () => {
  const { geminiSchema, listModels, pickModel } = globalThis.Providers;

  it('rewrites every tool schema into what Gemini accepts', async () => {
    await import('../logic.js').catch(() => {});
    const bad = (s) => JSON.stringify(s).includes('additionalProperties');
    const schema = { type: 'object', additionalProperties: false, properties: { d: { type: 'integer', enum: [1, 2, 4] }, v: { description: 'any' }, list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } } } } };
    const out = geminiSchema(schema);
    expect(bad(out)).toBe(false);
    expect(out.properties.d.enum).toBeUndefined();
    expect(out.properties.d.description).toMatch(/One of: 1, 2, 4/);
    expect(out.properties.v.type).toBe('string');
    expect(schema.additionalProperties).toBe(false);
  });

  it('sends Gemini the rewritten schemas, at its OpenAI-style endpoint', async () => {
    const { calls, fetchImpl } = capture(sse(['[DONE]']));
    await PROVIDERS.google.stream({ ...base, model: 'gemini-2.5-flash', fetchImpl, tools: [{ ...TOOL, schema: { ...TOOL.schema } }] });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(JSON.stringify(calls[0].body.tools)).not.toContain('additionalProperties');
  });

  it('lists models and picks the newest Flash, never lite', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ data: ['models/gemini-2.5-flash', 'models/gemini-3.0-flash', 'models/gemini-3.0-flash-lite', 'models/gemini-2.5-pro'].map((id) => ({ id })) }));
    const ids = await listModels({ provider: PROVIDERS.google, apiKey: 'k', fetchImpl });
    expect(ids).toContain('gemini-3.0-flash');
    expect(pickModel(PROVIDERS.google, ids)).toBe('gemini-3.0-flash');
  });

  it('picks Groq\'s open model', () => {
    expect(pickModel(PROVIDERS.groq, ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'whisper-large-v3'])).toBe('openai/gpt-oss-120b');
  });

  it('offers a free provider first, with a link to get a key', () => {
    const [first] = Object.values(PROVIDERS);
    expect(first.free).toBe(true);
    expect(first.keyUrl).toMatch(/^https:/);
  });
});

describe('Gemini as it really answers', () => {
  const { geminiFlashModels } = globalThis.Providers;
  const geminiDelta = (call) => JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [call] }, index: 0 }] });
  const parallel = () => sse([
    geminiDelta({ extra_content: { google: { thought_signature: 'SIG' } }, function: { arguments: '{"x":1}', name: 'set' }, id: 'call_1', type: 'function' }),
    geminiDelta({ function: { arguments: '{"x":2}', name: 'set' }, id: 'call_2', type: 'function' }),
    JSON.stringify({ choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop', index: 0 }] }),
    '[DONE]',
  ]);

  it('reads parallel calls that come whole, with no index (captured 2026-11-21)', async () => {
    const { fetchImpl } = capture(parallel());
    const r = await PROVIDERS.google.stream({ ...base, model: 'gemini-3.6-flash', fetchImpl });
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls.map((c) => [c.id, c.name, c.input.x])).toEqual([['call_1', 'set', 1], ['call_2', 'set', 2]]);
    expect(r.toolCalls[0].extra).toEqual({ google: { thought_signature: 'SIG' } });
  });

  it('sends the thought signature back to Gemini, and never to OpenAI', async () => {
    const history = [{ role: 'user', text: 'a' }, { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'set', input: { x: 1 }, extra: { google: { thought_signature: 'SIG' } } }] }, { role: 'tool', results: [{ id: 'call_1', name: 'set', content: 'ok' }] }];
    const g = capture(sse(['[DONE]']));
    await PROVIDERS.google.stream({ ...base, model: 'gemini-3.6-flash', messages: history, fetchImpl: g.fetchImpl });
    expect(g.calls[0].body.messages[2].tool_calls[0].extra_content.google.thought_signature).toBe('SIG');
    const o = capture(sse(['[DONE]']));
    await PROVIDERS.openai.stream({ ...base, model: 'gpt-5', messages: history, fetchImpl: o.fetchImpl });
    expect(o.calls[0].body.messages[2].tool_calls[0].extra_content).toBeUndefined();
  });

  it('moves to the next Flash model when one has spent its free day, without waiting', async () => {
    const quota = [{ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash, description: Generate content requests per day limit exceeded on Free Tier.' } }];
    const seen = [];
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.8-flash-lite'].map((id) => ({ id: `models/${id}` })) }));
      const model = JSON.parse(init.body).model;
      seen.push(model);
      return model === 'gemini-3.8-flash' ? new Response(JSON.stringify(quota), { status: 429 }) : sse(['[DONE]']);
    };
    const switched = [];
    const started = Date.now();
    const r = await PROVIDERS.google.stream({ ...base, model: 'gemini-3.8-flash', fetchImpl, retryDelay: 1000, onModelChange: (next, spent) => switched.push([spent, next]) });
    expect(Date.now() - started).toBeLessThan(500);
    expect(seen).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash']);
    expect(switched).toEqual([['gemini-3.8-flash', 'gemini-3.7-flash']]);
    expect(r.model).toBe('gemini-3.7-flash');
  });

  it('says plainly when every free model is spent', async () => {
    const quota = new Response(JSON.stringify([{ error: { code: 429, message: 'requests per day limit exceeded on Free Tier.' } }]), { status: 429 });
    const fetchImpl = async (url) => (url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'models/gemini-3.8-flash' }] })) : quota.clone());
    await expect(PROVIDERS.google.stream({ ...base, model: 'gemini-3.8-flash', fetchImpl })).rejects.toThrow(/used up their free requests for today/);
  });

  it('lists only Flash chat models, newest first', () => {
    expect(geminiFlashModels(['gemini-3.6-flash', 'gemini-3.8-flash-lite', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-3.8-flash-tts'])).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview']);
  });
});

describe('a provider that runs the conversation itself (Claude subscription)', () => {
  // A stand-in for the helper's bridge: Claude asks for tools, then answers.
  function bridge(script) {
    const sent = { results: [], starts: [], stops: 0 };
    let events = [];
    return {
      sent,
      provider: () => ({
        agentic: true,
        model: '',
        async start(turn) { sent.starts.push(turn); events = script(sent); return { turnId: 't1' }; },
        async poll(turnId, after) { await new Promise((r) => setTimeout(r, 1)); const e = events.slice(after, after + 1); return { events: e, next: after + e.length }; },
        async toolResult(turnId, callId, content, isError) { sent.results.push({ callId, content, isError }); },
        async stop() { sent.stops++; },
      }),
    };
  }
  const tools = [
    { name: 'read', description: '', schema: { type: 'object', properties: {} }, mode: 'read', describe: () => 'read' },
    { name: 'edit', description: '', schema: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] }, mode: 'edit', describe: () => 'edit' },
  ];
  const agentOn = (b, approve = async (c) => c.map(() => true)) => new Agent({
    provider: b.provider, system: () => 'sys', tools,
    execute: async (calls) => calls.map((c) => ({ content: { ran: c.tool.name } })),
    approve,
  });

  it('runs each tool call through the panel and hands back the result', async () => {
    const b = bridge(() => [{ type: 'tool', callId: 'c1', name: 'read', input: {} }, { type: 'text', text: 'Hi' }, { type: 'done', text: 'Hi', sessionId: 's1', isError: false }]);
    const a = agentOn(b);
    let shown = '';
    const out = await a.send('go', { onText: (t) => { shown += t; } });
    expect(out).toEqual({ outcome: 'done', text: 'Hi' });
    expect(shown).toBe('Hi');
    expect(b.sent.results).toEqual([{ callId: 'c1', content: '{"ran":"read"}', isError: false }]);
    expect(b.sent.starts[0].tools.map((t) => t.name)).toEqual(['read', 'edit']);
    expect(b.sent.starts[0].system).toBe('sys');
  });

  it('asks before an edit, and tells Claude when it was declined', async () => {
    const b = bridge(() => [{ type: 'tool', callId: 'c1', name: 'edit', input: { x: 1 } }, { type: 'done', text: 'ok', isError: false }]);
    await agentOn(b, async () => [false]).send('go');
    expect(b.sent.results[0]).toMatchObject({ isError: true, content: expect.stringMatching(/declined/) });
  });

  it('refuses input that fails the schema, without asking', async () => {
    let asked = 0;
    const b = bridge(() => [{ type: 'tool', callId: 'c1', name: 'edit', input: { x: 'no' } }, { type: 'done', text: 'ok', isError: false }]);
    await agentOn(b, async (c) => { asked += c.length; return c.map(() => true); }).send('go');
    expect(asked).toBe(0);
    expect(b.sent.results[0].content).toMatch(/INVALID_INPUT/);
  });

  it('continues the same Claude conversation next time, and starts fresh after New', async () => {
    const b = bridge(() => [{ type: 'done', text: 'a', sessionId: 's1', isError: false }]);
    const a = agentOn(b);
    await a.send('one');
    await a.send('two');
    expect(b.sent.starts.map((s) => s.sessionId)).toEqual([undefined, 's1']);
    a.reset();
    await a.send('three');
    expect(b.sent.starts[2].sessionId).toBeUndefined();
  });

  it('says what went wrong when Claude fails', async () => {
    const b = bridge(() => [{ type: 'done', text: '', isError: true, subtype: 'exited', error: 'Claude Code stopped (exit 1). Not logged in' }]);
    await expect(agentOn(b).send('go')).rejects.toThrow(/Not logged in/);
  });

  it('stops Claude when the user presses Stop', async () => {
    const b = bridge(() => [{ type: 'tool', callId: 'c1', name: 'edit', input: { x: 1 } }, { type: 'done', text: '', subtype: 'stopped', isError: true }]);
    const a = agentOn(b, (c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(c.map(() => false)))));
    const running = a.send('go');
    await new Promise((r) => setTimeout(r, 20));
    a.stop();
    expect((await running).outcome).toBe('stopped');
    expect(b.sent.stops).toBe(1);
  });
});
