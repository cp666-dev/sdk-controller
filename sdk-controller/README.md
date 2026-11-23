# SDK Controller

Chat with Claude, OpenAI or any OpenAI-compatible model in a LUNA side panel, to edit the open session and to build new Add Ons while you work.

| File | Purpose |
|---|---|
| `providers.js` | The LLM adapters: Anthropic, OpenAI, and any server that speaks Chat Completions. |
| `agent.js` | The conversation loop: reads run at once, edits wait for approval, input is checked against each tool's schema. |
| `logic.js` | The session tools, tested against `Luna.MockEngine`. |
| `builder.js` | The tools that build Add Ons, through `../sdk-controller-helper`. |
| `main.js`, `ui/` | The panel, following CP Assistant's "Strip" design: bridge with the UA mark, well, GO column. `ui/tokens.css` is LUNA's own design tokens, the same file CP Assistant and InterDAW use. |

## Setup

```sh
nvm use
npm install
npm test
npx ua-builder install
```

Open it from Add Ons > Windows (or move it into a side panel), then choose a provider in Settings and paste a key. Keys go in `luna.secrets`, the keychain inside LUNA. Requests go straight from the panel to the provider.

| Provider | Default | Notes |
|---|---|---|
| Google Gemini (free) | the newest Flash model the key can use | The default. A free key from Google AI Studio, no card. GET A FREE KEY opens the page. |
| Groq (free) | `openai/gpt-oss-120b` | Open models, free, very fast, with tighter daily limits. |
| Anthropic | `claude-opus-5-5` | High effort, with server-side fallback when a request is declined. Paid. |
| OpenAI | the newest GPT-5 the key can use | Paid. |
| Other (OpenAI-compatible) | none | A base URL and model. A server on this Mac (Ollama) works; another host has to be in the manifest's `network`, or LUNA blocks it. |

Saving a key checks it at once and picks the model from the provider's own list.

## Sharing to UA Universe

SHARE (`share.js`) offers three ways, each as numbered steps:

- **Share it for me:** the helper packs the Add On and sends it to `../sdk-controller-share`, which
  publishes it on the luna-universe-community GitHub account, credited to the builder.
- **Use my GitHub account:** GitHub's device sign-in (a short code typed on github.com, through the
  helper's `/github/connect/*`), then `/github/publish` makes a public repository and release on
  their account, then a checklist for UA Universe (sign in, builder agreement, the UA Universe
  GitHub app, submit). The token is kept in LUNA's keychain.
- **Help me make a GitHub account:** guided sign-up, then the same.

`check/share-check.sh` drives all three against a stand-in GitHub and a local share service.
Release notes are in `CHANGELOG.md`.

## What it can do

Reads run without asking. Edits show a GO card first, unless auto-approve is on in Settings. Deleting, raw engine commands, running tests and installing always ask.

- Read: the session, a track's effects and clips, plugins, any engine path.
- Edit: name, gain, pan, mute, solo, new tracks and buses, sends, plugins, bypass, markers, tempo, meter, chords, MIDI notes, transport, loop, undo, save.
- Anything else: `engine_call` runs any engine command, after you approve the exact path and values.

Control edits in one approved batch are one undo step. New tracks, buses, sends, plugins, markers, chords and notes have to see their own result, which LUNA holds back during a transaction, so each is its own undo step.

## Building Add Ons

The page cannot write files, so this needs the helper running. Session edits do not. It starts at
login once installed:

```sh
sdk-controller-helper/install-login-item.sh
```

See `../sdk-controller-helper/README.md`.

## Before a demo

```sh
check/check.sh               # every session tool through the real panel, against the mock engine
check/check.sh --read-only   # reads only, against the session open in LUNA
check/check.sh --live        # every tool against LUNA's open session: use a scratch session
```

Then rehearse the demo's prompts with the real model, against a mock session (a few cents):

```sh
ANTHROPIC_API_KEY=... node check/rehearse.mjs
ANTHROPIC_API_KEY=... node check/rehearse.mjs "your prompt" "another"
```

The checks drive the panel in headless Chrome with a scripted stand-in for the model, approving every GO
card, and passes only if every step ran and came back ok. The editing checks refuse a session that has tracks unless its name has scratch, check or test in it. `--live` adds and deletes "SDC Check"
tracks, a bus and a marker, and leaves a tempo change at bar 9, 3/4 from bar 13 and four chords.
