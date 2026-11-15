# Hoppy

Hoppy agents are AI agents that Hopscotch runs for you in the cloud. Each one has its own computer, its own files and a coding tool (such as Claude Code, Codex, OpenCode or Hermes) already set up. You give an agent a task, it works on its own computer, and you read its reply, the steps it took, its logs and its files when you want. Agents sleep when they are idle and wake when you send them something. They use your Hopscotch account's credit while they work.

This repository is `hoppy`: a Claude Code plugin and a terminal command that drive your Hoppy agents. It needs Node 22.18 or newer on your `PATH`, and has no other dependencies.

## Install in Claude Code

In Claude Code:

```text
/plugin marketplace add Uniblock-dev/hoppy-cli
/plugin install hoppy@hopscotch
```

Then run `/reload-plugins` (or start a new session), and sign in:

```text
/hoppy:login
```

Hoppy opens in your browser and you approve the sign-in there. With no browser, Claude shows you an address and a code to type instead. The key is saved on your computer and never shown.

The plugin brings:

- the `hoppy` tools, so Claude can list your agents, give them tasks, wait for the results, read their steps, logs and files, and sleep or wake them;
- the `hoppy` skill, which tells Claude how to hand an agent a task and check its work;
- the `/hoppy:login` skill;
- the `hoppy-operator` helper, which runs one task on one named agent and reports back. It cannot create, write to, sleep or delete agents, files or conversations.

To get updates: `/plugin marketplace update hopscotch`, then `/plugin update hoppy@hopscotch`.

## Install in a terminal

Run it once without installing:

```sh
npx -y github:Uniblock-dev/hoppy-cli login
```

Or install the `hoppy` command:

```sh
npm install -g github:Uniblock-dev/hoppy-cli
hoppy login
hoppy whoami
hoppy list
hoppy chat <agent> "say ok"
```

`hoppy help` lists every command. Every command takes `--json`, which prints one JSON value a program can read.

## Codex and OpenCode

The same tools work in Codex CLI and OpenCode through `hoppy mcp`, a local tool server that talks to the coding tool over its input and output. Sign in with `hoppy login` first. Both tools start the server as a command, so give them the installed `hoppy` command (from `npm install -g` above), or the full path to `cli/hoppy.ts` in a copy of this repository.

Codex:

```sh
codex mcp add hoppy -- hoppy mcp
```

For `codex exec`, which has nobody to approve tool calls, add this line under `[mcp_servers.hoppy]` in `~/.codex/config.toml`:

```toml
default_tools_approval_mode = "approve"
```

It allows every hoppy tool and nothing else, `delete_agent` included, so use it only for runs you trust. In the interactive Codex, leave it out and approve each call. Use `codex mcp add`, not Codex's plugin command: Codex does not fill in the plugin's paths, so the server would not start.

OpenCode:

```sh
opencode mcp add hoppy -- hoppy mcp
```

For a headless `opencode run`, allow the hoppy tools in the `permission` block of the same `opencode.json`:

```json
{ "permission": { "hoppy_*": "allow" } }
```

It allows every hoppy tool, `delete_agent` and `delete_file` included, so use it only for runs you trust. In the interactive OpenCode, leave it out and approve each call.

## Commands

`<agent>` is an agent's id or its exact name.

| Command | What it does |
| --- | --- |
| `login` | signs this computer in through your browser (`--no-browser` to type a code instead) and saves the key |
| `logout` | revokes the key and removes the key file |
| `whoami` | who the key belongs to |
| `list` | your account's agents |
| `create --harness <id>` | makes an agent (`--name`, `--model`, `--token-cap`) |
| `chat <agent> <message>` | sends a message and prints the reply as it is written |
| `chat <agent>` | at a terminal, a chat session in one conversation (`/new`, `/resume`, `/status`, `/cancel`, `/exit`) |
| `attach <agent> <message id>` | watches a message started earlier |
| `status <agent> <message id>` | where a message stands, once |
| `cancel <agent> <message id>` | stops a running message |
| `logs <agent>` | the agent's last lines of output; `-f` keeps following |
| `sleep <agent>` | puts it to sleep (`--deep` for deep sleep) |
| `wake <agent>` | wakes it |
| `restart <agent>` | starts it afresh with its saved settings |
| `usage` | your account's model calls and tokens (`--agent <agent>` for one agent, `--days <n>`) |
| `delete <agent>` | deletes it with its files |
| `files ls`, `put`, `get`, `mkdir`, `mv`, `rm` | the agent's files under `/data` |
| `env ls`, `set`, `rm` | the agent's settings; `env set` reads the value from stdin so it never sits in your shell history (`--secret` to keep it secret) |
| `steps <agent>` | the tools its model called |
| `conversations ls`, `rm` | its conversations |
| `task assign <agent> <goal>` | hands it a whole task in a new conversation (`--repo`, `--workdir`, `--file`, `--check`, `--returns`, `--token-cap`, `--push`, `--branch hoppy/<name>`) |
| `task result <task>` | where a task stands: done or failed, the check's result and the tokens used |
| `task wait <task>...` | waits until the tasks end, then prints each result |
| `task pull <task>` | fetches a task's `hoppy/` branch into your clone for review, without checking it out |
| `fleet run`, `list`, `clean` | one capped agent per task from a spec file, then collect the results and delete the agents |
| `pool fill`, `list`, `drain` | ready agents prepared from a template, for tasks that should start fast |
| `mcp` | serves these as tools for a coding tool such as Claude Code, Codex or OpenCode |

Check an agent's work before you trust it. Its check ran on its own computer, where it can change the tests. Review its changes with `git diff` without checking them out, and run its tests only in a throwaway copy with no secrets in it. A push to a `hoppy/` branch runs the repository's `on: push` GitHub Actions workflows with the repository's secrets, so ask for a push only on a repository whose workflows you would let the agent's code run.

Exit codes: 0 done, 1 the service refused or the message failed, 2 wrong usage or setup, 3 could not reach the service or stopped waiting, 130 stopped with Ctrl-C.

## Your key

`hoppy login` saves a key in `~/.config/hoppy/key` (under `XDG_CONFIG_HOME` when it is set), a file only you can read, with the address of the service it belongs to on the line after it. The key can read and manage your agents and lasts 90 days. hoppy never prints it, and takes any key out of everything it prints, apart from files fetched with `files get`, which are saved exactly as they are. hoppy also reads a key from `--key-file <path>` or the `HOPPY_KEY` environment variable.

To revoke it, run `hoppy logout`: it revokes the key on the service and deletes the file. You can also revoke any key on the Keys page in Hoppy.

## Which service it talks to

Today hoppy talks to Hopscotch's development service: the default address, `https://agents-brain-dev.hopscotchlabs.ai`, is the development one. `--url` or `HOPPY_URL` names another. hoppy sends its key only over https.

## License

Proprietary, see [LICENSE](LICENSE): you may install and run hoppy to use Hopscotch, but copying it or reusing its code is not allowed.
