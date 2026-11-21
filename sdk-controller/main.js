// SDK Controller: DOM wiring. Connects to LUNA, follows the focused session, keeps the settings,
// and shows the conversation. What the tools do is in logic.js and builder.js; the loop is agent.js.

const $ = (id) => document.getElementById(id);
const { PROVIDERS, checkBaseUrl, listModels, pickModel } = Providers;
const SETTINGS_KEY = 'com.cp.sdkcontroller.settings';
// The installer with the Add On builder: a .lunaaddon from Universe can't carry the helper.
const BUILDER_URL = 'https://github.com/cp666-dev/sdk-controller/releases/latest';

let luna = null;
let session = null;
// LUNA's undo position at the start of each request, so "undo that" can go back exactly.
let marks = [];
const apiKeys = {};
let claudeStatus = null; // the helper's last answer about Claude Code, for the subscription provider
const settings = loadSettings();

function loadSettings() {
  // A first install starts on Claude with the user's own plan: no key to find.
  const fallback = { provider: 'claude', autoApprove: false, models: {}, autoModels: {}, baseUrls: {} };
  try {
    const saved = { ...fallback, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    if (!PROVIDERS[saved.provider]) saved.provider = fallback.provider;
    saved.autoModels ??= {};
    return saved;
  } catch {
    return fallback;
  }
}

const saveSettings = () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  paintState();
};
// The model the user typed, else the one picked from the provider's own list, else a default.
const modelFor = (id) => settings.models[id] || settings.autoModels[id] || PROVIDERS[id].defaultModel;

// ---------------------------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------------------------

const log = $('log');

function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

function append(el) {
  const follow = atBottom();
  log.querySelector('.sdc-empty')?.remove();
  log.appendChild(el);
  if (follow) log.scrollTop = log.scrollHeight;
  return el;
}

function message(kind, text) {
  const el = document.createElement('div');
  el.className = `sdc-msg ${kind}`;
  el.textContent = text;
  return append(el);
}

// The bridge says what the panel is doing, in the same words and states as CP Assistant's mark.
const panelState = { waitingForApproval: 0 };

function paintState() {
  const connected = luna?.status.value === 'connected';
  const id = settings.provider;
  const problem = missingSetup();
  let state = 'ready';
  let word = 'READY';
  const model = PROVIDERS[id].agentic ? `Claude${claudeStatus?.subscription ? ` ${claudeStatus.subscription}` : ''} subscription` : modelFor(id);
  let detail = `${session?.name.value ?? 'No session open'} · ${model}`;
  if (!connected) {
    [state, word, detail] = ['offline', 'OFFLINE', luna ? 'Reconnecting to LUNA' : 'Waiting for LUNA'];
  } else if (panelState.waitingForApproval) {
    const n = panelState.waitingForApproval;
    [state, word, detail] = ['attention', 'NEEDS YOU', n === 1 ? '1 step to approve' : `${n} steps to approve`];
  } else if (agent.running) {
    [state, word] = ['working', 'WORKING'];
  } else if (problem) {
    [state, word, detail] = ['paused', 'SET UP', problem];
  }
  $('mark').dataset.state = state;
  $('app').dataset.state = state;
  $('state-word').textContent = word;
  $('status').textContent = detail;
}

function showEmpty() {
  log.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'sdc-empty';
  el.textContent = 'Try "put a compressor on the vocal and send it to a new reverb bus", or "build me a panel that colours tracks by name".';
  log.appendChild(el);
}

/** Resolves true or false for each step. Stop declines whatever is waiting. */
function askApproval(calls, signal) {
  return new Promise((resolve) => {
    const always = calls.filter((c) => c.mode === 'always-ask');
    // Auto-approve answers the ordinary edits; anything that always asks is still shown.
    if (settings.autoApprove && !always.length) {
      resolve(calls.map(() => true));
      return;
    }
    const shown = settings.autoApprove ? always : calls;
    $('approval-title').textContent = shown.length === 1 ? 'Run this?' : `Run these ${shown.length} steps?`;
    $('approval').dataset.risk = always.length ? 'destructive' : 'normal';
    const list = $('approval-steps');
    list.innerHTML = '';
    for (const c of shown) {
      const li = document.createElement('li');
      li.textContent = c.summary;
      li.className = 'sdc-step';
      li.classList.toggle('is-destructive', c.mode === 'always-ask');
      list.appendChild(li);
    }
    $('approval').hidden = false;
    // The question needs the space: the sequencer comes back once it's answered.
    $('busy').hidden = true;
    $('approve').focus();
    panelState.waitingForApproval = shown.length;
    paintState();

    const finish = (yes) => {
      $('approval').hidden = true;
      if (agent.running) $('busy').hidden = false;
      panelState.waitingForApproval = 0;
      paintState();
      $('approve').onclick = $('decline').onclick = null;
      signal.removeEventListener('abort', onAbort);
      resolve(calls.map((c) => (settings.autoApprove && c.mode !== 'always-ask' ? true : yes)));
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort);
    $('approve').onclick = () => finish(true);
    $('decline').onclick = () => finish(false);
  });
}

