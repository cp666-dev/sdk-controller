// SDK Controller: sharing an Add On to UA Universe, three ways.
//   community  "Share it for me": no account; the share service publishes it on the LUNA Universe
//              Community GitHub account, credited to them, and it goes to UA's review.
//   github     "Use my GitHub account": connect GitHub with a short code (device sign-in), publish
//              to their own account, then four short steps on UA Universe.
//   newgithub  "Help me make a GitHub account": the same, after a guided sign-up.
// Each way is numbered steps with one action each. Progress is kept per Add On, so closing the
// window loses nothing. Loaded after main.js, whose $, luna and openExternal it uses.

const BUILDER_KEY = 'com.cp.sdkcontroller.builder';
const SHARE_KEY = 'com.cp.sdkcontroller.share';
const GITHUB_SECRET = 'github.token';

const WAYS = {
  community: { label: 'Share it for me', steps: ['details', 'done'] },
  github: { label: 'Use my GitHub account', steps: ['connect', 'details', 'universe'] },
  newgithub: { label: 'Help me make a GitHub account', steps: ['account', 'connect', 'details', 'universe'] },
};
const STEP_NAMES = { account: 'Make an account', connect: 'Connect GitHub', details: 'Describe it', done: 'Shared', universe: 'Put it on Universe' };

/** This install's builder: a random key (so a later share updates the listing), their name, GitHub login. */
function builder() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(BUILDER_KEY) ?? '{}'); } catch { /* start again */ }
  saved.key ||= Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(BUILDER_KEY, JSON.stringify(saved));
  return saved;
}
const saveBuilder = (b) => localStorage.setItem(BUILDER_KEY, JSON.stringify(b));

function shareStates() {
  try { return JSON.parse(localStorage.getItem(SHARE_KEY) ?? '{}'); } catch { return {}; }
}
/** Where this Add On's share is up to: { way, step, ticks }. */
function shareState(folder = $('share-addon').value) {
  return shareStates()[folder] ?? {};
}
function setShareState(patch, folder = $('share-addon').value) {
  const all = shareStates();
  all[folder] = { ...(all[folder] ?? {}), ...patch };
  localStorage.setItem(SHARE_KEY, JSON.stringify(all));
  return all[folder];
}

function shareMsg(text, isError = false) {
  $('share-msg').textContent = text ?? '';
  $('share-msg').classList.toggle('is-error', Boolean(isError));
}

/** Copy text, with a fallback for web views that refuse the clipboard API. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

async function githubToken() {
  return luna ? (await luna.secrets.get(GITHUB_SECRET)) ?? '' : '';
}

// ---------------------------------------------------------------------------------------------
// Showing the screen
// ---------------------------------------------------------------------------------------------

async function toggleShare(open = $('share').hidden) {
  if (open && !$('settings').hidden) toggleSettings(false);
  $('share').hidden = !open;
  $('share-toggle').setAttribute('aria-expanded', String(open));
  $('share-toggle').classList.toggle('is-on', open);
  $('app').classList.toggle('is-settings', open || !$('settings').hidden);
  if (!open) {
    stopConnectPolling();
    return;
  }
  $('share-body').hidden = true;
  $('share-note').textContent = 'Looking for Add Ons you built...';
  let addOns = [];
  try {
    addOns = await Builder.listAddOns();
  } catch {
    $('share-note').textContent = 'Sharing needs the Add On builder. Open Settings and press GET THE BUILDER.';
    return;
  }
  if (!addOns.length) {
    $('share-note').textContent = 'Build an Add On first: close this and ask for one, like "build me a window that shows the tempo in big numbers".';
    return;
  }
  $('share-note').textContent = 'Put an Add On you built on UA Universe, where anyone with LUNA can find and install it.';
  const select = $('share-addon');
  const before = select.value;
  select.innerHTML = '';
  for (const folder of addOns) {
    const option = document.createElement('option');
    option.value = option.textContent = folder;
    select.appendChild(option);
  }
  if (addOns.includes(before)) select.value = before;
  $('share-body').hidden = false;
  await openAddOn();
}

/** Show the chosen Add On: where it's been shared already, then its way and step, or the choice. */
async function openAddOn() {
  stopConnectPolling();
  shareMsg('');
  await fillDetails();
  await paintWhere();
  const s = shareState();
  if (s.way && WAYS[s.way]) showFlow(s.way, s.step);
  else showWays();
}

async function fillDetails() {
  const folder = $('share-addon').value;
  try {
    const manifest = await Builder.manifestOf(folder);
    $('share-title').value = manifest.title ?? folder;
    $('share-description').value = manifest.description ?? '';
    // Its own category if it names one, else the SDK's guess from what it says, for them to confirm.
    $('share-category').value = manifest.categories?.[0] ?? Luna.suggestAddOnCategories(`${manifest.title ?? ''} ${manifest.description ?? ''}`)[0];
  } catch {
    $('share-title').value = folder;
  }
  $('share-agree').checked = false;
}

