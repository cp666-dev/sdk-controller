# SDK Controller release notes

## 2.0.1

- **Category menu fixed.** When sharing, "Category, where people will find it" listed
  "[object Object]" instead of the categories. It lists them again, with a short description of
  each when you hover over one.
- **Sharing waits for the sharing service to wake up.** "Share it for me" could fail with "The
  sharing service answered 502" when the service had been idle. SDK Controller now waits for it
  (up to about a minute and a half) and then shares. If it really is down, it says so plainly
  and that nothing was shared.
- **Stop the beat.** While SDK Controller works on a prompt, STOP BEAT next to the timer stops the
  step sequencer, and PLAY BEAT starts it again. It remembers your choice. The STOP button at the
  bottom still cancels the request.

## 2.0.0

**Three ways to share to UA Universe.** SHARE now asks how you'd like to share an Add On you
built, and walks you through it one step at a time:

- **Share it for me.** No account needed: it's published on the LUNA Universe Community account
  with your name on it, and goes to Universal Audio for a final check. As before, about a minute.
- **Use my GitHub account.** Connect GitHub by typing a short code on github.com (your password
  never comes near SDK Controller). It's published as a public repository on your own account,
  so it's yours to update, then four short steps put it on UA Universe; three of them are one
  time only.
- **Help me make a GitHub account.** Plain-language steps through GitHub's free sign-up, then on
  into the GitHub way above.

Each way shows its steps and where you are, does one thing per step, won't let you skip what's
needed, and remembers where you got to if you close the window. Sharing an Add On again sends an
update the same way. The window also says where an Add On is already shared, so it isn't shared
twice by accident.

**Removed:** using a Claude Pro or Max plan through Claude Code (taken out in 1.0.2). New installs
start on free Google Gemini; Gemini, Groq, Anthropic and OpenAI keys and other servers are
unchanged.

**Builder:** the helper serves the SDK's drawing guide (DRAWING.md), finds an SDK the installer
downloaded from Universal Audio, and the installer no longer bundles one.

## 1.0.2

Took out the Claude subscription option.

## 1.0.1

Found Claude Code wherever it was installed (since removed).

## 1.0.0

First release: chat with an AI model inside LUNA to edit your session and build Add Ons, then share
them to UA Universe.