const tools = [...AddOnLogic.TOOLS, ...Builder.TOOLS];
const agent = new AgentCore.Agent({
  provider() {
    const id = settings.provider;
    if (PROVIDERS[id].agentic) return { ...PROVIDERS[id], model: settings.models[id] || '' };
    return { stream: PROVIDERS[id].stream, apiKey: apiKeys[id], baseUrl: settings.baseUrls[id], model: modelFor(id) };
  },
  system: () => `${AddOnLogic.SYSTEM_PROMPT}\n\n${Builder.SYSTEM_PROMPT}`,
  tools,
  execute: (calls) => AddOnLogic.execute({ luna, session, marks }, calls),
  approve: askApproval,
});

// ---------------------------------------------------------------------------------------------
// While a request runs: what it's doing, how long it's taken, and a step sequencer to play with.
// The grid is the panel's own toy: it plays no sound and never touches the session.
// ---------------------------------------------------------------------------------------------

const SEQ_ROWS = [['Kick', 0x8888], ['Snare', 0x0808], ['Hat', 0xaaaa], ['Bass', 0x9124]];
const busy = { timer: null, shown: null, started: 0, step: 0 };
(function buildSequencer() {
  const grid = $('seq');
  for (const [name, pattern] of SEQ_ROWS) {
    const label = document.createElement('span');
    label.className = 'sdc-seq-name';
    label.textContent = name;
    grid.appendChild(label);
    for (let i = 0; i < 16; i++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'sdc-cell';
      cell.classList.toggle('is-on', Boolean(pattern & (0x8000 >> i)));
      cell.setAttribute('aria-label', `${name} step ${i + 1}`);
      cell.onclick = () => cell.classList.toggle('is-on');
      grid.appendChild(cell);
    }
  }
})();

function busyStage(text) {
  $('busy-stage').textContent = text;
}

