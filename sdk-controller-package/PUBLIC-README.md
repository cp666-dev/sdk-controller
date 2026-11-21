# SDK Controller

Build and edit in [LUNA](https://www.uaudio.com/luna) by chatting. Ask SDK Controller to change
your session ("turn the drums down 3 dB", "send the vocal to a reverb"), or describe a tool you
want and it builds the LUNA Add On for you, tests it, installs it, and can share it to
[UA Universe](https://universe.uaudio.com) with your name on it.

It runs as a window inside LUNA and works with a free Google Gemini key, Groq, a Claude or OpenAI
API key, or another OpenAI-compatible model.

## Install

**From UA Universe or LUNA's Add On Showcase:** install SDK Controller. That gives you session
editing straight away. To build Add Ons too, open its Settings, press **GET THE BUILDER**, and run
the installer from the latest release here.

**From this repository:** download `SDK-Controller-<version>.zip` from the
[latest release](https://github.com/cp666-dev/sdk-controller/releases/latest), unzip it, and
double-click **Install SDK Controller.command** (the first time, right-click it and choose
**Open**). **READ ME FIRST.md** in the zip walks through the rest.

You need LUNA 3.1.2 or later. Building Add Ons also needs Node.js 22 or later (nodejs.org); the
installer downloads Universal Audio's LUNA Builder SDK for you.

## What's here

| Folder | What it is |
|---|---|
| `sdk-controller/` | The Add On: the chat window, the session tools and the model providers. |
| `sdk-controller-helper/` | A small local helper that lets it build Add Ons (a page can't write files). |
| `sdk-controller-package/` | The installer, the uninstaller and the scripts that build the release. |

Releases carry `SDK-Controller.lunaaddon`, which UA Universe and LUNA install, and the installer
zip.

## Privacy and safety

Requests go straight from SDK Controller to the provider you choose, with the session details it
reads. Keys stay in your Mac's keychain. Edits to your session wait for your GO unless you turn
that off; deletes always ask. Add Ons it builds run their tests on your Mac and install only
once those pass.

## Notices

Includes the browser build of Universal Audio's LUNA Builder SDK under the Apache License 2.0;
see `sdk-controller/THIRD_PARTY_NOTICES.md`.
