// SDK Controller: the LLM providers, behind one streaming call. No DOM and no LUNA.
//
// The page is a classic script with no bundler, so each adapter speaks its API with fetch rather
// than a vendor SDK. Every adapter takes the neutral conversation below and answers one turn.
//
//   { role: 'user', text }
//   { role: 'assistant', text, toolCalls: [{ id, name, input, parseError? }], native? }
//   { role: 'tool', results: [{ id, name, content, isError }] }
//
// `native` is the provider's own content for that turn. Anthropic's thinking blocks have to go back
// unchanged, so it is replayed when the same provider continues and rebuilt from text and toolCalls
// when the user has switched provider.

// Classic scripts share one global scope, so each file keeps its names to itself.
(() => {
class ProviderError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRY_LIMIT = 2;

/** One server-sent event at a time: `{ event, data }`, where data is the raw string. */
async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = done ? '' : lines.pop();
      for (const line of lines) {
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = '';
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        }
      }
      if (done) {
        if (data.length) yield { event, data: data.join('\n') };
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** What the user should read for a failed request. Never includes the key. */
async function httpError(response, label) {
  let detail = '';
  try {
    let body = await response.json();
    if (Array.isArray(body)) body = body[0]; // Gemini wraps its error in an array
    detail = body?.error?.message ?? body?.message ?? '';
  } catch {
    // Not JSON: the status says enough.
  }
  const { status } = response;
  const hint = status === 401 || status === 403 ? 'Check the API key in Settings.'
    : status === 404 ? 'Check the model name and base URL in Settings.'
      : status === 429 ? 'Rate limited or out of credit.'
        : '';
  const message = [`${label} answered ${status}.`, detail, hint].filter(Boolean).join(' ');
  // A daily quota is spent until tomorrow: waiting a few seconds and retrying only adds delay.
  const daily = status === 429 && /per ?day|daily/i.test(detail);
  const err = new ProviderError(message, { status, retryable: !daily && (status === 408 || status === 409 || status === 429 || status >= 500) });
  err.quota = status === 429;
  err.retired = /no longer available|not found for API version|is not supported/i.test(detail);
  return err;
}

/** POST with backoff on the failures worth retrying. Only the request is retried, never a stream. */
async function postJSON(url, headers, body, { signal, label, fetchImpl, retryDelay = 1000 }) {
  for (let attempt = 0; ; attempt++) {
    let response;
    let failure;
    try {
      response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (response.ok) return response;
      failure = await httpError(response, label);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      failure = e instanceof ProviderError ? e
        : new ProviderError(`Could not reach ${label}: ${e?.message ?? e}`, { retryable: true });
    }
    if (!failure.retryable || attempt >= RETRY_LIMIT) throw failure;
    const after = Number(response?.headers?.get?.('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : retryDelay * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30000)));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

/** Tool input from the accumulated JSON. Strict: a tool never runs on input that did not parse. */
function parseToolInput(json) {
  try {
    const input = JSON.parse(json === '' ? '{}' : json);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { input: {}, parseError: 'INVALID_JSON: the tool input was not a JSON object' };
    }
    return { input };
  } catch (e) {
    return { input: {}, parseError: `INVALID_JSON: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------------------------

/** Models that take adaptive thinking and an effort setting. */
const ANTHROPIC_EFFORT_MODELS = /^claude-(fable|mythos|opus|sonnet|haiku)-5/;
/** Models with the server-side fallback for a request a safety classifier declines. */
const ANTHROPIC_FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5$|sonnet-5-5)/;

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      if (m.native?.provider === 'anthropic') {
        out.push({ role: 'assistant', content: m.native.content });
      } else {
        const content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
        out.push({ role: 'assistant', content });
      }
    } else if (m.role === 'tool') {
      // Every result of a turn in one user message.
      out.push({
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      });
    }
  }
  return out;
}

async function streamAnthropic({ apiKey, baseUrl, model, system, messages, tools, signal, onText, fetchImpl = fetch, retryDelay }) {
  const url = `${(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    // The page calls the API itself, with the user's own key from the keychain.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: 64000,
    stream: true,
    system,
    cache_control: { type: 'ephemeral' },
    messages: toAnthropicMessages(messages),
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, eager_input_streaming: true })),
  };
  if (ANTHROPIC_EFFORT_MODELS.test(model)) body.output_config = { effort: 'high' };
  if (ANTHROPIC_FALLBACK_MODELS.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  const response = await postJSON(url, headers, body, { signal, label: 'Anthropic', fetchImpl, retryDelay });
  const blocks = [];
  const inputs = new Map();
  let stopReason = 'end';
  for await (const { data } of readSSE(response.body)) {
    const ev = JSON.parse(data);
    if (ev.type === 'content_block_start') {
      blocks[ev.index] = { ...ev.content_block };
      if (ev.content_block.type === 'tool_use') inputs.set(ev.index, '');
    } else if (ev.type === 'content_block_delta') {
      const block = blocks[ev.index];
      const d = ev.delta;
      if (d.type === 'text_delta') {
        block.text = (block.text ?? '') + d.text;
        onText?.(d.text);
      } else if (d.type === 'input_json_delta') {
        inputs.set(ev.index, inputs.get(ev.index) + d.partial_json);
      } else if (d.type === 'thinking_delta') {
        block.thinking = (block.thinking ?? '') + d.thinking;
      } else if (d.type === 'signature_delta') {
        block.signature = d.signature;
      }
    } else if (ev.type === 'message_delta') {
      const r = ev.delta?.stop_reason;
      stopReason = r === 'tool_use' ? 'tool_use' : r === 'max_tokens' ? 'max_tokens' : r === 'refusal' ? 'refusal' : stopReason;
    } else if (ev.type === 'error') {
      throw new ProviderError(`Anthropic: ${ev.error?.message ?? 'stream error'}`, { retryable: false });
    }
  }

  const content = blocks.filter(Boolean);
  const toolCalls = [];
  for (const [index, json] of inputs) {
    const block = blocks[index];
    const { input, parseError } = parseToolInput(json);
    block.input = input;
    toolCalls.push({ id: block.id, name: block.name, input, ...(parseError ? { parseError } : {}) });
  }
  const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return { text, toolCalls, stopReason, native: { provider: 'anthropic', content } };
}

// ---------------------------------------------------------------------------------------------
// OpenAI Chat Completions, and anything that speaks it (Gemini, OpenRouter, Ollama, LM Studio...)
// ---------------------------------------------------------------------------------------------

function toOpenAIMessages(system, messages, { replayExtra = false } = {}) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const entry = { role: 'assistant', content: m.text || null };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
          // Gemini 3 rejects the next request unless each call's thought signature comes back.
          ...(replayExtra && c.extra ? { extra_content: c.extra } : {}),
        }));
      }
      out.push(entry);
    } else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

/**
 * Gemini accepts a narrower JSON Schema than the others: no additionalProperties, string enums
 * only, and every property typed. Rewrite a tool's schema into that subset; input is still
 * checked against the full schema before a tool runs.
 */
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, geminiSchema(sub)]));
    else if (k === 'items' || k === 'anyOf') out[k] = geminiSchema(v);
    else out[k] = v;
  }
  if (out.enum && out.enum.some((e) => typeof e !== 'string')) {
    out.description = [out.description, `One of: ${out.enum.join(', ')}.`].filter(Boolean).join(' ');
    delete out.enum;
  }
  if (!out.type && !out.anyOf && !out.enum) {
    out.type = 'string';
    out.description = [out.description, 'Written as JSON.'].filter(Boolean).join(' ');
  }
  return out;
}