function startBusy() {
  busy.started = Date.now();
  busy.step = 0;
  busyStage('Thinking...');
  // Only for something that takes a moment: a quick answer never flashes it up.
  busy.shown = setTimeout(() => { $('busy').hidden = false; }, 1200);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  busy.timer = setInterval(() => {
    const s = Math.floor((Date.now() - busy.started) / 1000);
    $('busy-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (reduced) return;
    // 120 BPM sixteenths: the playhead moves along the grid, lighting the steps it plays.
    const cells = [...$('seq').querySelectorAll('.sdc-cell')];
    cells.forEach((c, i) => c.classList.toggle('is-now', i % 16 === busy.step));
    busy.step = (busy.step + 1) % 16;
  }, 125);
}

function stopBusy() {
  clearTimeout(busy.shown);
  clearInterval(busy.timer);
  $('busy').hidden = true;
  for (const c of $('seq').querySelectorAll('.is-now')) c.classList.remove('is-now');
}

function setWorking(working) {
  if (working) startBusy();
  else stopBusy();
  $('send').hidden = working;
  $('stop').hidden = !working;
  $('new-chat').disabled = working;
  paintState();
}

function missingSetup() {
  const id = settings.provider;
  const p = PROVIDERS[id];
  if (p.agentic) {
    if (!claudeStatus) return 'Checking Claude...';
    if (!claudeStatus.installed) return 'Claude Code is not on this Mac. Run the installer again and choose Claude.';
    if (!claudeStatus.loggedIn) return 'Sign in to Claude in Settings to start.';
    return null;
  }
  if (!modelFor(id)) return 'Choose a model in Settings.';
  if (p.needsKey && !apiKeys[id]) return p.free ? 'Get your free key in Settings to start.' : `Add your ${p.label} API key in Settings.`;
  if (p.needsBaseUrl && !settings.baseUrls[id]) return 'Set the base URL in Settings.';
  return checkBaseUrl(settings.baseUrls[id]);
}

async function send(text) {
  message('user', text);
  setWorking(true);
  marks.push(await AddOnLogic.undoMark({ luna, session }));

  let current = null;
  const rows = new Map();
  try {
    const result = await agent.send(text, {
      onTurnStart() { current = null; },
      onNotice(text) { message('note', text); },
      onModelChange(next, spent) {
        settings.autoModels[settings.provider] = next;
        saveSettings();
        message('note', `${spent} is out of free requests for today, so this continues on ${next}.`);
      },
      onText(delta) {
        if (!current) busyStage('Writing a reply...');
        current ??= message('assistant', '');
        const follow = atBottom();
        current.textContent += delta;
        if (follow) log.scrollTop = log.scrollHeight;
      },
      onCalls(entries) {
        current = null;
        for (const e of entries) {
          const row = document.createElement('div');
          row.className = 'sdc-tool running';
          row.append(document.createElement('span'), document.createElement('span'));
          row.firstChild.className = 'sdc-tool-mk';
          row.lastChild.className = 'sdc-tool-t';
          row.lastChild.textContent = e.summary;
          rows.set(e, append(row));
          busyStage(e.summary);
        }
      },
      onResult(e) {
        const row = rows.get(e);
        row.classList.remove('running');
        row.classList.add(e.result.isError ? 'failed' : 'ok');
        if (e.result.isError) row.lastChild.textContent = `${e.summary}: ${e.result.content}`;
      },
    });
    if (result.outcome === 'refused') message('error', result.text || 'The model declined that request. Nothing in that turn was run.');
    else if (result.outcome === 'cut-off') message('note', 'The reply hit the token limit and was cut off.');
    else if (result.outcome === 'turn-limit') message('error', `Stopped after ${AgentCore.MAX_TURNS} rounds of tools. Ask it to continue if it was getting somewhere.`);
    else if (result.outcome === 'stopped') message('note', 'Stopped. Steps that had already run are still in the session; undo removes them.');
  } catch (e) {
    const text = e?.message ?? String(e);
    // Claude Code can say it is signed in while its sign-in has lapsed: offer the sign-in again.
    if (PROVIDERS[settings.provider].agentic && /authenticat|oauth|log ?in|sign ?in/i.test(text)) {
      claudeStatus = { ...(claudeStatus ?? {}), installed: true, loggedIn: false };
      message('error', 'Your Claude sign-in has expired. Open Settings and press SIGN IN TO CLAUDE, then send that again.');
      paintState();
    } else {
      message('error', text);
    }
  } finally {
    for (const row of rows.values()) row.classList.remove('running');
    setWorking(false);
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('prompt').value.trim();
  if (!text || agent.running) return;
  // Keep what they typed until there is a model to send it to. The bridge says what is missing.
  if (missingSetup()) {
    toggleSettings(true);
    return;
  }
  $('prompt').value = '';
  void send(text);
});

$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('stop').onclick = () => agent.stop();
$('new-chat').onclick = () => {
  agent.reset();
  showEmpty();
};

// ---------------------------------------------------------------------------------------------
// Settings. Keys live in luna.secrets (the keychain inside LUNA), everything else in localStorage.
// ---------------------------------------------------------------------------------------------

function toggleSettings(open = $('settings').hidden) {
  if (open) toggleShare(false);
  $('settings').hidden = !open;
  $('app').classList.toggle('is-settings', open || !$('share').hidden);
  $('settings-toggle').classList.toggle('is-on', open);
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    paintSettings();
    void refreshHelper();
  }
}

