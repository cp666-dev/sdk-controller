# Publishing SDK Controller to UA Universe

UA Universe lists an Add On from the latest release of a public GitHub repository with a
`.lunaaddon` attached, once the repository is visible to the UA Universe GitHub App and the
release passes Universe's check. Later releases go live on their own.

## Ready in this branch

- `sdk-controller/manifest.json`: id, title, version 1.0.0, manufacturer, description,
  categories (AI Tools, Create), `network` (the AI providers the panel calls),
  `min_luna_version` 3.1.2, SDK 3.1.2.65, icon.
- `sdk-controller/icon.png` (512 x 512) and its source, `sdk-controller/icon.svg`. Original
  artwork: no UA marks, in the panel or the icon.
- `sdk-controller-package/release.sh`: builds from the last commit (tests and the pre-demo
  check must pass) and publishes the release with `SDK-Controller.lunaaddon` and the installer
  zip.

## When you're ready to go public

1. Sign UA's builder agreement, from Builders home on universe.uaudio.com (Sign in, then the
   checklist), if you haven't.
2. Make the public repository, `cp666-dev/sdk-controller` (or set `SDK_CONTROLLER_REPO`), with
   the SDK Controller folders: `sdk-controller`, `sdk-controller-helper`,
   `sdk-controller-package` and, if you want it public, `sdk-controller-share`. Add a LICENSE
   of your choice.
3. Install the UA Universe GitHub App for all repositories on the account. That covers this
   repository and every `universe-*` repository `review.mjs` makes for shared Add Ons.
4. `sdk-controller-package/release.sh`. Universe checks the release, then lists it.
5. The panel's GET THE BUILDER button opens `https://github.com/cp666-dev/sdk-controller/releases/latest`
   (`BUILDER_URL` in `sdk-controller/main.js`). It works once step 4 is done; change it if the
   repository has another name.

## Sharing other people's Add Ons

`sdk-controller-share` runs on Fly.io (https://sdk-controller-share.fly.dev). When someone presses
SHARE, it publishes their Add On straight to GitHub under `GITHUB_OWNER`, the `luna-universe-community` account: a
public `universe-<name>` repository and a release with the `.lunaaddon`, credited to them. UA
Universe's own review then decides what is listed. Sharing the same Add On again publishes the
next version to the same repository.

It needs `GITHUB_TOKEN` as a Fly secret: a classic token from the luna-universe-community account, with only the `public_repo` scope. Without
one, submissions wait. `review.mjs` lists submissions, unpacks one to look at (`show`), publishes
one again after a failure (`publish`) and rejects with a reason the builder sees (`reject`).
