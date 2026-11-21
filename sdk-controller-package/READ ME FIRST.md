# SDK Controller

A chat panel inside LUNA. Type what you want, like "turn the drums down 3 dB" or "send the vocal
to a reverb", check what it's about to change, and press GO. It can also build you small tools
for LUNA while you work.

It starts on Google Gemini, which is free: you only need a Google account, no card. You can switch
to Groq (also free), a Claude or OpenAI API key, or another model, in Settings.

## You need

- A Mac with LUNA 3.1.1 or later.
- A free Gemini key. The panel's GET A FREE KEY button takes you to the page: sign in with Google,
  choose Create API key and paste it into the panel. Claude and OpenAI keys work too, and are
  charged to those accounts.
- Only to build new tools: Node.js 22 or later, from nodejs.org (the installer checks for it),
  and internet access while installing: the installer downloads Universal Audio's LUNA Builder SDK.

## Install

1. Quit LUNA.
2. Double-click **Install SDK Controller.command**. The first time, macOS may say it can't check
   the file. If it does, right-click it, choose **Open**, then **Open** again.
3. Answer the one question. Say yes to set up the Add On builder, or no if you only want to edit
   sessions. You can run the installer again later to add it.
4. Open LUNA and a session, then **Add Ons > Windows > SDK Controller**.
5. In **Settings**, press **GET A FREE KEY**, make your key, paste it and press **SAVE KEY**. The
   panel checks it straight away. It's kept in your Mac's keychain.

## Try

- "What's in this session?"
- "Make a drum bus and send the kick and snare to it."
- "Put markers at bar 1, 9 and 17 called Verse, Chorus and Verse 2."
- "Write Am, F, C, G on the chord track, one bar each, from bar 1."
- "That's not right, undo it."
- With the builder: "Build me a window that shows the tempo in big numbers."

Anything that changes your session waits for GO. Deleting things, and running or installing a tool
it built, always ask, even if you turn on auto-approve. Edits can be undone in LUNA as usual. Try
it on a copy of a session first.

## Share what you build

Press **SHARE** at the top of the window, pick the Add On, add your name, and press **SHARE TO
UNIVERSE**. No GitHub account needed: it's checked by hand, then published on UA Universe for
anyone to download, with your name on it. The panel shows when it's live.

## Good to know

- Requests go straight from the panel to the provider you chose, with the session details it reads
  (track names, levels, plugins, markers). Nothing goes anywhere else.
- When you approve a tool's tests, code the model wrote runs on your Mac. It isn't sandboxed, so
  read what you approve.
- It can't hear your audio. It sees the session: tracks, levels, plugins, clips, markers.
- Ollama has to be started with `OLLAMA_ORIGINS=*` so it accepts requests from the panel.

## Remove it

Double-click **Uninstall SDK Controller.command**. It says what it leaves in place (the SDK, tools
you built and your key) and where they are.

## Report a problem

Send your macOS and LUNA versions, the provider and model, what you asked and what happened.
Please don't send your API key, and check screenshots for it.

---

Built by Connor Panayi
https://panayi.me
https://www.linkedin.com/in/connor-panayi-40a3913ab/