function paintSettings() {
  const id = settings.provider;
  const p = PROVIDERS[id];
  $('provider').value = id;
  paintModels();
  $('base-url').value = settings.baseUrls[id] ?? '';
  $('base-url-row').hidden = !p.needsBaseUrl && id !== 'anthropic' && id !== 'openai';
  $('base-url').placeholder = p.needsBaseUrl ? 'https://host/v1' : 'Optional: a gateway in front of the API';
  $('api-key').value = '';
  $('api-key').placeholder = apiKeys[id] ? 'Saved. Enter a new key to replace it' : p.needsKey ? 'Paste your key' : 'Optional for a local server';
  $('auto-approve').checked = settings.autoApprove;
  $('key-help').textContent = p.keyHelp ?? '';
  $('get-key').hidden = !p.keyUrl;
  $('claude-login').hidden = !p.agentic || claudeStatus?.loggedIn === true || claudeStatus?.installed === false;
  for (const el of [$('api-key'), $('save-key'), $('delete-key')]) (el.closest('label') ?? el).hidden = Boolean(p.agentic);

  $('get-key').textContent = p.free ? 'GET A FREE KEY' : 'GET A KEY';
  $('get-key').classList.toggle('is-on', !apiKeys[id]);
  const memory = luna?.secrets.storage === 'memory';
  $('key-note').textContent = memory
    ? 'Outside LUNA, a key lasts only until this page reloads.'
    : 'Stored in your Mac\'s keychain. Requests go straight from this panel to the provider, and session details you ask about are sent with them.';
  $('delete-key').disabled = !apiKeys[id];
}

async function refreshHelper() {
  const health = await Builder.health();
  const el = $('helper-note');
  el.textContent = health
    ? `Add On builder ready. New Add Ons go in ${health.workspace}.`
    : 'Add On builder is off. Session edits work without it. To build Add Ons, get the installer, run it and say yes to the Add On builder.';
  $('get-builder').hidden = Boolean(health);
}

/** Fill the model list from the provider, and pick one if the user has not. Answers an error message or null. */
async function refreshModels() {
  const id = settings.provider;
  const p = PROVIDERS[id];
  if (p.needsKey && !apiKeys[id]) return null;
  let ids;
  try {
    ids = await listModels({ provider: p, apiKey: apiKeys[id], baseUrl: settings.baseUrls[id] });
  } catch (e) {
    return e?.message ?? String(e);
  }
  const picked = pickModel(p, ids);
  if (picked && !ids.includes(settings.autoModels[id] ?? '')) {
    settings.autoModels[id] = picked;
    saveSettings();
  }
  providerModels[id] = Providers.chatModels(p, ids);
  if (settings.provider === id) paintModels();
  return null;
}

// The models each provider offers, as the dropdown lists them.
const providerModels = {};

/** Fill the model dropdown for the chosen provider, with the model in use selected. */
function paintModels() {
  const id = settings.provider;
  const p = PROVIDERS[id];
  const select = $('model');
  const fixed = p.agentic ? p.models : null;
  const current = p.agentic ? settings.models[id] ?? '' : modelFor(id);
  const listed = providerModels[id]?.length ? providerModels[id] : p.models ?? [];
  const options = fixed ?? [...new Set([...listed, current].filter(Boolean))].map((m) => [m, m]);
  select.innerHTML = '';
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === modelFor(id) && !p.agentic && value === settings.autoModels[id] ? `${label} (recommended)` : label;
    select.appendChild(option);
  }
  select.value = current;
  select.disabled = options.length <= 1 && !p.agentic;
  // A server of the user's own may not list its models: let them type the name instead.
  const typed = Boolean(p.needsBaseUrl) && !(providerModels[id]?.length);
  select.hidden = typed;
  $('model-custom').hidden = !typed;
  $('model-custom').value = typed ? settings.models[id] ?? '' : '';
}

async function refreshClaude() {
  try {
    claudeStatus = await PROVIDERS.claude.status();
  } catch (e) {
    claudeStatus = { installed: false, loggedIn: false, error: e.message };
  }
  if (settings.provider === 'claude' && !$('settings').hidden) {
    paintSettings();
    $('key-note').textContent = claudeStatus.error
      ? claudeStatus.error
      : !claudeStatus.installed ? 'Claude Code is not on this Mac. Run Install SDK Controller again and say yes to Claude.'
        : claudeStatus.loggedIn ? `Signed in${claudeStatus.subscription ? ` with Claude ${claudeStatus.subscription}` : ''}. You're ready.`
          : 'Press SIGN IN TO CLAUDE, approve it in your browser, then come back here.';
  }
  paintState();
}

async function openExternal(url) {
  if (luna && (await luna.gui.available().catch(() => false))) await luna.gui.openUrl(url);
  else window.open(url, '_blank', 'noopener');
}

