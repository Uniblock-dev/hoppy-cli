---
name: login
description: Sign Claude Code in to the account's hosted agents (hoppy login). Use when a hoppy tool says "not signed in", or the user asks to sign in to hoppy or Hopscotch Agents.
---

# Sign in to hoppy

hoppy opens Hoppy in the user's browser by itself. They approve the sign-in there, and the browser hands the key back to hoppy on this computer, which saves it in `~/.config/hoppy/key` (readable only by them). Nobody types a code. You never see, print or handle the key.

1. Check Node: run `node --version`. hoppy needs Node 22.18 or later (it runs its TypeScript directly). If it is older, tell the user to update Node and stop.

2. Check whether they are signed in already:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/cli/hoppy.ts" whoami --json
   ```

   If it prints an account, tell the user who they are signed in as (account and role) and stop. If it says there is no key, go on. If it says anything else (a key file others can read, a key from another brain), tell the user its words and stop.

3. Start the sign-in in the background (it waits until it is approved, up to ten minutes), using the Bash tool's background option:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/cli/hoppy.ts" login --json
   ```

   Read the output as soon as its first line is there. It is `{"userCode": ..., "verifyUrl": ..., "expiresIn": ..., "opened": ...}`.

   - `"opened": true`: hoppy opened Hoppy in their browser. Tell the user plainly: approve the sign-in in the Hoppy tab that just opened (sign in to Hopscotch first if asked). If no tab opened, they can go to the `verifyUrlComplete` address in that line.
   - `"opened": false`: no browser could open here (an SSH session, no screen). Show the user the `verifyUrl` address and the `userCode`, plainly: go to this address, sign in if asked, type this code, approve.

4. Wait for the background command to finish. Its last line is `{"signedIn": true, "keyFile": ..., "accountId": ..., "role": ..., "scopes": [...]}` on success. If it ends with an error instead (denied, expired, or the browser's answer did not match), say so plainly; nothing was saved, and the user can run `/hoppy:login` again.

5. Confirm with `whoami` (the command in step 2) and tell the user the account and role. The hoppy tools now work on their next call, with no restart. They take an agent's id or its exact name.

## Rules

- Never `cat`, read, copy or print the key file, and never put a key on a command line or in a message.
- Never open the address yourself with a browser tool: hoppy opens it, and an approval must happen in the user's own browser on this computer.
- Do not run `hoppy login --force` unless the user asks to replace the key they have.
- To sign out, the user runs `npx -y github:Uniblock-dev/hoppy-cli logout` in a terminal (or `hoppy logout` with the command installed): it ends the key on the service and removes the key file, for this plugin too.
- The plugin and the command come from the public repository https://github.com/Uniblock-dev/hoppy-cli; its README says how to install and update them.
- To sign in to a brain other than the dev one, the user sets `HOPPY_URL` before starting Claude Code, so the tools and these commands use the same brain.
