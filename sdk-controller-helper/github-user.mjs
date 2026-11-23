// Share to the user's own GitHub account: sign in with GitHub's device flow (the user types a
// short code on github.com, so no password or token passes through here), then publish the Add On
// as a public repository and release in their account, which UA Universe lists once they submit it.
//
//   /github/connect/start  -> { flowId, code, url, expiresIn }
//   /github/connect/poll   { flowId } -> { status: waiting | connected | expired | denied, token?, login?, name? }
//   /github/user           { token } -> { login, name }
//   /github/publish        { token, folder, title, description, categories, builderName } -> { repo, release, version }
//
// The token goes back to the page, which keeps it in LUNA's keychain and sends it with each publish.

import { randomBytes } from 'node:crypto';
import { Refused, readZip } from './publish/addon.mjs';
import { listingIcon } from './publish/icon.mjs';
import { writeZip } from './publish/zip.mjs';

// public_repo: make and update public repositories, nothing else.
const SCOPE = 'public_repo';
const BUILD_ONLY = /^(readme\.md|package(-lock)?\.json|vitest\.config\.[cm]?js|tests?\/|node_modules\/|\.)/i;

export const slugify = (text) => String(text).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'add-on';

export function nextVersion(previousTag) {
  const m = String(previousTag ?? '').match(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${Number(m[2]) + 1}.0` : '1.0.0';
}

export function createGitHubUser({ clientId, fetchImpl = fetch, web = 'https://github.com', api = 'https://api.github.com', uploads = 'https://uploads.github.com', packAddOn, readShared, writeShared }) {
  const flows = new Map();

  const form = async (url, body) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };

  const gh = (token) => async (method, url, body, { raw, contentType } = {}) => {
    const r = await fetchImpl(url.startsWith('http') ? url : `${api}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'sdk-controller',
        ...(body === undefined ? {} : { 'content-type': contentType ?? 'application/json' }),
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const err = new Error(`GitHub: ${data?.message ?? r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  };

  async function whoAmI(token) {
    try {
      const me = await gh(token)('GET', '/user');
      return { login: me.login, name: me.name || me.login };
    } catch (e) {
      if (e.status === 401) throw new Refused('Your GitHub connection has expired or was removed. Connect GitHub again.');
      throw new Refused(`Couldn't reach GitHub: ${e.message}`);
    }
  }

  /** A repository name that is free, or already this Add On's from an earlier share. */
  async function repoFor(call, login, title, known) {
    if (known?.login === login && known.repo) {
      try {
        return await call('GET', `/repos/${login}/${known.repo}`);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    const base = slugify(title);
    for (let n = 1; n < 50; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      try {
        await call('GET', `/repos/${login}/${name}`);
      } catch (e) {
        if (e.status === 404) return { name, isNew: true };
        throw e;
      }
    }
    throw new Refused('Every name tried for the repository is taken. Change the title and share again.');
  }

  const routes = {
    async '/github/connect/start'() {
      if (!clientId) throw new Refused('Connecting GitHub isn\'t set up in this copy of SDK Controller yet. Use "Share it for me" for now.');
      const r = await form(`${web}/login/device/code`, { client_id: clientId, scope: SCOPE });
      if (!r.device_code) throw new Refused(`GitHub didn't start the sign-in: ${r.error_description ?? r.error ?? 'no reason given'}.`);
      const flowId = randomBytes(9).toString('hex');
      flows.set(flowId, { device: r.device_code, interval: r.interval ?? 5, expiresAt: Date.now() + (r.expires_in ?? 900) * 1000, next: 0 });
      return { flowId, code: r.user_code, url: r.verification_uri, expiresIn: r.expires_in ?? 900, interval: r.interval ?? 5 };
    },

    async '/github/connect/poll'({ flowId }) {
      const flow = flows.get(flowId);
      if (!flow || Date.now() > flow.expiresAt) return { status: 'expired' };
      // GitHub asks to be polled no faster than its interval; answer "waiting" in between.
      if (Date.now() < flow.next) return { status: 'waiting' };
      flow.next = Date.now() + flow.interval * 1000;
      const r = await form(`${web}/login/oauth/access_token`, { client_id: clientId, device_code: flow.device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (r.access_token) {
        flows.delete(flowId);
        const me = await whoAmI(r.access_token);
        return { status: 'connected', token: r.access_token, ...me };
      }
      if (r.error === 'authorization_pending') return { status: 'waiting' };
      if (r.error === 'slow_down') {
        flow.interval += 5;
        return { status: 'waiting' };
      }
      flows.delete(flowId);
      if (r.error === 'access_denied') return { status: 'denied' };
      return { status: 'expired' };
    },

    async '/github/user'({ token }) {
      if (typeof token !== 'string' || !token) throw new Refused('Connect GitHub first.');
      return whoAmI(token);
    },

    async '/github/publish'({ token, folder, title, description, categories, builderName }) {
      if (typeof token !== 'string' || !token) throw new Refused('Connect GitHub first.');
      if (typeof title !== 'string' || !title.trim()) throw new Refused('Give your Add On a title.');
      const me = await whoAmI(token);
      const call = gh(token);
      const buf = await packAddOn(folder);
      const zip = readZip(buf);
      const manifestName = zip.names.find((n) => /^[^/]+\/manifest\.json$/.test(n));
      const top = manifestName.split('/')[0];
      const manifest = JSON.parse(zip.read(manifestName).toString('utf8'));

      const shared = await readShared();
      const known = shared[folder]?.github;
      const repo = await repoFor(call, me.login, title.trim(), known);
      let previous = null;
      if (!repo.isNew) {
        try {
          previous = (await call('GET', `/repos/${me.login}/${repo.name}/releases/latest`)).tag_name;
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      const version = nextVersion(previous);
      const credit = 'Made with SDK Controller.';
      const published = {
        ...manifest,
        package_name: title.trim().replace(/[/\\:]/g, '-'),
        // Their own id, under their GitHub name, so it never clashes with anyone else's.
        id: `io.github.${me.login.toLowerCase().replace(/[^a-z0-9]/g, '')}.${slugify(title).replaceAll('-', '')}`,
        title: title.trim(),
        version,
        manufacturer: (builderName || me.name).trim(),
        description: [String(description ?? manifest.description ?? '').trim(), credit].filter(Boolean).join(' '),
        categories: manifest.categories?.length ? manifest.categories : Array.isArray(categories) && categories.length ? categories.slice(0, 2) : ['Utility'],
      };
      const files = zip.names
        .filter((n) => n.startsWith(`${top}/`) && !n.endsWith('/'))
        .map((n) => ({ rel: n.slice(top.length + 1), name: n }))
        .filter(({ rel }) => !BUILD_ONLY.test(rel))
        .map(({ rel, name }) => ({ rel, data: zip.read(name) }));
      const iconRel = typeof published.icon === 'string' ? published.icon.replace(/^\.\//, '') : '';
      if (!/\.(png|jpe?g)$/i.test(iconRel) || !files.some((f) => f.rel === iconRel)) {
        const rel = files.some((f) => f.rel === 'icon.png') ? 'listing-icon.png' : 'icon.png';
        files.push({ rel, data: listingIcon(published.title) });
        published.icon = rel;
      }
      const manifestRel = manifestName.slice(top.length + 1);
      for (const f of files) if (f.rel === manifestRel) f.data = Buffer.from(`${JSON.stringify(published, null, 4)}\n`);
      files.push({ rel: 'README.md', data: Buffer.from(`# ${published.title}\n\n${published.description}\n\nA LUNA Add On by ${published.manufacturer}. Install it from UA Universe or LUNA's Add On Showcase, or open the .lunaaddon in this repository's latest release.\n`) });
      const lunaaddon = writeZip(files.map((f) => ({ name: `${published.package_name}/${f.rel}`, data: f.data })));

      const made = repo.isNew
        ? await call('POST', '/user/repos', { name: repo.name, description: published.description.slice(0, 340), private: false, auto_init: true, has_issues: true, has_wiki: false, has_projects: false })
        : repo;
      const branch = made.default_branch ?? 'main';
      const ref = await call('GET', `/repos/${me.login}/${made.name}/git/ref/heads/${branch}`);
      const tree = [];
      for (const f of files) {
        const blob = await call('POST', `/repos/${me.login}/${made.name}/git/blobs`, { content: f.data.toString('base64'), encoding: 'base64' });
        tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const newTree = await call('POST', `/repos/${me.login}/${made.name}/git/trees`, { tree });
      const commit = await call('POST', `/repos/${me.login}/${made.name}/git/commits`, { message: `${published.title} ${version}`, tree: newTree.sha, parents: [ref.object.sha] });
      await call('PATCH', `/repos/${me.login}/${made.name}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
      const release = await call('POST', `/repos/${me.login}/${made.name}/releases`, { tag_name: `v${version}`, name: `${published.title} ${version}`, body: published.description, target_commitish: branch });
      await call('POST', `${uploads}/repos/${me.login}/${made.name}/releases/${release.id}/assets?name=${encodeURIComponent(`${slugify(published.title)}.lunaaddon`)}`, lunaaddon, { raw: true, contentType: 'application/zip' });

      const repoUrl = made.html_url ?? `https://github.com/${me.login}/${made.name}`;
      shared[folder] = { ...(shared[folder] ?? {}), github: { login: me.login, repo: made.name, url: repoUrl, version, at: new Date().toISOString() } };
      await writeShared(shared);
      return { repo: repoUrl, release: release.html_url, version, login: me.login, isUpdate: !repo.isNew };
    },
  };

  return { routes };
}