async function loadKey(id) {
  if (!luna || apiKeys[id] !== undefined || !PROVIDERS[id].secret) return;
  apiKeys[id] = (await luna.secrets.get(PROVIDERS[id].secret)) ?? '';
}

for (const [id, p] of Object.entries(PROVIDERS)) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = p.label;
  $('provider').appendChild(option);
}

$('settings-toggle').onclick = () => toggleSettings();
$('get-builder').onclick = () => void openExternal(BUILDER_URL);
$('claude-login').onclick = async () => {
  $('key-note').textContent = 'Opening Claude in your browser...';
  try {
    await PROVIDERS.claude.login();
  } catch (e) {
    $('key-note').textContent = e.message;
    return;
  }
  // Watch for the sign-in to finish, for two minutes.
  for (let i = 0; i < 40 && !claudeStatus?.loggedIn; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    await refreshClaude();
  }
};
$('get-key').onclick = () => void openExternal(PROVIDERS[settings.provider].keyUrl);
$('provider').onchange = async () => {
  settings.provider = $('provider').value;
  saveSettings();
  await loadKey(settings.provider);
  paintSettings();
  paintState();
  if (PROVIDERS[settings.provider].agentic) void refreshClaude();
  else void refreshModels();
};
$('model-custom').onchange = () => {
  settings.models[settings.provider] = $('model-custom').value.trim();
  saveSettings();
};
$('model').onchange = () => {
  settings.models[settings.provider] = $('model').value;
  saveSettings();
};
$('base-url').onchange = () => {
  const url = $('base-url').value.trim();
  const problem = checkBaseUrl(url);
  if (problem) {
    $('key-note').textContent = problem;
    return;
  }
  settings.baseUrls[settings.provider] = url;
  saveSettings();
};
$('auto-approve').onchange = () => {
  settings.autoApprove = $('auto-approve').checked;
  saveSettings();
};
$('save-key').onclick = async () => {
  const key = $('api-key').value.trim();
  if (!key) return;
  await luna.secrets.set(PROVIDERS[settings.provider].secret, key);
  apiKeys[settings.provider] = key;
  paintSettings();
  paintState();
  // Try the key at once, so a typo shows here rather than on the first request.
  $('key-note').textContent = 'Checking the key...';
  const problem = await refreshModels();
  $('key-note').textContent = problem ? `That key didn't work. ${problem}` : `Key works. Using ${modelFor(settings.provider)}. You're ready: close Settings and ask for something.`;
};
$('delete-key').onclick = async () => {
  await luna.secrets.delete(PROVIDERS[settings.provider].secret);
  apiKeys[settings.provider] = '';
  paintSettings();
  paintState();
};

// ---------------------------------------------------------------------------------------------
// Share to UA Universe: the helper packs the Add On and sends it for review, credited to the
// builder's name. Publishing happens after a person has checked it (sdk-controller-share).
// ---------------------------------------------------------------------------------------------

const BUILDER_KEY = 'com.cp.sdkcontroller.builder';
// A random id for this install, so a later share of the same Add On updates its listing.
function builder() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(BUILDER_KEY) ?? '{}'); } catch { /* start again */ }
  saved.key ||= Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(BUILDER_KEY, JSON.stringify(saved));
  return saved;
}

function shareMessage(text, isError = false) {
  $('share-status').textContent = text;
  $('share-status').classList.toggle('is-error', isError);
}

async function paintShareStatus() {
  const folder = $('share-addon').value;
  $('share-open').hidden = true;
  shareMessage('');
  if (!folder) return;
  try {
    const s = await Builder.shareStatus(folder);
    if (!s.shared) return;
    if (s.status === 'pending' || s.status === 'publishing') {
      shareMessage('Publishing...');
      setTimeout(() => void paintShareStatus(), 4000);
    } else if (s.status === 'failed') shareMessage(s.note ?? 'It could not be published yet. It will be tried again.', true);
    else if (s.status === 'rejected') shareMessage(`It wasn't published: ${s.note ?? 'no reason given'}. Change it and share it again.`, true);
    else if (s.status === 'published') {
      shareMessage(s.listing?.review
        ? 'Published and sent to Universal Audio for its final check. Once UA approves it, it appears on UA Universe and in LUNA. Share it again to send an update.'
        : 'Published. It goes to Universal Audio for its final check, then appears on UA Universe and in LUNA. Share it again to send an update.');
      $('share-open').hidden = false;
    }
  } catch (e) {
    shareMessage(e.message, true);
  }
}