/** A line saying where this Add On is already, so nobody shares it twice by accident. */
async function paintWhere() {
  const where = $('share-where');
  where.hidden = true;
  try {
    const s = await Builder.shareStatus($('share-addon').value);
    const lines = [];
    if (s.github) lines.push(`On your GitHub as version ${s.github.version} (${s.github.url}).`);
    if (s.status === 'published') lines.push('Shared on the LUNA Universe Community account.');
    else if (s.status === 'pending' || s.status === 'publishing') lines.push('Being shared on the LUNA Universe Community account now.');
    else if (s.status === 'rejected') lines.push(`Not shared: ${s.note ?? 'no reason given'}.`);
    if (lines.length) {
      where.textContent = `${lines.join(' ')} Sharing again sends an update.`;
      where.hidden = false;
    }
  } catch {
    // An older helper, or none: the steps below say what's needed.
  }
}

function showWays() {
  $('share-ways').hidden = false;
  $('share-flow').hidden = true;
}

function showFlow(way, step) {
  const steps = WAYS[way].steps;
  const current = steps.includes(step) ? step : steps[0];
  setShareState({ way, step: current });
  $('share-ways').hidden = true;
  $('share-flow').hidden = false;
  $('share-flow-way').textContent = WAYS[way].label;
  const stepper = $('share-stepper');
  stepper.innerHTML = '';
  const at = steps.indexOf(current);
  steps.forEach((name, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${STEP_NAMES[name]}`;
    li.classList.toggle('is-done', i < at);
    li.classList.toggle('is-now', i === at);
    if (i === at) li.setAttribute('aria-current', 'step');
    stepper.appendChild(li);
  });
  for (const card of document.querySelectorAll('.sdc-stepcard')) card.hidden = card.dataset.step !== current;
  shareMsg('');
  enterStep(way, current);
}

function nextStep() {
  const { way, step } = shareState();
  const steps = WAYS[way].steps;
  showFlow(way, steps[Math.min(steps.length - 1, steps.indexOf(step) + 1)]);
}

/** Set a step up when it's shown. */
async function enterStep(way, step) {
  if (step === 'account') {
    $('share-account-done').checked = false;
    $('share-account-next').disabled = true;
  } else if (step === 'connect') {
    await paintConnect();
  } else if (step === 'details') {
    const b = builder();
    const viaGitHub = way !== 'community';
    $('share-name').value = b.name || (viaGitHub ? b.github?.name ?? '' : '');
    $('share-send').textContent = viaGitHub ? 'PUBLISH TO MY GITHUB' : 'SHARE IT';
    $('share-agree-text').textContent = viaGitHub
      ? `I made this and I'm happy for it to be public on my GitHub${b.github ? ` (@${b.github.login})` : ''}, for anyone to download and use.`
      : 'I made this and I\'m happy for it to be published on the LUNA Universe Community account and listed on UA Universe, for anyone to download and use, credited to the name above.';
  } else if (step === 'done') {
    await paintCommunityDone();
  } else if (step === 'universe') {
    await paintUniverse();
  }
}

// ---------------------------------------------------------------------------------------------
// Step: make a GitHub account
// ---------------------------------------------------------------------------------------------

$('share-open-signup').onclick = () => void openExternal('https://github.com/signup');
$('share-account-done').onchange = () => { $('share-account-next').disabled = !$('share-account-done').checked; };
$('share-account-next').onclick = () => nextStep();

// ---------------------------------------------------------------------------------------------
// Step: connect GitHub (device sign-in)
// ---------------------------------------------------------------------------------------------

const deviceSignIn = { flowId: null, timer: null, url: 'https://github.com/login/device' };

function stopConnectPolling() {
  clearTimeout(deviceSignIn.timer);
  deviceSignIn.timer = null;
  deviceSignIn.flowId = null;
}

function connectView(which) {
  $('share-connect-start').hidden = which !== 'start';
  $('share-connect-code').hidden = which !== 'code';
  $('share-connect-done').hidden = which !== 'done';
}

/** Already connected (and still working)? Then say so; else offer to connect. */
async function paintConnect() {
  const token = await githubToken();
  if (token) {
    try {
      const me = await Builder.githubUser(token);
      const b = builder();
      b.github = me;
      saveBuilder(b);
      $('share-connected-as').textContent = `Connected as @${me.login}${me.name && me.name !== me.login ? ` (${me.name})` : ''}.`;
      connectView('done');
      return;
    } catch (e) {
      shareMsg(e.message, true);
    }
  }
  connectView('start');
}

$('share-connect').onclick = async () => {
  shareMsg('Asking GitHub for a code...');
  $('share-connect').disabled = true;
  try {
    const start = await Builder.githubStart();
    deviceSignIn.flowId = start.flowId;
    deviceSignIn.url = start.url;
    $('share-code').textContent = start.code;
    $('share-connect-wait').textContent = 'Waiting for you on GitHub...';
    connectView('code');
    shareMsg('');
    pollConnect(Math.max(5, start.interval ?? 5));
  } catch (e) {
    shareMsg(e.message, true);
  } finally {
    $('share-connect').disabled = false;
  }
};

$('share-copy-open').onclick = async () => {
  const copied = await copyText($('share-code').textContent);
  $('share-copy-open').textContent = copied ? 'COPIED. OPENING GITHUB...' : 'OPENING GITHUB...';
  setTimeout(() => { $('share-copy-open').textContent = 'COPY CODE AND OPEN GITHUB'; }, 3000);
  await openExternal(deviceSignIn.url);
};

function pollConnect(seconds) {
  const flowId = deviceSignIn.flowId;
  deviceSignIn.timer = setTimeout(async () => {
    if (deviceSignIn.flowId !== flowId) return;
    let r;
    try {
      r = await Builder.githubPoll(flowId);
    } catch (e) {
      shareMsg(e.message, true);
      return pollConnect(seconds);
    }
    if (deviceSignIn.flowId !== flowId) return;
    if (r.status === 'connected') {
      stopConnectPolling();
      if (luna) await luna.secrets.set(GITHUB_SECRET, r.token);
      const b = builder();
      b.github = { login: r.login, name: r.name };
      saveBuilder(b);
      $('share-connected-as').textContent = `Connected as @${r.login}${r.name && r.name !== r.login ? ` (${r.name})` : ''}.`;
      connectView('done');
      shareMsg('');
    } else if (r.status === 'denied') {
      stopConnectPolling();
      connectView('start');
      shareMsg('GitHub says you pressed Cancel. Press CONNECT GITHUB to try again.', true);
    } else if (r.status === 'expired') {
      stopConnectPolling();
      connectView('start');
      shareMsg('That code ran out (they last 15 minutes). Press CONNECT GITHUB for a new one.', true);
    } else {
      pollConnect(seconds);
    }
  }, seconds * 1000);
}

$('share-connect-next').onclick = () => nextStep();
$('share-disconnect').onclick = async () => {
  if (luna) await luna.secrets.delete(GITHUB_SECRET);
  const b = builder();
  delete b.github;
  saveBuilder(b);
  connectView('start');
  shareMsg('Disconnected. To remove SDK Controller from GitHub completely, see github.com/settings/applications.');
};

// ---------------------------------------------------------------------------------------------
// Step: describe it, then share or publish
// ---------------------------------------------------------------------------------------------

for (const category of Luna.ADD_ON_CATEGORIES) {
  const option = document.createElement('option');
  option.value = option.textContent = category;
  $('share-category').appendChild(option);
}

$('share-send').onclick = async () => {
  const { way } = shareState();
  const name = $('share-name').value.trim();
  const title = $('share-title').value.trim();
  if (!name) return shareMsg('Add your name: it\'s shown on the listing as the maker.', true);
  if (!title) return shareMsg('Give it a title.', true);
  if (!$('share-agree').checked) return shareMsg('Tick the box above the button to say it\'s OK to publish.', true);
  const b = builder();
  b.name = name;
  saveBuilder(b);
  const details = {
    folder: $('share-addon').value,
    builderName: name,
    title,
    description: $('share-description').value.trim(),
    categories: [$('share-category').value],
  };
  $('share-send').disabled = true;
  try {
    if (way === 'community') {
      shareMsg('Packing it up and sending...');
      await Builder.share({ ...details, agreed: true, builderKey: b.key });
    } else {
      const token = await githubToken();
      if (!token) {
        showFlow(way, 'connect');
        return shareMsg('Connect GitHub first.', true);
      }
      shareMsg('Publishing to your GitHub. This takes about a minute...');
      const out = await Builder.githubPublish({ ...details, token });
      setShareState({ published: out });
    }
    await paintWhere();
    nextStep();
  } catch (e) {
    shareMsg(e.message, true);
  } finally {
    $('share-send').disabled = false;
  }
};

// ---------------------------------------------------------------------------------------------
// Step: shared for them (community)
// ---------------------------------------------------------------------------------------------

async function paintCommunityDone() {
  $('share-open').hidden = true;
  let s;
  try {
    s = await Builder.shareStatus($('share-addon').value);
  } catch (e) {
    $('share-done-text').textContent = e.message;
    return;
  }
  if (s.status === 'pending' || s.status === 'publishing') {
    $('share-done-h').textContent = 'Sharing...';
    $('share-done-text').textContent = 'Putting it on GitHub for you. This takes a few seconds.';
    setTimeout(() => { if (shareState().step === 'done') void paintCommunityDone(); }, 4000);
  } else if (s.status === 'published') {
    $('share-done-h').textContent = 'Shared';
    $('share-done-text').textContent = 'It\'s published, with your name on it, and gone to Universal Audio for a final check. Once UA approves it, it appears in Discover on UA Universe and inside LUNA. To update it later, share it again the same way.';
    $('share-open').hidden = false;
  } else if (s.status === 'failed') {
    $('share-done-h').textContent = 'Not shared yet';
    $('share-done-text').textContent = s.note ?? 'It couldn\'t be published yet. It will be tried again.';
  } else if (s.status === 'rejected') {
    $('share-done-h').textContent = 'Not shared';
    $('share-done-text').textContent = `${s.note ?? 'No reason given.'} Change it, then share it again.`;
  } else {
    $('share-done-h').textContent = 'Shared';
    $('share-done-text').textContent = 'Sent.';
  }
}
$('share-open').onclick = () => void openExternal('https://universe.uaudio.com/discover');

// ---------------------------------------------------------------------------------------------
// Step: put it on UA Universe (their own GitHub)
// ---------------------------------------------------------------------------------------------

function universeSteps(repoUrl, login, repoName) {
  return [
    { id: 'signin', title: 'Sign in to UA Universe with GitHub', note: `Choose GitHub, as @${login}.`, button: 'OPEN UNIVERSE', url: 'https://universe.uaudio.com/builders/home' },
    { id: 'agreement', title: 'Sign the builder agreement', note: 'It\'s on the Builders page you just opened. One time only.', button: 'OPEN BUILDERS', url: 'https://universe.uaudio.com/builders/home' },
    { id: 'app', title: 'Let UA Universe see your Add On', note: `Choose @${login}, then All repositories (or just ${repoName}). One time only.`, button: 'OPEN GITHUB', url: 'https://github.com/apps/ua-universe/installations/new' },
    { id: 'submit', title: 'Submit it', note: `Paste your Add On's link there: ${repoUrl}`, button: 'COPY LINK AND OPEN', url: 'https://universe.uaudio.com/builders/publish', copy: repoUrl },
  ];
}

async function paintUniverse() {
  let published = shareState().published;
  if (!published) {
    const s = await Builder.shareStatus($('share-addon').value).catch(() => ({}));
    if (s.github) published = { repo: s.github.url, version: s.github.version, login: s.github.login };
  }
  if (!published) {
    showFlow(shareState().way, 'details');
    return;
  }
  const repoName = published.repo.split('/').pop();
  $('share-published').textContent = `Published to your GitHub as version ${published.version}: ${published.repo}`;
  const list = $('share-checklist');
  list.innerHTML = '';
  const ticks = shareState().ticks ?? {};
  // The one-time steps stay ticked across Add Ons, so a second share asks only for Submit.
  const once = builder().universeOnce ?? {};
  const items = universeSteps(published.repo, published.login ?? builder().github?.login ?? 'you', repoName);
  const repaint = () => {
    const done = items.every((it) => ticks[it.id] || once[it.id]);
    $('share-all-done').hidden = !done;
  };
  for (const it of items) {
    const li = document.createElement('li');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(ticks[it.id] || once[it.id]);
    box.setAttribute('aria-label', `Done: ${it.title}`);
    const text = document.createElement('div');
    text.className = 'sdc-check-t';
    text.textContent = it.title;
    const small = document.createElement('small');
    small.textContent = it.note;
    text.appendChild(small);
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'sdc-btn';
    go.textContent = it.button;
    go.onclick = async () => {
      if (it.copy) await copyText(it.copy);
      await openExternal(it.url);
    };
    box.onchange = () => {
      ticks[it.id] = box.checked;
      setShareState({ ticks });
      if (it.id !== 'submit') {
        const b = builder();
        b.universeOnce = { ...(b.universeOnce ?? {}), [it.id]: box.checked };
        saveBuilder(b);
        if (!box.checked) delete once[it.id];
      }
      li.classList.toggle('is-done', box.checked);
      repaint();
    };
    li.classList.toggle('is-done', box.checked);
    li.append(box, text, go);
    list.appendChild(li);
  }
  repaint();
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

$('share-toggle').onclick = () => void toggleShare();
$('share-addon').onchange = () => void openAddOn();
for (const card of document.querySelectorAll('.sdc-way')) {
  card.onclick = () => {
    // A fresh share of this Add On: start the way's steps from the top.
    setShareState({ way: card.dataset.way, step: null, ticks: {}, published: null });
    showFlow(card.dataset.way);
  };
}
$('share-change-way').onclick = () => {
  stopConnectPolling();
  setShareState({ way: null, step: null });
  showWays();
};
