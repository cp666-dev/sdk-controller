// Session tools against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const logic = globalThis.AddOnLogic;
const tool = (name) => logic.TOOLS.find((t) => t.name === name);

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass', 'Drums'] });
  engine.addPlugin('com.uaudio.uadx.1176', { name: 'UA 1176', categories: ['Compressor'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  return { engine, luna, session, ctx: { luna, session } };
}

const run = (ctx, name, input = {}) => logic.execute(ctx, [{ tool: tool(name), input }]).then(([o]) => o);

describe('reading', () => {
  it('summarises the session', async () => {
    const { ctx } = await connected();
    const { content, isError } = await run(ctx, 'get_session');
    expect(isError).toBeUndefined();
    expect(content.name).toBe('Demo');
    expect(content.tracks.map((t) => t.name)).toEqual(['Vocal', 'Bass', 'Drums']);
    expect(content.tracks[0]).toMatchObject({ mute: false, solo: false });
  });

  it('finds plugins by name and category', async () => {
    const { ctx } = await connected();
    expect((await run(ctx, 'list_plugins', { query: '1176' })).content.count).toBe(1);
    expect((await run(ctx, 'list_plugins', { query: 'compress' })).content.count).toBe(1);
  });

  it('reads one track', async () => {
    const { ctx } = await connected();
    const { content } = await run(ctx, 'get_track', { track: 'bass' });
    expect(content).toMatchObject({ name: 'Bass', effects: [] });
  });
});

describe('finding tracks', () => {
  const items = ['Vocal', 'Vocal Dbl', 'Bass'].map((n, i) => ({ id: `t${i}`, name: { value: n } }));

  it('takes an exact name over a partial one, any case', () => {
    expect(logic.pick(items, 'vocal', 'track').id).toBe('t0');
  });

  it('takes a unique part of a name', () => {
    expect(logic.pick(items, 'dbl', 'track').id).toBe('t1');
  });

  it('refuses to guess when a name is ambiguous', () => {
    expect(() => logic.pick(items, 'voc', 'track')).toThrow(/more than one/);
  });

  it('says what exists when nothing matches', () => {
    expect(() => logic.pick(items, 'kick', 'track')).toThrow(/Vocal, Vocal Dbl, Bass/);
  });
});

describe('editing', () => {
  it('sets levels and switches on a track, and touches each control', async () => {
    const { engine, session, ctx } = await connected();
    const out = await run(ctx, 'set_track', { track: 'Bass', gain_db: -6, mute: true });
    expect(out.isError).toBeUndefined();
    await engine.settled();
    const bass = session.visibleTracks[1];
    expect(bass.gain.real.value).toBe(-6);
    expect(bass.mute.on).toBe(true);
    expect(engine.touches.length).toBeGreaterThan(0);
  });

  it('pans from -1 to 1, on the pan controls a mono track has', async () => {
    const { engine, session, ctx } = await connected();
    expect((await run(ctx, 'set_track', { track: 'Vocal', pan: -1 })).isError).toBeUndefined();
    await engine.settled();
    expect(session.visibleTracks[0].main.pans.map((p) => p.normalized.value)).toEqual([0]);
  });

  it('runs several control edits as one undo step', async () => {
    const { engine, session, ctx } = await connected();
    const outcomes = await logic.execute(ctx, [
      { tool: tool('set_track'), input: { track: 'Vocal', mute: true } },
      { tool: tool('set_track'), input: { track: 'Bass', mute: true } },
    ]);
    expect(outcomes.every((o) => !o.isError)).toBe(true);
    await engine.settled();
    expect(session.visibleTracks.slice(0, 2).every((t) => t.mute.on)).toBe(true);
    expect(engine.transactions).toEqual(['begin', 'commit']);
  });

  it('aborts the undo step and reports every edit when one fails', async () => {
    const { engine, ctx } = await connected();
    const outcomes = await logic.execute(ctx, [
      { tool: tool('set_track'), input: { track: 'Vocal', mute: true } },
      { tool: tool('set_track'), input: { track: 'Nope', mute: true } },
    ]);
    expect(outcomes.map((o) => o.isError)).toEqual([true, true]);
    expect(outcomes[0].content).toMatch(/None of these 2 edits were kept/);
    expect(engine.transactions).toEqual(['begin', 'abort']);
  });

  it('adds a track and answers with its id', async () => {
    const { session, ctx } = await connected();
    const { content, isError } = await run(ctx, 'new_track', { name: 'Keys', type: 'instrument' });
    expect(isError).toBeUndefined();
    expect(content.name).toMatch(/Keys/);
    expect(session.visibleTracks.some((t) => t.id === content.id)).toBe(true);
  });

  it('adds a bus and points a send at it', async () => {
    const { ctx } = await connected();
    expect((await run(ctx, 'new_bus', { name: 'Verb' })).isError).toBeUndefined();
    const out = await run(ctx, 'set_send', { track: 'Vocal', bus: 'Verb' });
    expect(out.isError).toBeUndefined();
  });

  it('inserts a plugin', async () => {
    const { luna, ctx } = await connected();
    await luna.plugins.load();
    const out = await run(ctx, 'insert_plugin', { track: 'Vocal', plugin_id: 'com.uaudio.uadx.1176' });
    expect(out.isError).toBeUndefined();
    expect((await run(ctx, 'get_track', { track: 'Vocal' })).content.effects[0].name).toBe('UA 1176');
  });

  it('adds a marker at a bar', async () => {
    const { session, ctx } = await connected();
    expect((await run(ctx, 'add_marker', { name: 'Chorus', bar: 9 })).isError).toBeUndefined();
    expect(session.markers.items.map((m) => m.name.value)).toContain('Chorus');
    expect(session.markers.items.find((m) => m.name.value === 'Chorus').location.value).toBe(session.musical.timeline.tickAt({ bar: 9 }));
  });

  it('handles fractional beats', async () => {
    const { session } = await connected();
    expect(logic.tickAt(session, 1, 2.5)).toBe(session.musical.timeline.tickAt({ bar: 1, beat: 2 }) + Luna.TICKS_PER_BEAT / 2);
  });

  it('changes the session tempo the way LUNA\'s tempo field does, not with set_tempo', async () => {
    const { engine, session, ctx } = await connected();
    expect((await run(ctx, 'set_tempo', { bpm: 96 })).isError).toBeUndefined();
    await engine.settled();
    expect(engine.requests.some((r) => r.path.endsWith('/set_tempo'))).toBe(false);
    expect(session.musical.tempoEventAt(0).tempo.value).toBe(96);
  });

  it('adds a tempo change at a later bar', async () => {
    const { engine, ctx } = await connected();
    expect((await run(ctx, 'set_tempo', { bpm: 140, bar: 9 })).isError).toBeUndefined();
    expect(engine.requests.some((r) => r.path.endsWith('/set_tempo'))).toBe(true);
  });

  it('says plainly when LUNA will not add a tempo change', async () => {
    const { engine, session, ctx } = await connected();
    engine.fail(`/sessions/${session.uid}/set_tempo`, 'device.database_error');
    const out = await run(ctx, 'set_tempo', { bpm: 140, bar: 9 });
    expect(out).toMatchObject({ isError: true, content: expect.stringMatching(/would not add a tempo change at bar 9/) });
  });

  it('sets the meter', async () => {
    const { ctx } = await connected();
    expect((await run(ctx, 'set_time_signature', { numerator: 3, denominator: 4 })).isError).toBeUndefined();
  });

  it('writes MIDI notes', async () => {
    const { ctx } = await connected();
    const added = await run(ctx, 'new_track', { name: 'Keys', type: 'instrument' });
    const out = await run(ctx, 'add_midi_notes', { track: added.content.id, notes: [{ pitch: 60, bar: 1, length_beats: 1 }] });
    expect(out.isError).toBeUndefined();
    expect(out.content.notes).toBe(1);
  });

  it('moves the playhead and sets a loop', async () => {
    const { session, ctx } = await connected();
    expect((await run(ctx, 'transport', { action: 'loop', bar: 1, to_bar: 5 })).isError).toBeUndefined();
    expect(session.transport.looping.value).toBe(true);
    expect((await run(ctx, 'transport', { action: 'seek', bar: 3 })).isError).toBeUndefined();
  });

  it('deletes a track', async () => {
    const { session, ctx } = await connected();
    expect((await run(ctx, 'delete_track', { track: 'Drums' })).isError).toBeUndefined();
    await Luna.settle(() => session.visibleTracks.length === 2, 'delete');
  });

  it('deletes an aux bus', async () => {
    const { session, ctx } = await connected();
    const bus = await run(ctx, 'new_bus', { name: 'Verb' });
    expect((await run(ctx, 'delete_track', { track: 'Verb' })).isError).toBeUndefined();
    expect(session.buses.byId(bus.content.id)).toBeUndefined();
  });

  it('gives the session uid, for engine paths', async () => {
    const { session, ctx } = await connected();
    expect((await run(ctx, 'get_session')).content.uid).toBe(session.uid);
  });

  it('reports an unknown track as a tool error', async () => {
    const { ctx } = await connected();
    const out = await run(ctx, 'set_track', { track: 'Nope', mute: true });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Vocal, Bass, Drums/);
  });

  it('says so when no session is open', async () => {
    const { luna } = await connected();
    const out = await run({ luna, session: null }, 'get_session');
    expect(out).toMatchObject({ isError: true, content: expect.stringMatching(/No session/) });
  });
});

describe('undoing a whole request', () => {
  // A stand-in for LUNA's undo history: undo_uid is the entry undo reverses next.
  function history(entries) {
    const stack = [...entries];
    const session = {
      uid: 's',
      canUndo: { get value() { return stack.length > 0; } },
      undos: 0,
      async undo() { this.undos++; stack.pop(); },
    };
    const luna = { raw: { get: async () => ({ properties: { undo_uid: { value: stack.at(-1) ?? null } } }) } };
    return { luna, session, stack };
  }

  it('undoes back to where the previous request started', async () => {
    const { luna, session, stack } = history(['mine', 'a', 'b', 'c']);
    const ctx = { luna, session, marks: ['mine', 'c'] };
    const out = await run(ctx, 'undo', { whole_request: true });
    expect(out.isError).toBeUndefined();
    expect(out.content.undone).toBe(3);
    expect(stack).toEqual(['mine']);
  });

  it('undoes nothing when the previous request changed nothing', async () => {
    const { luna, session } = history(['mine']);
    const out = await run({ luna, session, marks: ['mine', 'mine'] }, 'undo', { whole_request: true });
    expect(out.content.undone).toBe(0);
    expect(session.undos).toBe(0);
  });

  it('refuses rather than guesses when LUNA gave no undo position', async () => {
    const { luna, session } = history(['a']);
    const out = await run({ luna, session, marks: [null, 'a'] }, 'undo', { whole_request: true });
    expect(out).toMatchObject({ isError: true, content: expect.stringMatching(/count instead/) });
    expect(session.undos).toBe(0);
  });

  it('stops if it runs out of history before reaching the mark', async () => {
    const { luna, session } = history(['a', 'b']);
    const out = await run({ luna, session, marks: ['gone', 'b'] }, 'undo', { whole_request: true });
    expect(out).toMatchObject({ isError: true, content: expect.stringMatching(/without reaching/) });
  });
});

describe('the catalog', () => {
  it('asks before anything that is not a read', () => {
    const risky = logic.TOOLS.filter((t) => ['delete_track', 'delete_marker', 'engine_call'].includes(t.name));
    expect(risky.every((t) => t.mode === 'always-ask')).toBe(true);
  });

  it('describes every tool for the approval card', () => {
    const sample = { track: 'A', name: 'B', bar: 1, to_bar: 2, notes: [], chords: [], query: 'q', path: '/x', verb: 'post', bpm: 90, numerator: 4, denominator: 4, action: 'play', plugin_id: 'p', slot: 's', bypass: true, bus: 'b', type: 'audio' };
    for (const t of logic.TOOLS) expect(typeof t.describe(sample), t.name).toBe('string');
  });
});
