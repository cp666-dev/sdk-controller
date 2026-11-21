// A stand-in for the LLM that speaks OpenAI's streaming API and calls every session tool once,
// in order, reading earlier results where a step needs them (track ids, a plugin id, a slot).
// Used by check.sh only. Never a real model: it costs nothing and does the same thing every run.
import { createServer } from 'node:http';

const PORT = Number(process.env.SCRIPTED_MODEL_PORT ?? 8798);
const tag = process.env.CHECK_TAG ?? 'SDC Check';

// Each step: [tool, input, or a function of the results so far].
const STEPS = [
  ['get_session', {}],
  ['inspect_engine', { path: '/sessions' }],
  ['new_track', { name: `${tag} Audio`, type: 'audio' }],
  ['new_track', { name: `${tag} Keys`, type: 'instrument' }],
  ['set_track', (r) => ({ track: r.new_track[0].id, gain_db: -6, pan: -0.5, mute: true, solo: false })],
  ['set_track', (r) => ({ track: r.new_track[0].id, name: `${tag} Audio 2`, mute: false })],
  ['new_bus', { name: `${tag} Bus` }],
  ['set_send', (r) => ({ track: r.new_track[0].id, send: 0, bus: r.new_bus[0].id })],
  ['list_plugins', { query: 'EQ' }],
  ['insert_plugin', (r) => (r.list_plugins[0].plugins?.[0] ? { track: r.new_track[0].id, plugin_id: r.list_plugins[0].plugins[0].id } : null)],
  ['get_track', (r) => ({ track: r.new_track[0].id })],
  ['bypass_plugin', (r) => (r.get_track[0].effects?.[0] ? { track: r.new_track[0].id, slot: r.get_track[0].effects[0].slot, bypass: true } : null)],
  ['add_marker', { name: `${tag} Marker`, bar: 5, beat: 2.5 }],
  ['set_tempo', { bpm: 97, bar: 9 }],
  ['set_time_signature', { numerator: 3, denominator: 4, bar: 13 }],
  ['set_chords', { chords: [{ name: 'Am', bar: 1 }, { name: 'F', bar: 2 }, { name: 'C', bar: 3 }, { name: 'G', bar: 4 }] }],
  ['add_midi_notes', (r) => ({ track: r.new_track[1].id, notes: [60, 64, 67].map((pitch) => ({ pitch, bar: 1, length_beats: 4, velocity: 90 })) })],
  ['transport', { action: 'loop', bar: 1, to_bar: 3 }],
  ['transport', { action: 'loop_off' }],
  ['transport', { action: 'seek', bar: 2 }],
  ['engine_call', (r) => ({ verb: 'set', path: `/sessions/${r.session_uid}/looping`, value: false })],
  ['undo', { count: 1 }],
  ['delete_marker', { name: `${tag} Marker` }],
  ['delete_track', (r) => ({ track: r.new_track[0].id })],
  ['delete_track', (r) => ({ track: r.new_track[1].id })],
  ['delete_track', (r) => ({ track: r.new_bus[0].id })],
];

// --read-only keeps to tools that change nothing, for checking against a session that matters.
const READS = new Set(['get_session', 'inspect_engine', 'list_plugins', 'get_track']);
if (process.env.CHECK_READ_ONLY) {
  STEPS.splice(0, STEPS.length, ...[
    ['get_session', {}],
    ['inspect_engine', (r) => ({ path: `/sessions/${r.get_session[0].uid}?properties=1&children=0` })],
    ['list_plugins', { query: 'EQ' }],
    ['get_track', (r) => ({ track: r.get_session[0].tracks[0].id })],
  ].filter(([tool]) => READS.has(tool)));
}

function resultsSoFar(messages) {
  const calls = new Map();
  for (const m of messages) for (const c of m.tool_calls ?? []) calls.set(c.id, c.function.name);
  const out = {};
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    let value;
    try { value = JSON.parse(m.content); } catch { value = m.content; }
    (out[calls.get(m.tool_call_id)] ??= []).push(value);
  }
  return out;
}

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/steps') { res.writeHead(200, cors); return res.end(String(STEPS.length)); }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const { messages } = JSON.parse(body);
    const results = resultsSoFar(messages);
    results.session_uid = results.get_session?.[0]?.uid;
    const done = messages.filter((m) => m.role === 'tool').length;
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
    // Skip steps whose input depends on something this session lacks (no plugins, say).
    let i = done;
    let input = null;
    while (i < STEPS.length) {
      const [, spec] = STEPS[i];
      try { input = typeof spec === 'function' ? spec(results) : spec; } catch { input = null; }
      if (input) break;
      i++;
    }
    if (i >= STEPS.length || done >= STEPS.length) {
      res.write(chunk({ content: 'CHECK COMPLETE' }));
      res.write(chunk({}, 'stop'));
    } else {
      // A skipped step still takes a slot, so its index lines up on the next request.
      STEPS.splice(done, i - done);
      res.write(chunk({ tool_calls: [{ index: 0, id: `step${done}`, function: { name: STEPS[done][0], arguments: JSON.stringify(input) } }] }));
      res.write(chunk({}, 'tool_calls'));
    }
    res.end('data: [DONE]\n\n');
  });
}).listen(PORT, '127.0.0.1', () => console.log(`scripted model on ${PORT}`));
