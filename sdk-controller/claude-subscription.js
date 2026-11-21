// SDK Controller: Claude with the user's own Claude subscription, through the helper, which runs
// their Claude Code in the background (../sdk-controller-helper/claude.mjs). Claude Code runs the
// conversation; every tool call comes back here to be approved and run like any other provider's.
// No DOM.

// Classic scripts share one global scope, so each file keeps its names to itself.
(() => {
const helperUrl = () => globalThis.SDC_HELPER_URL ?? 'http://127.0.0.1:8795';

async function call(path, body) {
  let response;
  try {
    response = await fetch(`${helperUrl()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  } catch {
    throw new Providers.ProviderError('Claude with your subscription needs the Add On builder helper running. Open Settings and press GET THE BUILDER.');
  }
  const reply = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Providers.ProviderError('This needs a newer Add On builder. Run Install SDK Controller again to update it.');
  if (!response.ok) throw new Providers.ProviderError(reply.error ?? `The helper answered ${response.status}.`);
  return reply;
}

const claude = {
  label: 'Claude (your subscription)',
  defaultModel: '',
  needsKey: false,
  agentic: true,
  // Claude Code's aliases; '' leaves it to the plan's default.
  models: [['', 'Your plan\'s default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']],
  keyHelp: 'Uses the Claude Pro or Max plan you sign in with. Nothing to pay beyond it, and no key. Needs Claude Code on this Mac, which the installer can add.',
  status: () => call('/claude/status'),
  login: () => call('/claude/login'),
  start: (turn) => call('/claude/turn', turn),
  poll: (turnId, after) => call('/claude/poll', { turnId, after }),
  toolResult: (turnId, callId, content, isError) => call('/claude/tool-result', { turnId, callId, content, isError }),
  stop: (turnId) => call('/claude/stop', { turnId }).catch(() => {}),
};

// First in the list, as the default: rebuild the object in that order.
const all = Providers.PROVIDERS;
const order = Object.entries(all);
for (const key of Object.keys(all)) delete all[key];
all.claude = claude;
for (const [key, provider] of order) all[key] = provider;
})();
