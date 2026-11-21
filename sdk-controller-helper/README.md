# SDK Controller helper

Gives the SDK Controller panel the file access a page does not have, so an LLM can build Add Ons. Needs Node 22 or later and has no dependencies.

```sh
./run.sh                       # foreground (finds Node 22 or later); or: node server.mjs
node --test tests/*.test.mjs
./install-login-item.sh        # start at login, restart if it exits; logs in ~/Library/Logs/SDK Controller
./uninstall-login-item.sh
```

From a git checkout the login item runs the built copy in `~/LUNA Built Add Ons/branches/sdk-controller`,
so it keeps working whichever branch is checked out. That `branches` folder is reserved: the panel
never lists, reads, writes or installs it.

| Setting | Default |
|---|---|
| `SDK_CONTROLLER_WORKSPACE` | `~/LUNA Built Add Ons` |
| `SDK_CONTROLLER_PORT` | `8795` (the panel expects this one) |
| `UA_ADDONS_FOLDER` | LUNA's Add Ons folder. Set it when testing, so `install` does not touch the real one. |

## Limits

- Listens on 127.0.0.1 and answers only the panel's origin, so other websites cannot reach it.
- Reads and writes only inside the workspace, and not `node_modules`, `vendor` or `.git`.
- Child processes get a minimal environment, with no tokens or keys from your shell.
- `/test` runs generated code on your Mac with your user's permissions. It is not a sandbox, which is why the panel always asks first.
