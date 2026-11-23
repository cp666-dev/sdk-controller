// SDK Controller: tools for building new Add Ons. The page cannot write files, so these call the
// local helper (../sdk-controller-helper). Session edits never need it. No DOM.

// Classic scripts share one global scope, so each file keeps its names to itself.
(() => {
// check/rehearse.mjs points this at a test helper with its own folders.
// In a browser on localhost, ?helper=<port> points at a test helper; never inside LUNA.
const testPort = location.hostname === 'localhost' ? new URLSearchParams(location.search).get('helper') : null;
const HELPER_URL = globalThis.SDC_HELPER_URL ?? (testPort && /^\d+$/.test(testPort) ? `http://127.0.0.1:${testPort}` : 'http://127.0.0.1:8795');
const FOLDER = { type: 'string', description: 'Add On folder name: lowercase letters, numbers and hyphens' };
const BS = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

async function helper(path, body, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${HELPER_URL}${path}`, body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('The Add On builder helper is not running. Tell the user to open Settings, press GET THE BUILDER, run the installer and say yes to the Add On builder. Session edits still work.');
  }
  const reply = await response.json().catch(() => ({}));
  // An older helper lacks newer routes, such as sharing.
  if (response.status === 404) throw new Error('This needs a newer Add On builder. Run Install SDK Controller again to update it.');
  if (!response.ok) throw new Error(reply.error ?? `The helper answered ${response.status}.`);
  return reply;
}

const needsNoSession = { needsSession: false };

const Builder = {
  helper,

  async health(fetchImpl) {
    try {
      return await helper('/health', undefined, fetchImpl);
    } catch {
      return null;
    }
  },

  async listAddOns() {
    return (await helper('/list', {})).addOns;
  },

  /** Title and description from a built Add On's manifest, to start the share form with. */
  async manifestOf(folder) {
    const { contents } = await helper('/read', { folder, path: 'manifest.json' });
    return JSON.parse(contents);
  },

  share: (details) => helper('/share', details),
  shareStatus: (folder) => helper('/share-status', { folder }),
  githubStart: () => helper('/github/connect/start', {}),
  githubPoll: (flowId) => helper('/github/connect/poll', { flowId }),
  githubUser: (token) => helper('/github/user', { token }),
  githubPublish: (details) => helper('/github/publish', details),

  TOOLS: [
    {
      ...needsNoSession,
      name: 'build_read_docs',
      description: 'Read the LUNA Builder SDK docs. Start with llms.txt, then QUICKSTART.md, before writing Add On code. Also MANIFEST.md, DRAWING.md (read it before drawing or animating anything), CLIPS.md, FILES.md, FILES-GUIDE.md, RECIPES.md, EVIDENCE.md, PROTOCOL.md. The API reference gives every exact method and property: api/index.md lists them, and each has a page such as api/classes/Session.md or api/classes/Meter.md. A long page comes in parts: read on with the offset it gives.',
      schema: BS({ name: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, ['name']),
      mode: 'read',
      describe: ({ name, offset }) => `Read SDK docs: ${name}${offset ? ` (from ${offset})` : ''}`,
      run: (_, { name, offset }) => helper('/docs', { name, offset }),
    },
    {
      ...needsNoSession,
      name: 'build_list',
      description: 'List the Add Ons built so far, or the files in one of them.',
      schema: BS({ folder: FOLDER }),
      mode: 'read',
      describe: ({ folder }) => (folder ? `List files in ${folder}` : 'List built Add Ons'),
      run: (_, { folder }) => helper('/list', { folder }),
    },
    {
      ...needsNoSession,
      name: 'build_read_file',
      description: 'Read a file in a built Add On.',
      schema: BS({ folder: FOLDER, path: { type: 'string' } }, ['folder', 'path']),
      mode: 'read',
      describe: ({ folder, path }) => `Read ${folder}/${path}`,
      run: (_, input) => helper('/read', input),
    },
    {
      ...needsNoSession,
      name: 'build_scaffold',
      description: 'Create a new Add On from the SDK template and install its test tools. Choose where it opens from the request, without asking: window if unsure. target: window (its own window), browser (panel beside Timeline or Mixer), editor (panel under the Timeline), app (a full LUNA page).',
      schema: BS({
        folder: FOLDER,
        name: { type: 'string', description: 'The name shown in LUNA' },
        target: { type: 'string', enum: ['window', 'browser', 'editor', 'app'] },
        description: { type: 'string' },
      }, ['folder', 'name', 'target']),
      mode: 'auto',
      describe: ({ name, target }) => `Create Add On "${name}" (${target})`,
      async run(_, input) {
        const r = await helper('/scaffold', input);
        if (!r.ok) throw new Error(`Creating it failed:\n${r.output}`);
        return r;
      },
    },
    {
      ...needsNoSession,
      name: 'build_write_file',
      description: 'Create or replace a text file in a built Add On, with its full contents.',
      schema: BS({ folder: FOLDER, path: { type: 'string' }, contents: { type: 'string' } }, ['folder', 'path', 'contents']),
      mode: 'auto',
      describe: ({ folder, path, contents }) => `Write ${folder}/${path} (${contents.length} characters)`,
      run: (_, input) => helper('/write', input),
    },
    {
      ...needsNoSession,
      name: 'build_test',
      description: 'Run an Add On\'s tests with npm test. This runs its code on the user\'s Mac. Tests must pass before build_install.',
      schema: BS({ folder: FOLDER }, ['folder']),
      mode: 'auto',
      describe: ({ folder }) => `Run the tests in ${folder}. This runs its code on your Mac`,
      async run(_, input) {
        // A failed run is a failed step: the model has to see it, and the panel must not tick it.
        const r = await helper('/test', input);
        if (!r.ok) throw new Error(`The tests failed${r.timedOut ? ' (timed out)' : ''}. Fix what they report, then run them again:\n${r.output}`);
        return r;
      },
    },
    {
      ...needsNoSession,
      name: 'build_install',
      description: 'Install a built Add On into LUNA. It appears in the Add Ons menu without a restart. Only after its tests pass.',
      schema: BS({ folder: FOLDER }, ['folder']),
      mode: 'auto',
      describe: ({ folder }) => `Install ${folder} into LUNA`,
      async run(_, input) {
        const r = await helper('/install', input);
        if (!r.ok) throw new Error(`Installing it failed:\n${r.output}`);
        return r;
      },
    },
  ],

  SYSTEM_PROMPT: `You can also build new LUNA Add Ons with the build_ tools, when the user wants a tool rather than an edit. Read llms.txt and QUICKSTART.md with build_read_docs first, and use only the API they describe; never guess one. Before calling a method or reading a property you have not seen in those guides, check it on its API reference page (api/classes/<Class>.md). The page loads classic scripts: no import or export, use the Luna global. Follow the docs: engine logic in logic.js with tests against Luna.MockEngine, DOM in main.js, a touch around every control the user edits. Then scaffold, write the files, run the tests, fix what fails, and install once they pass. Fill the manifest's description and one or two categories (docs/MANIFEST.md, Categories). Draw the Add On an icon: write icon.svg with viewBox 0 0 512 512, a rounded dark tile with one bold, simple picture of what it does, no text, readable at 64 px. Running the tests turns it into icon.png and sets it as the manifest's icon, which LUNA and UA Universe show. LUNA can report the session changing several times in a row while an Add On opens, so a page's session setup must survive overlapping calls: give each setup a number and stop an older one once a newer one starts, and subscribe everything again on each setup rather than skipping what an earlier one marked as subscribed (a meter that loses its last subscription stops updating). Tests outside LUNA don't show this. Once asked to build, work straight through to an installed Add On: don't stop to ask questions or for confirmation, choose sensible defaults, and say what you chose at the end. Keep what you build small and say where it appears in LUNA. You can change only Add Ons in the builder's own folder. An Add On reaches no web server unless its manifest lists the host in network; prefer ones that need none. When the user wants to share an Add On they built, tell them to press SHARE at the top of this window: it offers three ways to put it on UA Universe (shared for them with no account, from their own GitHub, or with help making a GitHub account first), each step by step.`,
};

globalThis.Builder = Builder;
})();