function chatCompletions({ label, tokenField, defaultBaseUrl, schemaFor = (s) => s, replayExtra = false, extraBody = {} }) {
  return async function stream({ apiKey, baseUrl, model, system, messages, tools, signal, onText, fetchImpl = fetch, retryDelay }) {
    const root = (baseUrl || defaultBaseUrl || '').replace(/\/+$/, '');
    if (!root) throw new ProviderError(`${label} needs a base URL. Set it in Settings.`);
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const body = {
      model,
      stream: true,
      [tokenField]: 16000,
      ...extraBody,
      messages: toOpenAIMessages(system, messages, { replayExtra }),
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: schemaFor(t.schema) } })),
    };
    const response = await postJSON(`${root}/chat/completions`, headers, body, { signal, label, fetchImpl, retryDelay });

    let text = '';
    let stopReason = 'end';
    let refusal = '';
    const calls = [];
    for await (const { data } of readSSE(response.body)) {
      if (data === '[DONE]') break;
      const ev = JSON.parse(data);
      if (ev.error) throw new ProviderError(`${label}: ${ev.error.message ?? 'stream error'}`);
      const choice = ev.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.content) {
        text += d.content;
        onText?.(d.content);
      }
      if (d.refusal) refusal += d.refusal;
      for (const t of d.tool_calls ?? []) {
        // OpenAI numbers each call and streams it in pieces. Gemini sends each call whole, with
        // its own id and no number, several in one reply.
        let call;
        if (t.index !== undefined) call = (calls[t.index] ??= { id: '', name: '', json: '' });
        else if (t.id) {
          call = calls.find((c) => c?.id === t.id);
          if (!call) calls.push((call = { id: '', name: '', json: '' }));
        } else call = calls.at(-1) ?? (calls[0] = { id: '', name: '', json: '' });
        if (t.extra_content) call.extra = t.extra_content;
        if (t.id) call.id = t.id;
        if (t.function?.name) call.name += t.function.name;
        if (t.function?.arguments) call.json += t.function.arguments;
      }
      const r = choice.finish_reason;
      if (r === 'tool_calls' || r === 'function_call') stopReason = 'tool_use';
      else if (r === 'length') stopReason = 'max_tokens';
      else if (r === 'content_filter') stopReason = 'refusal';
    }
    if (refusal) {
      stopReason = 'refusal';
      text = text || refusal;
    }
    const toolCalls = calls.filter(Boolean).map((c, i) => {
      const { input, parseError } = parseToolInput(c.json);
      return { id: c.id || `call_${i}`, name: c.name, input, ...(c.extra ? { extra: c.extra } : {}), ...(parseError ? { parseError } : {}) };
    });
    // Some servers finish with `stop` even when they called a tool.
    if (toolCalls.length && stopReason === 'end') stopReason = 'tool_use';
    return { text, toolCalls, stopReason };
  };
}