async function fillShareFrom(folder) {
  if (!folder) return;
  try {
    const manifest = await Builder.manifestOf(folder);
    $('share-title').value = manifest.title ?? folder;
    $('share-description').value = manifest.description ?? '';
    // Its own category if it names one, else the SDK's guess from what it says, for them to confirm.
    $('share-category').value = manifest.categories?.[0] ?? Luna.suggestAddOnCategories(`${manifest.title ?? ''} ${manifest.description ?? ''}`)[0];
  } catch {
    $('share-title').value = folder;
  }
  await paintShareStatus();
}

async function toggleShare(open = $('share').hidden) {
  if (open && !$('settings').hidden) toggleSettings(false);
  $('share').hidden = !open;
  $('share-toggle').setAttribute('aria-expanded', String(open));
  $('share-toggle').classList.toggle('is-on', open);
  $('app').classList.toggle('is-settings', open || !$('settings').hidden);
  if (!open) return;
  $('share-name').value = builder().name ?? '';
  $('share-form').hidden = true;
  $('share-note').textContent = 'Looking for Add Ons you built...';
  let addOns = [];
  try {
    addOns = await Builder.listAddOns();
  } catch {
    $('share-note').textContent = 'Sharing needs the Add On builder. Run Install SDK Controller again and choose to set up the Add On builder.';
    return;
  }
  if (!addOns.length) {
    $('share-note').textContent = 'Build an Add On first: close this and ask for one, like "build me a window that shows the tempo in big numbers".';
    return;
  }
  $('share-note').textContent = 'No GitHub account needed. Your Add On is published with your name on it, and UA Universe reviews it before listing it.';
  const select = $('share-addon');
  const before = select.value;
  select.innerHTML = '';
  for (const folder of addOns) {
    const option = document.createElement('option');
    option.value = folder;
    option.textContent = folder;
    select.appendChild(option);
  }
  if (addOns.includes(before)) select.value = before;
  $('share-form').hidden = false;
  await fillShareFrom(select.value);
}

for (const category of Luna.ADD_ON_CATEGORIES) {
  const option = document.createElement('option');
  option.value = option.textContent = category;
  $('share-category').appendChild(option);
}
$('share-toggle').onclick = () => void toggleShare();
$('share-addon').onchange = () => void fillShareFrom($('share-addon').value);
$('share-name').onchange = () => {
  const b = builder();
  b.name = $('share-name').value.trim();
  localStorage.setItem(BUILDER_KEY, JSON.stringify(b));
};
$('share-open').onclick = () => void openExternal('https://universe.uaudio.com/discover');
$('share-send').onclick = async () => {
  const name = $('share-name').value.trim();
  if (!name) return shareMessage('Add your name first, so the listing can credit you.', true);
  if (!$('share-agree').checked) return shareMessage('Tick the box to agree to it being published first.', true);
  const b = builder();
  b.name = name;
  localStorage.setItem(BUILDER_KEY, JSON.stringify(b));
  $('share-send').disabled = true;
  shareMessage('Packing it up and sending...');
  try {
    await Builder.share({
      folder: $('share-addon').value,
      builderName: name,
      title: $('share-title').value.trim(),
      description: $('share-description').value.trim(),
      categories: [$('share-category').value],
      agreed: true,
      builderKey: b.key,
    });
    $('share-agree').checked = false;
    await paintShareStatus();
  } catch (e) {
    shareMessage(e.message, true);
  } finally {
    $('share-send').disabled = false;
  }
};

// ---------------------------------------------------------------------------------------------
// LUNA
// ---------------------------------------------------------------------------------------------

async function bindSession() {
  const next = luna.sessions.current();
  if (next !== session) marks = [];
  session = next;
  if (session) await session.ready();
  paintState();
}

async function connect() {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'Waiting for LUNA' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => {
    paintState();
    if (luna.status.value === 'connected') void bindSession();
  });
  await loadKey(settings.provider);
  void refreshModels();
  void refreshClaude();
  await bindSession();
  if (missingSetup()) toggleSettings(true);
}

showEmpty();
void connect();
