// Rehearse demo prompts with a real model against Luna.MockEngine: the same providers, loop and
// tools as the panel, every step approved. Prints the tools each prompt used, the reply, and how
// long it took. Costs a little: a handful of requests per prompt.
//   ANTHROPIC_API_KEY=... node check/rehearse.mjs                 Claude, the panel's default model
//   PROVIDER=google GEMINI_API_KEY=... node check/rehearse.mjs       the free default
//   PROVIDER=openai OPENAI_API_KEY=... MODEL=gpt-5 node check/rehearse.mjs
//   node check/rehearse.mjs "your prompt" "another"               your own prompts
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna;
await import('../providers.js');
await import('../agent.js');
await import('../logic.js');
// BUILD_HELPER=http://127.0.0.1:<port> adds the Add On builder's tools, against that helper.
if (process.env.BUILD_HELPER) {
  globalThis.SDC_HELPER_URL = process.env.BUILD_HELPER;
  await import('../builder.js');
}
const TOOLS = [...globalThis.AddOnLogic.TOOLS, ...(globalThis.Builder?.TOOLS ?? [])];
const SYSTEM = [globalThis.AddOnLogic.SYSTEM_PROMPT, globalThis.Builder?.SYSTEM_PROMPT].filter(Boolean).join('\n\n');
const { PROVIDERS } = globalThis.Providers;

const PROMPTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  "What's in this session?",
  'Turn the drums down 3 dB and pan the guitars left and right.',
  'Make a reverb bus and send the vocal to it.',
  'Put markers at bar 1, 9 and 17 called Verse, Chorus and Verse 2.',
  'Write Am, F, C, G on the chord track, one bar each, from bar 1.',
  'Add an instrument track called Keys and write those chords on it as whole notes.',
  'Undo that.',
];

const id = process.env.PROVIDER ?? 'anthropic';
const p = PROVIDERS[id];
const KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY' };
const apiKey = process.env[KEYS[id] ?? 'COMPATIBLE_API_KEY'] ?? '';
// As the panel does: the model from the provider's own list, unless one is given.
let model = process.env.MODEL;
if (!model && p?.prefer) model = globalThis.Providers.pickModel(p, await globalThis.Providers.listModels({ provider: p, apiKey })) ?? undefined;
model ??= p.defaultModel;
if (!p) { console.error(`No provider ${id}.`); process.exit(2); }
if (p.needsKey && !apiKey) { console.error(`Set the ${id} API key in the environment.`); process.exit(2); }

const engine = new Luna.MockEngine();
engine.addSession('demo', { name: 'Demo Song', tracks: ['Kick', 'Snare', 'Drums OH', 'Bass', 'Gtr L', 'Gtr R', 'Lead Vocal'] });
engine.addPlugin('com.uaudio.uadx.1176', { name: 'UA 1176 Classic Limiter', categories: ['Compressor'] });
engine.addPlugin('com.uaudio.uadx.pure_plate', { name: 'Pure Plate Reverb', categories: ['Reverb'] });
await engine.settled();
const luna = await Luna.connect({ port_: engine.port() });
const session = await luna.session();

const marks = [];
const agent = new globalThis.AgentCore.Agent({
  provider: () => ({ stream: p.stream, apiKey, baseUrl: process.env.BASE_URL, model }),
  system: () => SYSTEM,
  tools: TOOLS,
  execute: (calls) => globalThis.AddOnLogic.execute({ luna, session, marks }, calls),
  approve: async (calls) => calls.map(() => true),
});

let failures = 0;
console.log(`${p.label} ${model}\n`);
for (const prompt of PROMPTS) {
  const started = Date.now();
  const steps = [];
  let outcome;
  marks.push(await globalThis.AddOnLogic.undoMark({ luna, session }));
  try {
    outcome = await agent.send(prompt, {
      onModelChange: (next, spent) => { model = next; steps.push(`note   ${spent} out of free requests, continuing on ${next}`); },
      onResult: (e) => steps.push(`${e.result.isError ? 'FAILED' : 'ok    '} ${e.summary}${e.result.isError ? `: ${e.result.content}` : ''}`),
    });
  } catch (e) {
    outcome = { outcome: 'error', text: e.message };
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (outcome.outcome !== 'done' || steps.some((s) => s.startsWith('FAILED'))) failures++;
  console.log(`> ${prompt}   [${seconds}s, ${outcome.outcome}]`);
  for (const s of steps) console.log(`    ${s}`);
  console.log(`    "${(outcome.text ?? '').trim()}"\n`);
}
console.log(failures ? `${failures} prompt(s) need a look.` : 'All prompts finished cleanly.');
process.exit(failures ? 1 : 0);