/** The ids a provider's /models answers, without Gemini's `models/` prefix. */
async function listModels({ provider, apiKey, baseUrl, fetchImpl = fetch }) {
  const root = (baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
  if (!root || provider.stream === streamAnthropic) return [];
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const response = await fetchImpl(`${root}/models`, { headers });
  if (!response.ok) throw await httpError(response, provider.label);
  const body = await response.json();
  return (body.data ?? []).map((m) => String(m.id).replace(/^models\//, '')).sort();
}

/** The models worth offering in the dropdown, from what the provider lists. */
function chatModels(provider, ids) {
  if (provider.modelFilter) return ids.filter(provider.modelFilter);
  return ids;
}

/** The first id matching the provider's preferences, newest version first. */
function pickModel(provider, ids) {
  for (const rule of provider.prefer ?? []) {
    const hits = ids.filter((id) => rule.test(id));
    if (hits.length) return hits.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  }
  return null;
}

/** Gemini's Flash models a key can use, newest first: never lite, image, speech or live ones. */
function geminiFlashModels(ids) {
  return ids.filter((id) => /^gemini-[\d.]+-flash(-preview)?$|^gemini-flash-latest$/.test(id))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

const geminiChat = chatCompletions({
  label: 'Google Gemini',
  tokenField: 'max_tokens',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  schemaFor: geminiSchema,
  replayExtra: true,
});

/**
 * Gemini's free tier gives each model its own small daily allowance (20 requests on the newest
 * Flash, measured 2026-11-21) and retires old models for new keys. When one is spent or gone,
 * go on to the next Flash model rather than stop.
 */
async function streamGemini(args) {
  const tried = new Set();
  let model = args.model;
  let ids = null;
  for (;;) {
    try {
      return { ...(await geminiChat({ ...args, model })), model };
    } catch (e) {
      if (!(e instanceof ProviderError) || !(e.quota || e.retired)) throw e;
      tried.add(model);
      ids ??= await listModels({ provider: PROVIDERS.google, apiKey: args.apiKey, fetchImpl: args.fetchImpl }).catch(() => []);
      const next = geminiFlashModels(ids).find((id) => !tried.has(id));
      if (!next) {
        throw new ProviderError('The free Gemini models have used up their free requests for today. Try again tomorrow, or choose another provider in Settings.', { status: 429 });
      }
      args.onModelChange?.(next, model);
      model = next;
    }
  }
}

const PROVIDERS = {
  google: {
    label: 'Google Gemini (free)',
    secret: 'google.api_key',
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
    free: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHelp: 'Free with a Google account, no card. Sign in, choose Create API key, and paste it here.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Flash models: fast, capable with tools, and in the free tier. Never lite, image or speech ones.
    prefer: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash(-latest)?$/, /^gemini-flash-latest$/],
    modelFilter: (id) => /^gemini-[\d.]+-(flash|pro)(-preview)?$|^gemini-(flash|pro)-latest$/.test(id),
    stream: streamGemini,
  },
  groq: {
    label: 'Groq, open models (free)',
    secret: 'groq.api_key',
    defaultModel: 'openai/gpt-oss-120b',
    needsKey: true,
    free: true,
    keyUrl: 'https://console.groq.com/keys',
    keyHelp: 'Free with a Groq account, no card. Very fast, with tighter daily limits than Gemini, so better for session edits than for building Add Ons.',
    baseUrl: 'https://api.groq.com/openai/v1',
    prefer: [/^openai\/gpt-oss-120b$/, /^moonshotai\/kimi-k2/, /^llama-3\.3-70b/],
    modelFilter: (id) => !/whisper|guard|tts|playai|orpheus|compound/i.test(id),
    stream: chatCompletions({ label: 'Groq', tokenField: 'max_completion_tokens', defaultBaseUrl: 'https://api.groq.com/openai/v1' }),
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    secret: 'anthropic.api_key',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHelp: 'Paid, billed to your Anthropic account. The strongest at building Add Ons.',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    defaultModel: 'claude-opus-5-5',
    needsKey: true,
    stream: streamAnthropic,
  },
  openai: {
    label: 'OpenAI',
    secret: 'openai.api_key',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHelp: 'Paid, billed to your OpenAI account. A ChatGPT subscription does not include API use.',
    baseUrl: 'https://api.openai.com/v1',
    prefer: [/^gpt-5(\.\d+)?$/],
    modelFilter: (id) => /^(gpt-|o\d)/.test(id) && !/audio|realtime|tts|image|transcribe|search|embedding|instruct/.test(id),
    defaultModel: 'gpt-5',
    needsKey: true,
    stream: chatCompletions({ label: 'OpenAI', tokenField: 'max_completion_tokens', defaultBaseUrl: 'https://api.openai.com/v1' }),
  },
  compatible: {
    label: 'Other (OpenAI-compatible)',
    keyHelp: 'Any server that speaks OpenAI\'s API. A server on this Mac, such as Ollama, works as it is; another one has to be one this Add On is allowed to reach.',
    secret: 'compatible.api_key',
    defaultModel: '',
    needsKey: false,
    needsBaseUrl: true,
    stream: chatCompletions({ label: 'The model server', tokenField: 'max_tokens' }),
  },
};

/** A key is only ever sent over https, or to this machine. */
function checkBaseUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'That base URL is not a valid URL.';
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    return 'Use https, or http only for a server on this machine.';
  }
  return null;
}

globalThis.Providers = { PROVIDERS, ProviderError, readSSE, parseToolInput, checkBaseUrl, toAnthropicMessages, toOpenAIMessages, geminiSchema, geminiFlashModels, listModels, pickModel, chatModels };
})();
