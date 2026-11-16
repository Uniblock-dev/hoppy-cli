#!/usr/bin/env node
/**
 * hoppy: run and manage hosted agents from a terminal, one command each, built only on the
 * TypeScript SDK beside it (../typescript).
 *
 *   hoppy whoami
 *   hoppy chat <agent> "say ok" --json
 *
 * hoppy help lists every command; the README has each one, and the exit codes.
 */

import { FleetManager, unfinishedFleets } from './fleet.js';
import { PoolManager, poolCapWarning } from './pool.js';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentHost, AgentHostError, VERSION,                                                                   } from '../typescript/src/index.js';
import { LiveReader, StreamError,                            } from '../typescript/src/stream.js';
import { watchEventsRoute } from './served.js';
import { keepsWord, releaseEvents, safePieces, startsOver } from './words.js';
import { hiddenValue, KEY_SHAPES } from './hidden.js';
import { Markdown } from './markdown.js';
import { resolveAgent } from './names.js';
import { assignTask, CHECK_SECONDS_MAX, pullTask, REMOTE, TaskFailed, TaskRefused, taskDir, taskTokenCap } from './task.js';

const DEFAULT_URL = 'https://agents-brain-dev.hopscotchlabs.ai';

const HELP = `hoppy: run and manage hosted agents from a terminal.

Usage: hoppy <command> [arguments] [--json] [--debug]

Commands:
  login                          sign this terminal in: opens Hoppy in the browser to approve
                                 it (--no-browser shows a code to type instead), then keeps the
                                 key in the key file (--force to replace a key already there,
                                 which it then revokes)
  logout                         revoke the key on the brain it came from and remove the key file
  whoami                         who the key is: its account, role and scopes
  list                           the account's agents
  create --harness <id>          make an agent (--name, --model, --image, --token-cap too)
  chat <agent> <message>         send a message and print the reply as it comes, with a
                                 line per tool step; Ctrl-C stops watching and leaves it
                                 running (--timeout <seconds>, --thinking, --conversation <id>)
  chat <agent>                   at a terminal, a session: each line typed is sent in one
                                 conversation; /new, /resume, /status, /cancel, /exit or Ctrl-D
  attach <agent> <message id>    watch a message started earlier (--after <cursor> to go
                                 on from where an earlier watch stopped)
  status <agent> <message id>    where a message stands: running, done or failed
  cancel <agent> <message id>    stop a running message; it then ends failed, cancelled
  logs <agent>                   the agent's last lines of output; -f (--follow) keeps
                                 printing new ones until Ctrl-C
  sleep <agent>                  put it to sleep (--deep for deep sleep)
  wake <agent>                   wake it
  restart <agent>                start it afresh with its saved settings
  usage                          the account's model calls (--days <n>, --agent <id>)
  delete <agent>                 delete it with its files
  files ls <agent> [path]        list a folder under /data (default /data)
  files put <agent> <file> [path]  upload a file (- reads stdin); path defaults to
                                 /data/<file name>
  files get <agent> <path> [file]  download a file (- writes stdout); refuses to
                                 replace a file unless --force
  files mkdir <agent> <path>     make a folder
  files mv <agent> <from> <to>   move or rename
  files rm <agent> <path>        delete a file, or a folder with everything in it
  env ls <agent>                 its settings; a secret one's value is never shown
  env set <agent> <NAME>         set one, the value read from stdin and never printed
                                 (--secret, --apply to restart it with the value)
  env rm <agent> <NAME>          remove one
  steps <agent>                  the tools its model called (--message <id> for one message)
  conversations ls <agent>       its conversations, newest first
  conversations rm <agent> <id>  delete one with its messages
  task assign <agent> <goal>     hand it a whole task in one message, in a new conversation:
                                 --repo (cloned into --workdir when missing), --file (a path
                                 to read first; repeat it), --check (a command run once in
                                 the workdir after it ends), --returns, --check-seconds, --token-cap,
                                 --push (commit and push to a new hoppy/ branch; needs
                                 --repo) or --branch hoppy/<name>
  task result <task>             where the task stands: done or failed, the check's exit code
                                 and output (it ran on the agent's computer), tokens used
  task wait <task>...            wait until the tasks end (--until any for the first one), at
                                 most --timeout seconds, then print each result
  task pull <task>               fetch the task's hoppy/ branch into origin/hoppy/... of the
                                 clone you are in, for review; never checks it out or runs it
  fleet run <spec.json>          create a capped agent per task, wait, collect and delete (--keep keeps agents)
  fleet list                    show local runs and their saved results
  fleet clean [run]             finish cleanup after a crash; no run cleans unfinished runs
  pool fill <name> --template <file>  prepare checked clones in deep sleep (--size defaults to 2)
  pool list                     show local pools, dirty agents and measured wake times
  pool drain <name>              delete free pool agents; leave busy and dirty agents alone
  task assign --pool <name> <goal>  claim and reset one ready clone for the task
  mcp                            serve these as MCP tools on stdin and stdout, for a
                                 coding tool such as Claude Code or Codex
  help                           this text

Options:
  --json        print one JSON value a program can read; chat and attach print each
                live event as a JSON line first
  --debug       say each call and its answer on stderr (never the key)
  --url <url>   the brain (HOPPY_URL, default ${DEFAULT_URL}); https only, apart from this machine
  --key-file    the file holding the key (default ~/.config/hoppy/key, mode 600)

<agent> is an agent's id or its exact name.

The key comes from --key-file, else HOPPY_KEY, else ~/.config/hoppy/key; hoppy login saves it there.
Exit codes: 0 done, 1 the brain refused or the message failed, 2 wrong usage or setup,
3 could not reach the brain or stopped waiting, 130 detached with Ctrl-C.
`;

/** Wrong usage or an unsafe setup: exit 2. */
class UsageError extends Error {}
/** No key anywhere hoppy looks: a setup a person fixes by signing in. */
class NoKeyError extends UsageError {}

const OPTIONS = {
  json: { type: 'boolean' },
  debug: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  url: { type: 'string' },
  'key-file': { type: 'string' },
  harness: { type: 'string' },
  image: { type: 'string' },
  name: { type: 'string' },
  model: { type: 'string' },
  deep: { type: 'boolean' },
  days: { type: 'string' },
  agent: { type: 'string' },
  conversation: { type: 'string' },
  timeout: { type: 'string' },
  follow: { type: 'boolean', short: 'f' },
  force: { type: 'boolean' },
  secret: { type: 'boolean' },
  apply: { type: 'boolean' },
  message: { type: 'string' },
  thinking: { type: 'boolean' },
  after: { type: 'string' },
  'no-browser': { type: 'boolean' },
  repo: { type: 'string' },
  workdir: { type: 'string' },
  file: { type: 'string', multiple: true },
  check: { type: 'string' },
  returns: { type: 'string' },
  'check-seconds': { type: 'string' },
  'token-cap': { type: 'string' },
  until: { type: 'string' },
  keep: { type: 'boolean' },
  push: { type: 'boolean' },
  branch: { type: 'string' },
  pool: { type: 'string' },
  template: { type: 'string' },
  size: { type: 'string' },
}         ;

let json = false;
let key = '';
/** Keys hoppy holds besides the one in use, such as the one a forced login replaces: never printed. */
const unsaid           = [];
/** The command being run, such as "files ls", for a plain refusal. */
let doing = '';

/**
 * Text with any credential taken out: the key in use, and anything shaped like a key or a session,
 * since a brain's error message or an agent's own output could carry one.
 */
function hide(text        )         {
  let t = key ? text.split(key).join('[hidden]') : text;
  for (const v of unsaid) t = t.split(v).join('[hidden]');
  // Two rules. At the start of a word (or right after a colour code, which ends in a letter so \b
  // sees no edge), anything key-shaped. Glued to a letter or digit, only the formats the brain and
  // host issue: a key is ak_ and 48 hex characters, a session is ses_ and 43 base64url characters.
  // Text that is itself JSON, a percent-encoded address or an unusual terminal code can put a letter
  // or digit right before a real one, while ordinary names such as uses_provider_credentials or
  // break_glass_recovery_procedure carry ak_ or ses_ mid-word and must stay as they are.
  // A 32-byte session has only four bits in its last character, and may have text glued to both ends.
  return t.replace(KEY_SHAPES, '[hidden]');
}
/**
 * On a terminal, while a reply runs and nothing of it has printed, one stderr line says the agent
 * is working and for how long: today's brain sends no events until the reply is done, and a screen
 * that shows nothing for a minute looks stuck. It holds only a count of seconds, never a value.
 */
let working                                                                                                                  = null;

/**
 * A session at a terminal whose stdout is a terminal too draws its turns like a chat app: Markdown,
 * a spinner, a line per step, a footer. Set by session() for its life; colour is off with NO_COLOR
 * or TERM=dumb, and then the reply's text is printed exactly as written.
 */
let look                            = null;
/** text in the colour code given, only in a session's look with colour on. */
const paint = (code        , text        ) => (look?.color ? `\x1b[${code}m${text}\x1b[0m` : text);
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** What the working line says while the agent is awake and nothing more is known; the owner's words. */
const HOPPING = 'hoppy hopping';
/** What the working line says while a message wakes an agent that was not running; the owner's words. */
const WAKING = 'waking the agent';
/** What the working line says while nothing is known of the agent's state; a session sets it per turn. */
let workingLabel = HOPPING;
/** The working line's words after s seconds: the waking line in the owner's shape, `waking the agent (12 s)`. */
const workingText = (label        , s        ) => (label === WAKING ? `${label} (${s} s)` : `${label}… ${s} s`);
/**
 * In a session, what the person has typed so far while a reply runs, for a row below the working
 * line; empty when nothing is typed. Readline's own echo is off while a reply runs, so this row is
 * the only place typing shows, and the spinner above it keeps going.
 */
let pendingInput                        = null;

/** Clears the working line's rows (the line, and the typing row below it when drawn), leaving the cursor at the line's start. */
function clearWorkingRows() {
  if (!working?.rows) return;
  process.stderr.write(working.rows === 2 ? '\r\x1b[2K\x1b[1A\r\x1b[2K' : '\r\x1b[2K');
  working.rows = 0;
}

/** Draws the working line again at once, as when the person types; nothing when it is not on screen. */
function redrawWorking() {
  if (working?.rows) working.draw();
}

/**
 * Starts the working line, first drawn a second after since (in ms), or sooner in a session once
 * label names the agent's state; nothing without a terminal or with --json. A running line takes
 * the new label.
 */
function startWorking(since = Date.now(), label         ) {
  if (json || !process.stderr.isTTY) return;
  if (working) {
    if (label) Object.assign(working, { label, known: true });
    return;
  }
  let frame = 0;
  const w = {
    rows: 0,
    label: label ?? workingLabel,
    known: label !== undefined,
    // One write for the line and the typing row, so the terminal never shows one without the other.
    draw: () => {
      const s = Math.floor((Date.now() - since) / 1000);
      const clear = w.rows === 2 ? '\r\x1b[2K\x1b[1A\r\x1b[2K' : '\r\x1b[2K';
      const typedRow = pendingInput?.() ?? '';
      if (!look) process.stderr.write(`${clear}\x1b[2m${workingText(w.label, s)}\x1b[0m`);
      else process.stderr.write(`${clear}${paint('2', `${SPIN[frame % SPIN.length]} ${workingText(w.label, s)}`)}${typedRow ? `\n${typedRow}` : ''}`);
      w.rows = look && typedRow ? 2 : 1;
    },
    timer: setInterval(() => {
      if (look && Date.now() - since < 1000 && !w.known) return;
      frame++;
      w.draw();
    }, look ? 100 : 1000),
  };
  w.timer.unref();
  working = w;
}

/** Stops the working line and clears it from the screen, for good: the reply or its events take over. */
function stopWorking() {
  if (!working) return;
  clearInterval(working.timer);
  clearWorkingRows();
  working = null;
}

/**
 * In a session, hoppy owns the terminal while the agent's words reach it: set by session() for its life.
 * Outside one, text bound for a terminal is made plain too (see screen); piped output keeps its bytes.
 */
let scrub = false;
/**
 * text with every control code taken out but newline and tab: C0, DEL and the 8-bit C1 codes. Taking
 * each code byte out on its own, not whole sequences, also defuses a sequence split across two
 * pieces of a stream, since what is left of it is plain text.
 */
const plain = (text        ) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
/**
 * Agent or brain text as it may reach stream: plain when that stream is a terminal, where an escape
 * sequence in it could set the clipboard (OSC 52), hide a link (OSC 8) or retitle the window. Piped
 * output keeps the bytes as sent, for programs that read them.
 */
// Hidden before the codes go: a colour code right before a key is what marks where the key starts.
const screen = (stream                    , text        ) => (scrub || stream.isTTY ? plain(hide(text)) : text);
const out = (text        ) => {
  stopWorking();
  return process.stdout.write(hide(screen(process.stdout, text.endsWith('\n') ? text : `${text}\n`)));
};
/** --json output: hidden as a value, names included, then serialized once; never hidden as JSON text. */
const outJson = (value         ) => process.stdout.write(`${JSON.stringify(hiddenValue(value, hide))}\n`);
/** A line on stderr written as given: for lines that hold hoppy's own colour codes. */
const say = (text        ) => {
  // A note (a --debug call, /cancel's answer) takes the line; the working line comes back below it on its next second.
  clearWorkingRows();
  return process.stderr.write(hide(`${text}\n`));
};
/** A line on stderr; at a terminal, the agent's or brain's words in it cannot drive the terminal. */
const note = (text        ) => say(screen(process.stderr, text));
const emit = (value         , text        ) => (json ? outJson(value) : out(text));

/** The brain's address, refusing anything but https unless it is this machine. */
function brainUrl(given                    )         {
  const raw = given || process.env.HOPPY_URL || DEFAULT_URL;
  let u     ;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`${raw} is not an address; give an https address with --url or HOPPY_URL`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new UsageError(`${u.origin} is not https; hoppy sends its key only over https, or to this machine`);
  return u.origin;
}

/** Where the key file is: --key-file, else HOPPY_KEY_FILE, else hoppy/key under the config folder. */
const keyPath = (file                    ) => file || process.env.HOPPY_KEY_FILE || join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'hoppy', 'key');

/** How a key file names the brain hoppy login got its key from: a line after the key. */
const BRAIN_LINE = 'brain=';

/** The name saveSecret gives the file it writes beside path before renaming it over path. */
const tempName = (path        ) => `${path}.${randomBytes(4).toString('hex')}.tmp`;

/** How old a leftover must be before it is removed: a save in progress takes milliseconds. */
const LEFTOVER_AGE_MS = 60_000;

/**
 * Removes what an interrupted save (kill -9, a power cut) left beside the key file at path: a file
 * named as tempName names it, that this user owns and only this user can read, last written over a
 * minute ago. Such a file may hold a live key nobody tracks. The key file itself never matches the
 * name, and anything that is not plainly hoppy's own leftover (a link, a folder, a file another
 * user owns or others can read) is left alone. Never throws: a leftover that cannot be removed must
 * not stop the command.
 */
function dropInterruptedSaves(path        ) {
  const dir = dirname(path);
  const leftover = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f]{8}\\.tmp$`);
  let names          ;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!leftover.test(name)) continue;
    const temp = join(dir, name);
    try {
      const s = lstatSync(temp);
      if (!s.isFile()) continue;
      if (process.platform !== 'win32' && (s.uid !== process.getuid?.() || s.mode & 0o077)) continue;
      // A newer one may be another hoppy login's save between its write and its rename.
      if (Date.now() - s.mtimeMs < LEFTOVER_AGE_MS) continue;
      rmSync(temp);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * The key: from --key-file, else HOPPY_KEY, else the default file, which must be readable by its
 * owner only. brain is the brain hoppy login saved the key from, or null for a key from HOPPY_KEY
 * or a file holding only a key (one an owner or admin made on the Keys page). Both come from one file, written whole
 * by one rename, so a key is never paired with another key's brain.
 */
function readSaved(file                    )                                        {
  dropInterruptedSaves(keyPath(file));
  if (!file && process.env.HOPPY_KEY) return { key: process.env.HOPPY_KEY.trim(), brain: null };
  const path = keyPath(file);
  let mode        ;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new NoKeyError(`not signed in: run hoppy login, or set HOPPY_KEY, or put the key in ${path} (chmod 600)`);
  }
  // A key others on this computer can read is as good as theirs.
  if (process.platform !== 'win32' && mode & 0o077) throw new UsageError(`${path} can be read by others; run chmod 600 ${path} first`);
  let k        ;
  try {
    k = readFileSync(path, 'utf8').trim();
  } catch (e) {
    // Mode 000, a folder, or a file gone since the check: still a setup to fix, not an unreachable brain.
    throw new UsageError(`could not read the key in ${path} (${(e                         ).code ?? (e         ).message}); make it a file you own with chmod 600`);
  }
  const [first, ...rest] = k.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!first) throw new UsageError(`${path} is empty; put the key in it`);
  let brain                = null;
  for (const line of rest) {
    if (!line.startsWith(BRAIN_LINE) || line.length === BRAIN_LINE.length || brain)
      throw new UsageError(`${path} holds more than a key and the brain it came from; put only the key in it, or run hoppy login --force`);
    brain = brainUrl(line.slice(BRAIN_LINE.length));
  }
  return { key: first, brain };
}

/**
 * The key to send to the brain at url. Refuses a key hoppy login saved from another brain: that
 * brain did not give it, so it has no business seeing it.
 */
function keyFor(file                    , url        )         {
  const saved = readSaved(file);
  if (saved.brain && saved.brain !== url)
    throw new UsageError(
      `the key in ${keyPath(file)} is from ${saved.brain}, not ${url}; give --url ${saved.brain} (or set HOPPY_URL to it), or run hoppy login --force to sign in to ${url}`
    );
  return saved.key;
}

/**
 * A fetch that refuses to follow a redirect: one would resend the body (an env value, a file) to
 * wherever the brain points, past brainUrl's https check, and hoppy's brain never redirects.
 */
const noRedirects = (f              )               => (input, init) => f(input, { ...init, redirect: 'error' });

/** Every status the host's API documents. */
const API_STATUSES = new Set([200, 201, 202, 204, 302, 400, 401, 402, 403, 404, 409, 410, 411, 413, 428, 429, 499, 500, 501, 502, 503, 504, 507]);

/** A fetch that says each call and its answer on stderr; only the method, path and status, never a header. */
function debugFetch(sent         )               {
  return async (input, init) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const started = Date.now();
    try {
      const res = await fetch(input, init);
      // The brain picks the status and could use it to repeat a value hoppy sent.
      const status = String(res.status) === sent ? 'status withheld' : API_STATUSES.has(res.status) ? res.status : 'an unexpected status';
      note(`hoppy: ${init?.method ?? 'GET'} ${u.pathname}${u.search} ${status} (${Date.now() - started} ms)`);
      return res;
    } catch (e) {
      note(`hoppy: ${init?.method ?? 'GET'} ${u.pathname}${u.search} failed: ${(e         ).message}`);
      throw e;
    }
  };
}

function need(value                    , what        )         {
  if (!value) throw new UsageError(`${what} is missing`);
  return value;
}

function number(value                    , what        )                     {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${what} must be a number above 0, not ${value}`);
  return n;
}

/** A path on the agent: one that is not absolute is under /data. */
const onAgent = (path        ) => (path.startsWith('/') ? path : `/data/${path}`);

/** Everything on stdin, as bytes. */
async function readStdin()                  {
  const chunks           = [];
  for await (const c of process.stdin) chunks.push(c          );
  return Buffer.concat(chunks);
}

/**
 * A value typed at the terminal with nothing shown, ended by Enter; Ctrl-C exits 130. Used when
 * stdin is a terminal, so a person can type a secret without it appearing on screen. A pasted value
 * may have several lines (a PEM key): the terminal marks a paste, so its line breaks stay in the
 * value. Text after Enter that is not in a marked paste is refused, as it would otherwise be cut off
 * the value and left for the shell to show and run.
 */
function readUnseen(prompt        )                  {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const restore = () => {
      if (stdin.isRaw) stdin.setRawMode(false);
      if (process.stderr.isTTY) process.stderr.write('\x1b[?2004l');
    };
    // A person may type as soon as the prompt shows, so echo goes off before it is written, and
    // whatever ends the read (Enter, Ctrl-C, an error, an exit) turns it back on.
    process.once('exit', restore);
    const done = () => {
      restore();
      process.off('exit', restore);
      stdin.off('data', onData);
      stdin.off('error', onError);
      stdin.pause();
      process.stderr.write('\n');
    };
    const PASTE_START = '\x1b[200~';
    const PASTE_END = '\x1b[201~';
    let pasting = false;
    let afterCR = false;
    let partialMarker = '';
    const onData = (chunk        ) => {
      chunk = partialMarker + chunk;
      partialMarker = '';
      for (let i = 0; i < chunk.length; ) {
        if (chunk.startsWith(PASTE_START, i) || chunk.startsWith(PASTE_END, i)) {
          pasting = chunk.startsWith(PASTE_START, i);
          i += PASTE_START.length;
          continue;
        }
        if (chunk[i] === '\x1b') {
          const tail = chunk.slice(i);
          if (PASTE_START.startsWith(tail) || PASTE_END.startsWith(tail)) {
            partialMarker = tail;
            return;
          }
        }
        const ch = String.fromCodePoint(chunk.codePointAt(i) );
        i += ch.length;
        if (ch === '\u0003') {
          done();
          return finish(130);
        }
        if (pasting && (ch === '\r' || ch === '\n')) {
          // A terminal sends a pasted line break as \r, \n or \r\n; each is one break.
          if (!(ch === '\n' && afterCR)) value += '\n';
          afterCR = ch === '\r';
          continue;
        }
        afterCR = false;
        if (ch === '\r' || ch === '\n') {
          done();
          if (chunk.slice(i).replace(/^\n/, '') !== '') return reject(new UsageError('more was typed after Enter, so nothing was sent; to set a value of several lines, paste it in one go, or pipe it on stdin'));
          return resolve(value);
        }
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    const onError = (e       ) => {
      done();
      reject(e);
    };
    let value = '';
    try {
      stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.on('error', onError);
      // Bracketed paste: the terminal wraps a paste in markers, so a pasted line break is not Enter.
      process.stderr.write(`${process.stderr.isTTY ? '\x1b[?2004h' : ''}${prompt}`);
    } catch (e) {
      onError(e         );
    }
  });
}

const agentLine = (a       ) => `${a.id}  ${a.state}  ${a.harness?.id ?? a.image}  ${a.name}`;

/** The chat and attach shape: where the message stands, and whether hoppy stopped waiting for it. */
const messageShape = (agentId        , m               , detached         ) => ({
  agentId,
  messageId: m.messageId,
  status: m.status,
  response: m.response ?? null,
  error: m.error ?? null,
  reason: m.reason ?? null,
  files: m.files ?? [],
  detached,
});

/** The message hoppy is waiting for, from the moment it makes the id, so Ctrl-C can always name it. */
let waiting                                                                                                 = null;
let left = false;

/** Stops waiting and says how to pick the message back up; the brain is told nothing, so it runs on. */
function leave(why        , code        )         {
  left = true;
  const { agentId, latest, cursor, settle } = waiting ;
  // A word held back stays unprinted: it may be the start of a key whose rest has not come. The
  // cursor names the last event shown in full, so attach --after shows the held word with its rest.
  settle?.();
  if (json) outJson(messageShape(agentId, latest, true));
  note(`${why}. Pick it back up with: hoppy attach ${agentId} ${latest.messageId}${cursor ? ` --after ${cursor}` : ''}`);
  return code;
}

/** Ctrl-C detaches with 130 from here on; output on its way when it comes is dropped, so the detach is all that prints. */
function detachOnCtrlC(sent               ) {
  process.on('SIGINT', () => left || finish(leave(sent() ? 'detached; the message keeps running' : 'detached before the brain answered; if the message reached it, it keeps running', 130)));
}

/** Never settles: what Ctrl-C started (printing, then exiting) is the end of the run. */
const never = () => new Promise        (() => {});

/** The Retry-After seconds of the brain's last answer to the client (0 when it gave none), so a check in an outage waits as long as the brain asks. */
let retryAfter = 0;

/** A fetch that notes each answer's Retry-After in retryAfter. */
function notingRetryAfter(f              )               {
  return async (input, init) => {
    const res = await f(input, init);
    const s = Number(res.headers.get('retry-after'));
    retryAfter = Number.isFinite(s) && s > 0 ? Math.min(s, 60) : 0;
    return res;
  };
}

/** Whether a failed record read is the brain or the way to it being down for a while: a 5xx, a 429, a lost connection or a call that ran out of time. */
const passing = (e         ) => (e instanceof AgentHostError ? e.status >= 500 || e.status === 429 : true);

/**
 * Waits for a message by checking it, until it is done or failed, Ctrl-C detaches, or timeout
 * seconds pass. Returns the exit code. Detaching sends nothing to the brain, so the message runs on.
 * show prints the finished message without --json; left out, the reply is printed as it stands.
 * outage is true when the check took over from a stream that went down: a read that meets the same
 * outage is checked again (after Retry-After when the brain gives one) rather than ending the run.
 * cut, once aborted, ends this wait alone with nothing more printed, as a session's Ctrl-C does.
 */
async function wait(host           , agentId        , first               , timeout                    , show                                  , outage = false, cut              )                  {
  const pollMs = Number(process.env.HOPPY_POLL_MS) || 2000;
  const gone = () => left || !!cut?.aborted;
  if (!waiting) detachOnCtrlC(() => true);
  // A watch that handed over to this one keeps its cursor and settle, so Ctrl-C still names where it
  // stopped and attach --after does not show its text again.
  waiting = waiting?.latest.messageId === first.messageId ? { ...waiting, agentId, latest: first } : { agentId, latest: first };
  const stillRunning = () => leave(`still running after ${timeout} s; the message keeps running`, 3);
  const deadline = Date.now() + (timeout ?? Infinity) * 1000;
  let pauseMs = pollMs;
  while (waiting.latest.status === 'running') {
    if (Date.now() >= deadline) return stillRunning();
    await new Promise      ((r) => {
      const t = setTimeout(done, Math.min(pauseMs, Math.max(0, deadline - Date.now())));
      cut?.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(t);
        cut?.removeEventListener('abort', done);
        r();
      }
    });
    if (gone()) return never();
    if (Date.now() >= deadline) return stillRunning();
    let down = false;
    const next = await host.agents.message(agentId, first.messageId).catch((e) => {
      if (gone()) return null;
      // The stream was given up for an outage, and a restart of the service outlasts the client's
      // own few retries: only --timeout ends a wait for a brain that is coming back.
      if (outage && passing(e)) {
        down = true;
        return null;
      }
      return Promise.reject(e);
    });
    if (gone()) return never();
    pauseMs = down && retryAfter ? Math.max(pollMs, retryAfter * 1000) : pollMs;
    if (next) waiting.latest = next;
  }
  const latest = waiting.latest;
  if (!json) (show ?? ((m) => out(m.response ?? '')))(latest);
  return report(agentId, latest);
}

/** The end of a wait: the message shape with --json, the reason when it failed, and the exit code. */
function report(agentId        , latest               )         {
  if (json) outJson(messageShape(agentId, latest, false));
  if (latest.status === 'failed') {
    note(`the message failed: ${latest.error ?? latest.reason ?? 'no reason given'}`);
    return 1;
  }
  return 0;
}

const dim = (text        ) => `\x1b[2m${text}\x1b[0m`;
const SPINNER = ['|', '/', '-', '\\'];

/**
 * Prints one message's live events for a person: the reply's text on stdout as it is written, and
 * on stderr a line per tool step, the agent's state and any notice. Text is held until a space
 * ends the word it is in, so a key is never split across two writes and hide() always sees it whole.
 */
class Printer {
  /** The reply text accounted for so far: printed, plus held. */
  #shown = '';
  /** The text held back, as each event added it, with that event's cursor. */
  #held                                            = [];
  /** The cursor of the last event whose text is all printed. */
  #cursor               ;
  #printed = false;
  /** stdout's last byte is not a newline. */
  #stdoutMid = false;
  /** The cursor is partway along a line of text on a terminal that shows stdout and stderr together. */
  #screenMid = false;
  #tty = !!process.stderr.isTTY;
  #sameScreen = !!process.stderr.isTTY && !!process.stdout.isTTY;
  #state                = null;
  #spin                                            ;
  #spinLine = '';
  /** The tool whose start line is the last thing on the screen, so its end can replace it. */
  #lastTool                = null;
           #thinking         ;
  /** Started after a cursor: what came before it was shown by an earlier watch. */
           #resumed         ;
  /** In a session's look with colour: draws the reply's Markdown. */
           #md                  = look?.color ? new Markdown(process.stdout.columns || 80, hide) : null;
  /** When the watch started, for the working line's seconds. */
           #since        ;
  /** What the working line says in a session's look: the agent's state or the step it runs. */
  #label                    ;
  /** The reply is being finished: the working line is not started again. */
  #ended = false;

  constructor(thinking         , after                    , since = Date.now()) {
    this.#thinking = thinking;
    this.#resumed = after !== undefined;
    this.#cursor = after ?? null;
    this.#since = since;
  }

  get cursor()                {
    return this.#cursor;
  }

  /** Whether any of the reply, or a line about it, has been shown. */
  get shownAny()          {
    return this.#printed || this.#state !== null || this.#lastTool !== null;
  }

  #clearSpin() {
    stopWorking();
    if (this.#spin) clearInterval(this.#spin);
    if (this.#spinLine) process.stderr.write('\r\x1b[2K');
    this.#spin = undefined;
    this.#spinLine = '';
  }

  #text(chunk        ) {
    if (!chunk) return;
    // Hidden before the renderer sees it, so the renderer never holds or joins a key.
    const shown = hide(screen(process.stdout, chunk));
    this.#write(this.#md ? this.#md.push(shown) : shown);
  }

  #write(s        ) {
    if (!s) return;
    this.#clearSpin();
    process.stdout.write(hide(s));
    this.#printed = true;
    this.#stdoutMid = !s.endsWith('\n');
    this.#screenMid = this.#sameScreen && this.#stdoutMid;
    this.#lastTool = null;
    this.#resume();
  }

  /** Shows what the renderer still holds, such as an open code block, before a line that breaks the reply. */
  #flushMd() {
    if (this.#md) this.#write(this.#md.end());
  }

  /** In a session's look the spinner comes back below each line, until the reply ends. */
  #resume() {
    if (look && !this.#ended && !this.#screenMid) startWorking(this.#since, this.#label);
  }

  /** A line on stderr: dim on a terminal, or in the colour given in a session's look. */
  #line(text        , colour = '2') {
    this.#clearSpin();
    if (this.#screenMid) process.stderr.write('\n');
    this.#md?.newLine();
    this.#screenMid = false;
    const t = screen(process.stderr, text);
    say(look ? paint(colour, t) : this.#tty ? dim(t) : t);
    this.#resume();
  }

  /** Prints the held text that is safe to print, or all of it at the end of a part of the reply. */
  #release(all         , cursor                ) {
    const n = safePieces(this.#held.map((h) => h.text), all);
    if (n) {
      this.#text(this.#held.slice(0, n).map((h) => h.text).join(''));
      this.#cursor = this.#held[n - 1].cursor;
      this.#held = this.#held.slice(n);
    }
    // A part of the reply ended: its last word is whole, so the renderer need not wait for a space.
    if (all && this.#md) this.#write(this.#md.flush());
    if (!this.#held.length && cursor !== undefined) this.#cursor = cursor;
  }

  /** Leaves the screen on a new line for a note that follows, without printing held text or changing stdout. */
  settle() {
    this.#ended = true;
    this.#clearSpin();
    if (this.#screenMid) process.stderr.write('\n');
    this.#md?.newLine();
    this.#screenMid = false;
  }

  #status(state        ) {
    if (state === this.#state) return;
    this.#state = state;
    if (!this.#tty) return this.#line(`  [${state}]`);
    if (look) {
      this.#label = HOPPING;
      return this.#resume();
    }
    // A spinner draws over its own line; on a line of reply text it would wipe the text.
    if (this.#screenMid) return;
    this.#clearSpin();
    let frame = 0;
    const draw = () => process.stderr.write(`\r\x1b[2K${dim(`${SPINNER[frame++ % SPINNER.length]} ${state}`)}`);
    this.#spinLine = state;
    draw();
    this.#spin = setInterval(draw, 120);
    this.#spin.unref();
  }

  /** Shows one event; cursor is the reader's cursor once the event is read. */
  event(e            , turn      , cursor               ) {
    const item = (e.item ?? {})                           ;
    // Today's brain sends accepted at once, while the agent may still be waking; an agent event means it is up.
    if (e.v === 1 && typeof e.kind === 'string' && workingLabel !== HOPPING) {
      workingLabel = HOPPING;
      if (working && !working.known) working.label = HOPPING;
    }
    if (startsOver(e)) {
      // A held word of the old attempt is dropped, never printed: the new attempt may not write it.
      this.#held = [];
      this.#shown = '';
      this.#cursor = cursor;
      this.#state = null;
      this.#flushMd();
      if (this.#stdoutMid) this.#text('\n');
      this.#line(`  the agent restarted the reply${typeof e.attempt === 'number' ? ` (attempt ${e.attempt})` : ''}`);
      return;
    }
    const text = turn.text;
    let added = '';
    if (text !== this.#shown) {
      if (text.startsWith(this.#shown)) added = text.slice(this.#shown.length);
      else {
        // A snapshot that does not carry on from what was shown: say so, then show it whole.
        this.#release(true);
        this.#flushMd();
        if (this.#stdoutMid) this.#text('\n');
        this.#line('  the reply so far:');
        added = text;
      }
      this.#shown = text;
    }
    this.#held.push({ text: added, cursor });
    this.#release(!keepsWord(e), cursor);
    const tool = (id         ) => turn.items.find((i) => i.type === 'tool_call' && i.id === id)                                                                                    ;
    switch (e.kind) {
      case 'agent.status':
        if (typeof e.state === 'string') this.#status(e.state);
        break;
      case 'response.reasoning_text.done': {
        if (!this.#thinking) break;
        const part = turn.items.find((i) => i.type === 'reasoning' && i.id === e.item_id)                                ;
        if (part?.text) this.#line(`  thinking: ${part.text}`);
        break;
      }
      case 'response.output_item.added': {
        const t = tool(item.id);
        if (look) this.#label = `running ${t?.title || t?.name || 'a tool'}`;
        this.#line(look ? `⏺ ${t?.title || t?.name || 'tool'}` : `  > ${t?.title || t?.name || 'tool'}`);
        this.#lastTool = String(item.id);
        break;
      }
      case 'response.output_item.done': {
        const t = tool(item.id);
        if (look) {
          this.#label = undefined;
          // The spinner sits below the step's start line: cleared first, so going up a line lands on the start line.
          this.#clearSpin();
          if (this.#tty && this.#lastTool === String(item.id)) process.stderr.write('\x1b[1A\r\x1b[2K');
          this.#lastTool = null;
          const failed = /fail|error/i.test(t?.status ?? '');
          const how = t?.status && !['completed', 'done'].includes(t.status) ? `: ${t.status}` : '';
          const verb = VERBS[(t                                 )?.kind ?? ''];
          this.#line(`⏺ ${verb ? `${verb}: ` : ''}${t?.title || t?.name || 'tool'}${how}${typeof t?.seconds === 'number' ? ` (${t.seconds} s)` : ''}`, failed ? '31' : '2');
          break;
        }
        const label = `  ${t?.title || t?.name || 'tool'}: ${t?.status ?? 'done'}${typeof t?.seconds === 'number' ? ` (${t.seconds} s)` : ''}`;
        // On a terminal the step's own start line is replaced, so each step stays one line.
        if (this.#tty && this.#lastTool === String(item.id)) process.stderr.write('\x1b[1A\r\x1b[2K');
        this.#line(label);
        this.#lastTool = null;
        break;
      }
      case 'agent.notice':
        this.#line(`  note: ${e.text ?? e.code}`);
        break;
      case 'agent.file':
        this.#line(`  file: ${e.name} (${e.size} bytes)`);
        break;
      case 'agent.plan':
        if (turn.plan) this.#line(`  plan: ${turn.plan.filter((p) => p.status === 'completed').length} of ${turn.plan.length} done`);
        break;
    }
  }

  /**
   * The end: the record's reply is the truth, so whatever of it the live text has not shown is
   * printed now. When the two differ, the record is printed in full after a note saying so.
   * checked is true when the stream went away and the record was checked instead, so the stream's
   * end never came and the record may go on past the text this run showed.
   */
  finish(response               , checked = false) {
    this.#ended = true;
    const held = this.#held.map((h) => h.text).join('');
    const printed = this.#shown.slice(0, this.#shown.length - held.length);
    this.#held = [];
    this.#clearSpin();
    if (response === null) this.#text(held);
    else {
      // Where the rest of the reply starts in the record, or -1 when the record must be printed whole.
      let from = -1;
      if (!this.#resumed) from = response.startsWith(this.#shown) ? printed.length : -1;
      else if (!checked) from = response.endsWith(this.#shown) ? response.length - held.length : -1;
      else {
        // An earlier watch showed the reply up to the cursor, and the record does not say where that
        // is: only this run's text, found once, places it.
        const at = this.#shown ? response.indexOf(this.#shown) : -1;
        if (at >= 0 && at === response.lastIndexOf(this.#shown)) from = at + printed.length;
      }
      if (from >= 0) {
        // The held word and the rest in one write: hide() checks each write alone, so a key the
        // stream cut in half and the record finished must reach it whole.
        this.#text(response.slice(from));
      } else {
        // The held word is dropped, not printed: the reply in full follows and holds it.
        this.#flushMd();
        if (this.#stdoutMid) this.#text('\n');
        this.#line(this.#shown ? '  the stored reply differs from the live text; here it is in full:' : '  the live text did not come; here is the whole reply:');
        this.#text(response);
      }
    }
    this.#flushMd();
    if (this.#stdoutMid || (!this.#printed && response !== null)) process.stdout.write('\n');
    this.#stdoutMid = this.#screenMid = false;
  }

  close() {
    this.#ended = true;
    this.#clearSpin();
  }
}

/** A step's kind (Agent Client Protocol tool kinds) as the verb on its line in a session. */
const VERBS                         = { execute: 'ran', read: 'read', edit: 'edited', delete: 'deleted', move: 'moved', search: 'searched', fetch: 'fetched' };

/** The harness's own token count for the footer, or null when its usage names none. */
function tokensOf(usage                                )                {
  if (!usage) return null;
  const n = (...names          ) => names.map((k) => usage[k]).find((v)              => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const total = n('total_tokens', 'totalTokens');
  if (total !== undefined) return total;
  const input = n('input_tokens', 'inputTokens', 'prompt_tokens');
  const output = n('output_tokens', 'outputTokens', 'completion_tokens');
  return input === undefined && output === undefined ? null : (input ?? 0) + (output ?? 0);
}

/** The usage the last watched reply's events carried, for a session's footer. */
let lastUsage                                 = null;

/**
 * Prints --json's agent events, holding an event whose text could be the start of a key until the
 * key's word ends, as the Printer does, so the events printed so far end at a whole word. A key
 * split across events is hidden as a whole: its group's text is hidden in one piece and carried by
 * the group's first event, the others' text left empty, so the deltas still add up to the reply.
 */
class JsonEvents {
  #held               = [];
  /** The cursor of the last event printed. */
  cursor               ;

  constructor(after                    ) {
    this.cursor = after ?? null;
  }

  event(e            ) {
    // Only agent events v1 are printed as events; today's brain also sends accepted and done, which carry nothing to show.
    if (e.v !== 1 || typeof e.kind !== 'string') return;
    // The old attempt's held events are dropped, so --json never gives text the answer will not hold.
    if (startsOver(e)) this.#held = [];
    this.#held.push(e);
    this.#release(!keepsWord(e));
  }

  /** Prints every held event: at the end of the stream, a held word has nothing more to wait for. */
  end() {
    this.#release(true);
  }

  #release(all         ) {
    const { shown, held } = releaseEvents(this.#held, all, hide);
    this.#held = held;
    for (const g of shown) {
      outJson(g);
      if (g.id) this.cursor = g.id;
    }
  }
}

/** cut, once aborted, stops this watch alone: its reader is aborted and nothing more of it is printed. */
                                                                                                                                                                                    

/**
 * Watches a message through its live events (GET .../chat/{messageId}/events, read by the shared
 * reader in typescript/src/stream.ts) until it is done or failed, Ctrl-C detaches, or timeout
 * seconds pass. A cut redials from the last event shown. A brain that does not serve the route to
 * this caller, or one whose route stays down for OUTAGE_DIALS dials, is checked by message instead.
 * Returns the exit code; detaching sends the brain nothing.
 */
async function live(w       )                  {
  const { agentId, first } = w;
  if (!waiting) detachOnCtrlC(() => true);
  const stop = new AbortController();
  w.cut?.addEventListener('abort', () => stop.abort(), { once: true });
  const gone = () => left || !!w.cut?.aborted;
  const startedAt = Date.now();
  const route = watchEventsRoute(w.fetcher ?? globalThis.fetch.bind(globalThis), () => stop.abort());
  const printer = new Printer(w.thinking, w.after, startedAt);
  const events = new JsonEvents(w.after);
  const reader = new LiveReader({
    baseUrl: w.url,
    agentId,
    messageId: first.messageId,
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': `hoppy/${VERSION}` },
    fetch: route.fetch,
    signal: stop.signal,
    ...(w.after ? { after: w.after } : {}),
  });
  waiting = { agentId, latest: first, cursor: w.after ?? null, settle: () => (json ? undefined : printer.settle()) };
  if (!json) startWorking(startedAt);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, w.timeout * 1000);
  try {
    for await (const e of reader) {
      if (gone()) return never();
      if (json) events.event(e);
      else printer.event(e, reader.turn, reader.cursor);
      waiting.cursor = json ? events.cursor : printer.cursor;
    }
    if (json) events.end();
    lastUsage = reader.turn.usage;
    const record = await reader.final();
    if (gone()) return never();
    const latest                = { messageId: first.messageId, status: record.status, response: record.response ?? null, error: record.error ?? null, reason: record.reason ?? null, files: (record.files ?? [])                           };
    waiting.latest = latest;
    if (!json) printer.finish(latest.status === 'done' ? (latest.response ?? '') : null);
    return report(agentId, latest);
  } catch (e) {
    if (gone()) return never();
    if (route.notServed()) {
      const quiet = !printer.shownAny;
      printer.close();
      // Checking the record shows nothing until the reply is done, so the working line carries on.
      if (quiet && !json) startWorking(startedAt);
      if (json) {
        events.end();
        waiting .cursor = events.cursor;
      }
      const rest = Math.max(0, w.timeout - (Date.now() - startedAt) / 1000);
      // Through the printer, so text a stream showed before it went away is not printed twice.
      return wait(w.host, agentId, waiting?.latest ?? first, rest, (m) => printer.finish(m.status === 'done' ? (m.response ?? '') : null, true), route.wentDown(), w.cut);
    }
    if (timedOut) return leave(`still running after ${w.timeout} s; the message keeps running`, 3);
    if (e instanceof StreamError) throw new AgentHostError(e.status, e.code, e.message);
    throw e;
  } finally {
    clearTimeout(timer);
    printer.close();
  }
}

/** A message hoppy has made the id of and not heard about yet. */
const runningMessage = (messageId        )                => ({ messageId, status: 'running', response: null, error: null, reason: null, files: [] });

/** Sends one message with the id hoppy made, in conversationId when given, and returns where it stands. */
async function sendMessage(host           , agentId        , message        , messageId        , conversationId                    )                         {
  try {
    return await host.agents.send(agentId, message, { messageId, ...(conversationId ? { conversationId } : {}) });
  } catch (e) {
    // The SDK resends a lost answer with the same id; the brain then says that message is already running, which is a start.
    if (!(e instanceof AgentHostError && e.status === 409 && e.code === 'message_in_progress')) throw e;
    return runningMessage(messageId);
  }
}

/** How many conversations /resume offers: the newest, as a short list a person picks from by number. */
const RESUME_LIMIT = 10;

/** One /resume line: number, when it was last used (UTC), how many messages, its first words. */
function resumeLine(c              , i        , width        , current        )         {
  const at = new Date(c.lastAt);
  const when = Number.isNaN(at.getTime()) ? 'unknown time' : `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  // The title is the brain's (the first message's words): one line, clipped, so the list stays a list.
  // Hidden before the clip: a cut through a key glued to other text leaves a piece no rule knows.
  const words = hide(plain(String(c.title ?? ''))).replace(/\s+/g, ' ').trim();
  const title = words.length > 60 ? `${words.slice(0, 59)}…` : words || '(no words)';
  // The count is the brain's JSON, unchecked: anything but a whole number shows as ?, so text in it can never draw a row.
  const n          = c.messages;
  const count = Number.isSafeInteger(n) && (n          ) >= 0 ? (n          ) : '?';
  return `${String(i + 1).padStart(width)}  ${when}  ${count} message${count === 1 ? '' : 's'}  ${title}${c.id === current ? ' (this one)' : ''}`;
}

const SESSION_HELP = 'type a message and press Enter; /new starts a new conversation, /resume picks an earlier one, /status says where things stand, /cancel stops the running reply, /exit (or Ctrl-D) leaves; Ctrl-C stops watching a reply and leaves it running';

/**
 * hoppy chat <agent> with no message, at a terminal: a session that sends each line typed in one
 * conversation and watches each reply as chat does. Returns 0 when the person leaves.
 */
async function session(host           , agentId        , given                    , watch                                                                                               )                  {
  const agent = await host.agents.get(agentId);
  // The brain takes a caller's conversation id, so one made here holds every turn together.
  let conversationId = given || randomUUID();
  /**
   * The reply being watched: cut stops the watch, ended settles the turn at once. cancel is a
   * /cancel typed before the brain answered the send: the brain has no such message until then.
   */
                                                                                                             
  let current              = null;
  /** The last turn sent, whose send may still be on its way after Ctrl-C. */
  let lastTurn              = null;
  const lines                    = [];
  let wake                      = null;
  const { createInterface } = await import('node:readline');
  const pretty = !!process.stdout.isTTY;
  scrub = true;
  // NO_COLOR counts when set to anything but empty (no-color.org).
  look = pretty ? { color: !process.env.NO_COLOR && process.env.TERM !== 'dumb' } : null;
  // An agent that is not running is woken by the message; until it answers, the line says so.
  let asleep = agent.state !== 'running';
  // While a reply runs readline's echo is off: what it would draw lands on the working line's row.
  // The person's typing shows instead in the row below the working line (pendingInput).
  const stdout = process.stdout;
  const output = new Proxy(stdout, {
    get(target, name) {
      if (name === 'write') return (chunk        , ...rest           ) => (current ? true : (target.write                                           )(chunk, ...rest));
      const v = Reflect.get(target, name, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  // historySize keeps the lines typed, so Up and Down bring them back as in a shell.
  const youPrompt = pretty ? `${paint('1;36', 'you ›')} ` : 'you> ';
  const rl = createInterface({ input: process.stdin, output, prompt: youPrompt, terminal: true, historySize: 200 });
  /** True while /resume waits for a number: Esc and Ctrl-C then cancel the pick. */
  let picking = false;
  const dropPick = () => {
    rl.write(null, { ctrl: true, name: 'e' });
    rl.write(null, { ctrl: true, name: 'u' });
    process.stdout.write('\n');
    // An empty pick is the one way a pick is cancelled, so Esc and Ctrl-C take the same path.
    take('');
  };
  const take = (line               ) => {
    lines.push(line);
    wake?.();
  };
  const cancelTurn = (t      ) => {
    if (t.sent) return cancel(t.messageId);
    t.cancel = true;
    note(`cancelling ${t.messageId} once the brain has it`);
  };
  const cancel = async (messageId        ) => {
    try {
      await host.agents.cancel(agentId, messageId);
      note(`cancelling ${messageId}`);
    } catch (e) {
      fail(e);
    }
  };
  rl.on('line', (line) => {
    if (!current) return take(line);
    // /cancel is the one line that cannot wait for the reply it is meant to stop.
    if (line.trim() === '/cancel') return void cancelTurn(current);
    // Anything else typed while a reply runs is never sent by itself: it stays typed, and only
    // Enter at the prompt after the reply sends it, so a stray key never becomes a message.
    Object.assign(rl, { line, cursor: line.length });
    redrawWorking();
  });
  rl.on('close', () => take(null));
  const ctrlC = () => {
    if (picking && !current) return dropPick();
    if (current) {
      const { messageId, sent, cut, ended } = current;
      current = null;
      waiting?.settle?.();
      const cursor = waiting?.latest.messageId === messageId ? waiting.cursor : null;
      cut.abort();
      note(`${sent ? '' : 'stopped before the brain answered; if the message reached it, it is '}still running: hoppy attach ${agentId} ${messageId}${cursor ? ` --after ${cursor}` : ''}`);
      ended();
      return;
    }
    if (rl.line) {
      // As a shell does: Ctrl-C drops the line being typed.
      rl.write(null, { ctrl: true, name: 'e' });
      rl.write(null, { ctrl: true, name: 'u' });
    } else {
      process.stdout.write('\n');
      note('to leave, type /exit or press Ctrl-D');
    }
    rl.prompt();
  };
  rl.on('SIGINT', ctrlC);
  // Added after readline's own listener, so rl.line already holds the key.
  const typing = (_s                    , key                               ) => {
    if (picking && key?.name === 'escape') return dropPick();
    if (current) redrawWorking();
  };
  process.stdin.on('keypress', typing);
  const typedRowWidth = () => Math.max(10, (process.stderr.columns || 80) - 3);
  pendingInput = () => (current && rl.line ? `${paint('1;36', '›')} ${rl.line.slice(-typedRowWidth())}` : '');
  // Once readline has let the terminal go (after Ctrl-D), Ctrl-C comes as a signal instead.
  process.on('SIGINT', ctrlC);

  const turn = async (message        ) => {
    const messageId = randomUUID();
    const cut = new AbortController();
    let ended             ;
    const stopped = new Promise      ((r) => (ended = r));
    current = { messageId, sent: false, cancel: false, cut, ended };
    const mine = current;
    lastTurn = mine;
    // A watch that timed out set left for the one-shot command; each turn starts afresh.
    left = false;
    waiting = { agentId, latest: runningMessage(messageId) };
    lastUsage = null;
    workingLabel = asleep ? WAKING : HOPPING;
    const startedAt = Date.now();
    if (pretty) process.stdout.write(hide(`\n${paint('2', plain(agent.name || agent.id))}\n`));
    let code                    ;
    const run = (async () => {
      const started = await sendMessage(host, agentId, message, messageId, conversationId);
      mine.sent = true;
      // Kept through a Ctrl-C too: the person asked for the cancel, and only now can the brain act on it.
      if (mine.cancel) await cancel(messageId);
      if (cut.signal.aborted) return;
      code = await watch(agentId, started, undefined, cut.signal);
    })().catch((e) => {
      if (!cut.signal.aborted) fail(e);
    });
    await Promise.race([run, stopped]);
    if (current === mine) current = null;
    if (code === 0) asleep = false;
    if (!pretty) return;
    if (code === 0 && !cut.signal.aborted) {
      const tokens = tokensOf(lastUsage);
      process.stdout.write(hide(`${paint('2', `done in ${Math.round((Date.now() - startedAt) / 1000)} s${tokens === null ? '' : ` · ${tokens.toLocaleString('en-US')} tokens`}`)}\n`));
    }
    process.stdout.write('\n');
  };

  const nextLine = async () => {
    if (!lines.length) {
      // true keeps the cursor where it was: after a reply, text typed during it is still being typed.
      rl.prompt(true);
      await new Promise      ((r) => (wake = r));
      wake = null;
    }
    return lines.shift() ;
  };
  /** /resume: lists the newest conversations and makes the one picked by number this session's. */
  const resume = async () => {
    let got         ;
    try {
      got = await host.conversations.list(agentId, RESUME_LIMIT);
    } catch (e) {
      fail(e);
      return;
    }
    const stay = `still in conversation ${conversationId}`;
    // The list is the brain's JSON, unchecked: a shape hoppy cannot draw is a note, not the end of the session.
    const unreadable = () => note(`the brain sent a list hoppy cannot read; ${stay}`);
    if (!Array.isArray(got) || got.some((c) => typeof c !== 'object' || c === null)) return unreadable();
    const list = (got                  ).slice(0, RESUME_LIMIT);
    if (!list.length) return void note(`no earlier conversations; ${stay}`);
    const width = String(list.length).length;
    let rows        ;
    try {
      rows = list.map((c, i) => resumeLine(c, i, width, conversationId)).join('\n');
    } catch {
      return unreadable();
    }
    note(rows);
    picking = true;
    rl.setPrompt(pretty ? `${paint('1;36', 'pick ›')} ` : 'pick> ');
    const line = await nextLine();
    rl.setPrompt(youPrompt);
    picking = false;
    // Ctrl-D at the pick: the session ends as it would at the prompt.
    if (line === null) return void lines.unshift(null);
    const pick = line.trim();
    if (!pick) return void note(stay);
    const chosen = /^\d{1,3}$/.test(pick) ? list[Number(pick) - 1] : undefined;
    if (!chosen) return void note(`${pick.slice(0, 20)} is not on the list; ${stay}`);
    // The id is printed in notes and /status; a space, line or paragraph separator, or control or format character could draw a forged line there. Any other text is a real id the brain accepts.
    if (typeof chosen.id !== 'string' || !/^[^\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]+$/u.test(chosen.id)) return void note(`that conversation has an id hoppy cannot use; ${stay}`);
    conversationId = chosen.id;
    note(`now in conversation ${conversationId}`);
  };

  note(`talking to ${agent.id} (${agent.state}) in conversation ${conversationId}; ${SESSION_HELP}`);
  for (;;) {
    const line = await nextLine();
    if (line === null) {
      // Ctrl-D leaves the cursor after the prompt; the shell's own prompt starts a fresh line.
      process.stdout.write('\n');
      break;
    }
    const text = line.trim();
    if (!text) continue;
    if (text === '/exit') break;
    if (text === '/help') note(SESSION_HELP);
    else if (text === '/new') {
      conversationId = randomUUID();
      note(`new conversation ${conversationId}`);
    } else if (text === '/resume') await resume();
    else if (text === '/status') {
      try {
        const a = await host.agents.get(agentId);
        asleep = a.state !== 'running';
        const m = lastTurn ? await host.agents.message(agentId, lastTurn.messageId) : null;
        note(`agent ${a.id}: ${a.state}\nconversation ${conversationId}\nlast message: ${m ? `${m.messageId} ${m.status === 'failed' ? `failed: ${m.error ?? m.reason ?? 'no reason given'}` : m.status}` : 'none yet'}`);
      } catch (e) {
        fail(e);
      }
    } else if (text === '/cancel') {
      if (lastTurn) await cancelTurn(lastTurn);
      else note('nothing to cancel: no message sent yet');
    } else if (text.startsWith('/')) note(`${text.split(/\s/)[0]} is not a session command; ${SESSION_HELP}`);
    else await turn(text);
  }
  process.off('SIGINT', ctrlC);
  process.stdin.off('keypress', typing);
  rl.close();
  look = null;
  scrub = false;
  pendingInput = null;
  workingLabel = HOPPING;
  return 0;
}

async function main(argv          )                  {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    json = argv.includes('--json');
    throw new UsageError((e         ).message);
  }
  const { values: o, positionals } = parsed;
  json = !!o.json;
  const [command, a1, ...rest] = positionals;
  if (command !== 'mcp') { const reminder = unfinishedFleets(taskDir()); if (reminder) note(reminder); }
  if (command === 'help' || o.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const commands = ['login', 'logout', 'whoami', 'list', 'create', 'chat', 'attach', 'status', 'cancel', 'logs', 'sleep', 'wake', 'restart', 'usage', 'delete', 'files', 'env', 'steps', 'conversations', 'task', 'fleet', 'pool', 'mcp'];
  if (!command) throw new UsageError('a command is missing');
  if (!commands.includes(command)) throw new UsageError(`${command} is not a hoppy command`);
  const SUBCOMMANDS                           = { files: ['ls', 'put', 'get', 'mkdir', 'mv', 'rm'], env: ['ls', 'set', 'rm'], conversations: ['ls', 'rm'], task: ['assign', 'result', 'wait', 'pull'], fleet: ['run', 'list', 'clean'], pool: ['fill', 'list', 'drain'] };
  if (SUBCOMMANDS[command] && !SUBCOMMANDS[command].includes(a1 ?? '')) throw new UsageError(`${command} needs one of ${SUBCOMMANDS[command].join(', ')}`);
  doing = SUBCOMMANDS[command] ? `${command} ${a1}` : command;

  if (command === 'mcp') return mcp(o.url, o['key-file'], !!o.debug);

  // Checked before the key is read, so a wrong address never gets near it.
  const url = brainUrl(o.url);
  if (command === 'login') return login(url, o['key-file'], !!o.force, noRedirects(o.debug ? debugFetch() : fetch), !o['no-browser']);
  if (command === 'logout') return logout(url, o['key-file'], noRedirects(o.debug ? debugFetch() : fetch));
  const days = number(o.days, '--days');
  const timeout = number(o.timeout, '--timeout') ?? 900;
  if (o.after !== undefined && !/^.+@[0-9]+$/.test(o.after)) throw new UsageError(`--after takes the cursor hoppy printed, such as job@12, not ${o.after}`);
  key = keyFor(o['key-file'], url);
  const fetcher = o.debug ? debugFetch() : undefined;
  const makeHost = (sent         ) => new AgentHost({ url, apiKey: key, fetch: noRedirects(o.debug ? debugFetch(sent) : fetch) });
  // An agent may be named by its id or its exact name: hoppy chat toast as well as hoppy chat <uuid>.
  const agentOf = (given                    , by = makeHost()) => resolveAgent(by, need(given, 'the agent id'));
  if (command === 'env') return envCommand(makeHost, a1, await agentOf(rest[0]), rest.slice(1), !!o.secret, !!o.apply);
  const host = new AgentHost({ url, apiKey: key, fetch: notingRetryAfter(noRedirects(fetcher ?? globalThis.fetch.bind(globalThis))) });
  const fleets = new FleetManager(host, { dir: taskDir(), hide });
  const watch = (agentId        , first               , after         , cut              ) => live({ host, url, fetcher, agentId, first, timeout, after, thinking: !!o.thinking, cut });

  switch (command) {
    case 'whoami': {
      const me = await host.me();
      emit(me, `${me.kind}${me.role ? ` (${me.role})` : ''} in account ${me.accountId ?? 'none'}; scopes: ${me.scopes.join(', ') || 'none'}`);
      return 0;
    }
    case 'list': {
      const agents = await host.agents.list();
      emit({ agents }, agents.length ? agents.map(agentLine).join('\n') : 'no agents');
      return 0;
    }
    case 'create': {
      if (!o.harness && !o.image) throw new UsageError('create needs --harness <id> (or --image <image>)');
      const a = await host.agents.create({
        name: o.name || `hoppy-${randomBytes(4).toString('hex')}`,
        ...(o.harness ? { harness: o.harness } : {}),
        ...(o.image ? { image: o.image } : {}),
        ...(o.model ? { model: o.model } : {}),
        ...(o['token-cap'] !== undefined ? { tokenCap: taskTokenCap(Number(o['token-cap'])) } : {}),
      });
      emit(a, `created ${agentLine(a)}`);
      return 0;
    }
    case 'chat': {
      const agentId = await agentOf(a1, host);
      // A program reading --json, or a pipe, gets one message per command, never a session.
      if (!rest.length && process.stdin.isTTY && !json) return session(host, agentId, o.conversation, watch);
      const message = need(rest.join(' ') || undefined, 'the message');
      // Made here, so hoppy can name it before the reply comes and a resend is the same message.
      const messageId = randomUUID();
      // Ctrl-C during the send must still name the message: the brain may already have it.
      let sent = false;
      waiting = { agentId, latest: runningMessage(messageId) };
      detachOnCtrlC(() => sent);
      let started               ;
      try {
        started = await sendMessage(host, agentId, message, messageId, o.conversation);
      } catch (e) {
        if (left) return never();
        throw e;
      }
      if (left) return never();
      sent = true;
      note(`message ${messageId} started; Ctrl-C stops watching, then: hoppy attach ${agentId} ${messageId}`);
      return watch(agentId, started);
    }
    case 'attach': {
      const agentId = await agentOf(a1, host);
      const messageId = need(rest[0], 'the message id');
      return watch(agentId, await host.agents.message(agentId, messageId), o.after);
    }
    case 'status': {
      const agentId = await agentOf(a1, host);
      const m = await host.agents.message(agentId, need(rest[0], 'the message id'));
      const where = m.status === 'failed' ? `failed: ${m.error ?? m.reason ?? 'no reason given'}` : m.status;
      // A failed message is the answer asked for, not a failure of status itself, so it exits 0.
      emit(messageShape(agentId, m, false), `${m.messageId}  ${where}${m.status === 'done' && m.response ? `\n${m.response}` : ''}`);
      return 0;
    }
    case 'cancel': {
      const agentId = await agentOf(a1, host);
      const messageId = need(rest[0], 'the message id');
      await host.agents.cancel(agentId, messageId);
      emit({ agentId, messageId, status: 'cancelling' }, `cancelling ${messageId} on ${agentId}; hoppy status ${agentId} ${messageId} says when it has stopped`);
      return 0;
    }
    case 'logs': {
      const agentId = await agentOf(a1, host);
      if (o.follow) return follow(host, agentId);
      const l = await host.agents.logs(agentId);
      emit({ agentId, ...l }, `${l.stdout}${l.stderr}` || '(no output yet)');
      return 0;
    }
    case 'sleep':
    case 'wake':
    case 'restart': {
      const agentId = await agentOf(a1, host);
      const a = command === 'wake' ? await host.agents.wake(agentId) : command === 'restart' ? await host.agents.restart(agentId) : await host.agents.sleep(agentId, o.deep ? 'deep' : 'light');
      emit(a, `${a.id} is ${a.state}`);
      return 0;
    }
    case 'usage': {
      if (o.agent) {
        const agentId = await agentOf(o.agent, host);
        const u = await host.agents.usage(agentId, days ? { days } : {});
        const models = u.models.map((m) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', '));
        emit({ agentId, ...u }, [`${agentId}, last ${u.days} days (${u.tokensAre}):`, ...(models.length ? models : ['no model calls'])].join('\n'));
        return 0;
      }
      const u = await host.usage(days);
      const sum = (f                                                            ) => u.daily.reduce((s, d) => s + (d[f] ?? 0), 0);
      emit(u, `last ${u.days} days: ${sum('calls')} model calls, ${sum('failed')} failed, ${sum('prompt_tokens')} prompt and ${sum('completion_tokens')} completion tokens (${u.tokensAre})`);
      return 0;
    }
    case 'delete': {
      const agentId = await agentOf(a1, host);
      await host.agents.delete(agentId);
      emit({ agentId, deleted: true }, `deleted ${agentId}`);
      return 0;
    }
    case 'files':
      return files(host, a1, await agentOf(rest[0], host), rest.slice(1), !!o.force);
    case 'steps': {
      const agentId = await agentOf(a1, host);
      const steps = await host.agents.steps(agentId, o.message);
      emit({ agentId, messageId: o.message ?? null, steps }, steps.length ? steps.map((s) => `${s.at}  ${s.tool}  ${s.detail}`).join('\n') : 'no steps');
      return 0;
    }
    case 'conversations': {
      const agentId = await agentOf(rest[0], host);
      if (a1 === 'ls') {
        const conversations = await host.conversations.list(agentId);
        const line = (c                                ) => `${c.id}  ${c.source}  ${c.messages} messages  ${c.title}`;
        emit({ agentId, conversations }, conversations.length ? conversations.map(line).join('\n') : 'no conversations');
        return 0;
      }
      const conversationId = need(rest[1], 'the conversation id');
      await host.conversations.delete(agentId, conversationId);
      emit({ agentId, conversationId, deleted: true }, `deleted conversation ${conversationId}`);
      return 0;
    }
    case 'pool': {
      const pools = new PoolManager(host, { dir: taskDir(), hide });
      if (a1 === 'list') {
        const listed = await pools.list();
        emit({ pools: listed }, listed.length ? listed.map(p => `pool ${p.name}: ${p.agents.length}/${p.size} agents${p.createUnknown ? ', create answer lost; inspect account' : ''}\n${p.agents.map(a => `  ${a.agentId}: ${a.status}, wake ${a.wakeMs === null ? 'not measured' : a.wakeMs + ' ms'}`).join('\n')}`).join('\n') : 'no pools');
        return 0;
      }
      const name = need(rest[0], 'the pool name');
      if (a1 === 'drain') {
        const pool = await pools.drain(name);
        emit(pool, `pool ${name}: ${pool.agents.length} busy or dirty agents left${pool.createUnknown ? '; a create answer was lost, inspect the account' : ''}`);
        return pool.agents.length || pool.createUnknown ? 1 : 0;
      }
      let template;
      try { template = JSON.parse(readFileSync(need(o.template, '--template with the pool template JSON file'), 'utf8')); }
      catch { throw new UsageError('pool fill needs --template with a readable JSON file'); }
      const warning = poolCapWarning(template);
      if (warning) note(warning);
      const pool = await pools.fill(name, template, o.size === undefined ? 2 : Number(o.size));
      emit(pool, `pool ${name}: ${pool.agents.length} agents, ${pool.template.awake ? 'kept awake' : 'in deep sleep'}`);
      return 0;
    }
    case 'fleet': {
      if (a1 === 'list') {
        const runs = await fleets.list();
        emit({ fleets: runs }, runs.length ? runs.map(r => `fleet ${r.run}: ${r.ended ? 'ended' : 'unfinished'}, ${r.agents.length} tasks${r.keep ? ', kept' : ''}`).join('\n') : 'no fleets');
        return 0;
      }
      if (a1 === 'clean') {
        const runs = rest[0] ? [{ run: rest[0] }] : (await fleets.list()).filter(r => !r.ended && !r.keep);
        const cleaned = [];
        for (const run of runs) cleaned.push(await fleets.clean(run.run));
        emit({ fleets: cleaned }, cleaned.length ? cleaned.map(r => `fleet ${r.run}: ${r.ended ? 'cleaned' : 'cleanup unfinished; try hoppy fleet clean again'}`).join('\n') : 'no unfinished fleets to clean');
        return cleaned.some(r => !r.ended) ? 1 : 0;
      }
      let spec;
      try { spec = JSON.parse(readFileSync(need(rest[0], 'the fleet spec JSON file'), 'utf8')); }
      catch { throw new UsageError('fleet run needs a readable spec JSON file'); }
      if (o.keep) spec.keep = true;
      if (o.pool !== undefined) spec.pool = o.pool;
      const stop = new AbortController();
      const cancel = () => stop.abort();
      process.once('SIGINT', cancel);
      try {
        const run = await fleets.start(spec, stop.signal);
        note(`fleet ${run.run}: ${run.tasks.length} tasks; hoppy fleet clean ${run.run} can finish cleanup after a crash`);
        const result = run.tasks.length ? await fleets.wait(run.tasks, { timeoutMs: timeout * 1000, signal: stop.signal, progress: note }) : null;
        const saved = (await fleets.list()).find(r => r.run === run.run) ;
        for (const row of saved.agents) {
          const value = row.result?.value ?? result?.value.tasks.find((v     ) => v.task === row.task) ?? { task: row.task, status: 'running' };
          outJson(value);
        }
        outJson({ run: saved.run, ended: saved.ended, keep: saved.keep, done: saved.agents.filter(a => a.result?.value.status === 'done').length, failed: saved.agents.filter(a => a.result?.value.status === 'failed').length, timedOut: result?.value.timedOut ?? false });
        if (stop.signal.aborted) return 130;
        if (result?.value.timedOut) return 3;
        return saved.agents.some(a => a.result?.value.status === 'failed') || !saved.ended ? 1 : 0;
      } finally { process.off('SIGINT', cancel); }
    }
    case 'task': {
      const options = { dir: taskDir(), hide };
      if (a1 === 'result') {
        const r = await fleets.result(need(rest[0], 'the task id'));
        emit(r.value, r.text);
        return r.value.status === 'failed' ? 1 : 0;
      }
      if (a1 === 'pull') {
        const r = await pullTask(host, need(rest[0], 'the task id'), { ...options, cwd: process.cwd() });
        emit(r.value, r.text);
        return 0;
      }
      if (a1 === 'wait') {
        if (!rest.length) throw new UsageError('task wait needs the task ids');
        if (o.until !== undefined && o.until !== 'any' && o.until !== 'all') throw new UsageError(`--until takes any or all, not ${o.until}`);
        if (!(timeout > 0)) throw new UsageError('--timeout takes a number of seconds above 0');
        const stop = new AbortController();
        // Ctrl-C stops waiting and says where each task stands; the tasks keep running.
        const ctrlC = () => stop.abort();
        process.once('SIGINT', ctrlC);
        try {
          const r = await fleets.wait(rest, { until: (o.until                             ) ?? 'all', timeoutMs: timeout * 1000, signal: stop.signal });
          emit(r.value, r.text);
          if (stop.signal.aborted) return 130;
          if (r.value.tasks.some((t                    ) => t.status === 'failed' || t.status === 'unknown')) return 1;
          return r.value.timedOut ? 3 : 0;
        } finally {
          process.off('SIGINT', ctrlC);
        }
      }
      const agentId = o.pool === undefined ? await agentOf(rest[0], host) : undefined;
      const goal = need((o.pool === undefined ? rest.slice(1) : rest).join(' ') || undefined, 'the goal');
      const checkSeconds = number(o['check-seconds'], '--check-seconds');
      if (checkSeconds !== undefined && (!Number.isInteger(checkSeconds) || checkSeconds > CHECK_SECONDS_MAX)) throw new UsageError(`--check-seconds takes a whole number from 1 to ${CHECK_SECONDS_MAX}`);
      const t = await assignTask(
        host,
        { agentId, ...(o.pool !== undefined ? { pool: o.pool } : {}), goal, files: o.file ?? [], ...(o.repo ? { repo: o.repo } : {}), ...(o.workdir ? { workdir: o.workdir } : {}), ...(o.check ? { check: o.check } : {}), ...(o.returns ? { returns: o.returns } : {}), ...(checkSeconds !== undefined ? { checkSeconds } : {}), ...(o.push ? { push: true } : {}), ...(o.branch !== undefined ? { branch: o.branch } : {}), ...(o['token-cap'] !== undefined ? { tokenCap: taskTokenCap(Number(o['token-cap'])) } : {}) },
        options
      );
      if (t.status === 'failed') {
        emit(t, `task ${t.task} failed before it was sent: ${t.failedBecause?.replace(/_/g, ' ')}${t.error ? `\n${t.failedBecause === 'clone_failed' ? `${REMOTE}\n` : ''}${t.error}` : ''}`);
        return 1;
      }
      emit(t, `task ${t.task} sent to ${t.agentId} as message ${t.messageId}${t.branch ? `, to push to ${t.branch}` : ''}; hoppy task result ${t.task} says how it ended`);
      return 0;
    }
  }
  return 2;
}

/** A refusal from a public route, read as the SDK reads one, so fail() words it the same way. */
async function refusal(res          )                          {
  const body = (await res.json().catch(() => null))                                                          ;
  return new AgentHostError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? `the brain answered ${res.status}`);
}

/** Writes text to path, mode 600, by a file beside it renamed over it. Throws a UsageError naming what it was saving. */
function saveSecret(path        , text        , what        ) {
  const temp = tempName(path);
  try {
    // Renamed into place, so the text is never in a file others can read, even for a moment.
    writeFileSync(temp, `${text}\n`, { mode: 0o600, flag: 'wx' });
    // The mode given to writeFileSync is narrowed by the umask, never widened; this makes it exact.
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw new UsageError(`could not save ${what} in ${path} (${(e                         ).code ?? (e         ).message}); the sign-in is used, so run hoppy login again once that is fixed`);
  }
}

/**
 * Revokes a key on the brain at url: asks GET /v1/me for its id, then DELETE /v1/keys/{id}.
 * Returns refused: true when that brain already refuses the key. Throws when the brain cannot
 * name or revoke it, or cannot be reached; the key may then still work.
 */
async function revokeKey(url        , k        , fetcher                          )                                                      {
  const host = new AgentHost({ url, apiKey: k, ...(fetcher ? { fetch: fetcher } : {}) });
  let keyId                = null;
  try {
    keyId = (await host.me()).keyId ?? null;
    if (!keyId) throw new AgentHostError(501, 'not_built_yet', 'this brain does not say which key this is yet, so hoppy cannot revoke it');
    await host.keys.revoke(keyId);
    return { refused: false, keyId };
  } catch (e) {
    if (e instanceof AgentHostError && (e.status === 401 || (e.status === 404 && e.code === 'key_not_found'))) return { refused: true, keyId };
    throw e;
  }
}

/** What POST /v1/device answers: verifyUrlComplete only for a sign-in bound to this terminal's callback. */
                                                                                                                                                
/** The loopback callback a bound sign-in's grant comes back to, with the PKCE pair that goes with it. */
                 
                   
                    
                   
                                                               
                         
                                                                                                    
                                         
                    
  

const CALLBACK_PAGE = (ok         ) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hoppy</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8f4;color:#1d2a1f;font:16px/1.5 system-ui,sans-serif}
main{max-width:26rem;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 1px 3px #0002;text-align:center}h1{margin:0 0 .5rem;font-size:1.25rem;color:${ok ? '#2f7d32' : '#b3261e'}}</style></head>
<body><main><h1>Hoppy</h1><p>${ok ? 'Signed in. You can close this tab and go back to your terminal.' : 'The sign-in did not finish. Go back to your terminal to see why.'}</p></main></body></html>
`;

/**
 * Listens on 127.0.0.1 at a port the system picks for the one request a bound sign-in's approval
 * sends the browser to. Anything but GET /callback?grant=... on the address it registered is 404,
 * and the wait goes on. Null when it cannot listen, so login falls back to the typed code.
 */
async function listenForGrant()                           {
  const http = await import('node:http');
  const verifier = randomBytes(32).toString('base64url');
  let deliver                          = () => {};
  const grant = new Promise        ((resolve) => (deliver = resolve));
  let page                                            = null;
  let host = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const given = u.searchParams.get('grant');
    // The Host check keeps out a page that reaches this port under its own name (DNS rebinding).
    if (page || req.method !== 'GET' || req.headers.host !== host || u.pathname !== '/callback' || !given) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Not found\n');
      return;
    }
    page = res;
    deliver(given.slice(0, 200));
  });
  try {
    await new Promise      ((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch {
    return null;
  }
  host = `127.0.0.1:${(server.address()                                  ).port}`;
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    redirect: `http://${host}/callback`,
    grant,
    settle: (ok) =>
      new Promise      ((resolve) => {
        if (!page || page.headersSent) return resolve();
        page
          .writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
            'referrer-policy': 'no-referrer',
          })
          .end(CALLBACK_PAGE(ok), () => resolve());
      }),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * The program that opens an address in this computer's browser, or null where there is no screen
 * to open it on. BROWSER, when set, is used as is (git and xdg-open read it the same way). Over SSH,
 * or on Linux with no display, a browser would open on a screen the person may not be at.
 */
function browserOpener()                            {
  if (process.env.BROWSER) return [process.env.BROWSER, []];
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return null;
  if (process.platform === 'darwin') return ['open', []];
  // start is a cmd builtin, so cmd would read the address as a command line; rundll32 takes it as one argument.
  if (process.platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler']];
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
  return ['xdg-open', []];
}

/**
 * Opens an http or https address with the opener, as an argument and never through a shell. True
 * when the opener ended well, or is still going after 3 seconds (some stay until the browser does).
 */
function openBrowser(opener                    , address        )                   {
  let page     ;
  try {
    page = new URL(address);
  } catch {
    return Promise.resolve(false);
  }
  // The address comes from the brain: opening file: or another scheme would have the opener run a program.
  if (!/^https?:$/.test(page.protocol)) return Promise.resolve(false);
  // URL's own spelling escapes quotes and spaces, which rundll32 would otherwise read as its command line's.
  const href = page.href;
  return new Promise((resolve) => {
    let child                          ;
    try {
      child = spawn(opener[0], [...opener[1], href], { stdio: 'ignore', detached: true, windowsHide: true });
    } catch {
      return resolve(false);
    }
    const later = setTimeout(() => {
      child.unref();
      resolve(true);
    }, 3000);
    child.once('error', () => (clearTimeout(later), resolve(false)));
    child.once('exit', (code) => (clearTimeout(later), resolve(code === 0)));
  });
}

/**
 * login: a terminal sign-in shaped like the OAuth device flow (POST /v1/device). Where a browser
 * can open, the sign-in is bound to a callback on 127.0.0.1 with a PKCE challenge: hoppy opens the
 * approval page itself, the approval sends the browser to the callback with a one-time grant, and
 * hoppy trades the grant and its verifier for the key at /v1/device/token. Otherwise (--no-browser,
 * no screen, an opener that fails, a brain that does not bind) the person types the code shown and
 * hoppy asks /v1/device/token until it is approved. The key it is given is
 * written to the key file, mode 600, and never printed; the brain's address goes in the same file,
 * written whole by one rename, so logout revokes the key where it works and no other brain is sent it. With --force, the key it replaces is revoked once the new
 * one is saved, on the brain that made it; one that does not say which brain made it is sent nowhere, and the member is told to revoke it. With --json, the address is one JSON line first, then what the key signed in as.
 */
async function login(url        , file                    , force         , fetcher                          , browser         )                  {
  const path = keyPath(file);
  dropInterruptedSaves(path);
  // A key replaced unseen would keep working with nobody holding it to revoke.
  if (existsSync(path) && !force) throw new UsageError(`already signed in with the key in ${path}; run hoppy logout first, or give --force to replace it`);
  let old                                               = null;
  let oldUnread = false;
  if (existsSync(path)) {
    // Read before the new key is written over it: it is revoked once the new one is safe.
    try {
      old = readSaved(path);
      unsaid.push(old.key);
    } catch {
      oldUnread = true;
    }
  }
  const call = (route        , body         ) =>
    (fetcher ?? fetch)(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `hoppy/${VERSION}` }, body: JSON.stringify(body) });
  const name = `hoppy on ${os.hostname()}`.slice(0, 80);
  const begin = async (body                        )                       => {
    const started = await call('/v1/device', body);
    // A brain with no terminal sign-in route checks the bearer before it looks for a route, so it
    // answers 401 here; repeating its words would tell the person about a key they never gave.
    if (started.status === 401) throw new AgentHostError(401, 'unauthorized', 'this brain does not serve hoppy login yet');
    if (!started.ok) throw await refusal(started);
    return (await started.json())               ;
  };
  // Listening before anything is shown: a person (or a test) may press Ctrl-C the moment it appears,
  // and a SIGINT with no listener yet kills hoppy outright instead of exiting 130.
  process.on('SIGINT', () => finish(130));
  const opener = browser ? browserOpener() : null;
  let callback = opener ? await listenForGrant() : null;
  let token = '';
  try {
    let d                     = null;
    if (opener && callback) {
      d = await begin({ name, codeChallenge: callback.challenge, redirect: callback.redirect });
      if (d.verifyUrlComplete && (await openBrowser(opener, d.verifyUrlComplete))) {
        if (json) outJson({ userCode: d.userCode, verifyUrl: d.verifyUrl, verifyUrlComplete: d.verifyUrlComplete, expiresIn: d.expiresIn, opened: true });
        note(`Opening Hoppy in your browser to sign in...\n  If it does not open, go to ${d.verifyUrlComplete}`);
      } else {
        callback.close();
        callback = null;
        // A bound approval would send the browser to this machine's 127.0.0.1, which no browser here
        // reached, so the typed code needs a sign-in of its own. A brain that did not bind keeps its one.
        if (d.verifyUrlComplete) d = null;
      }
    }
    if (!callback) {
      d ??= await begin({ name });
      if (json) outJson({ userCode: d.userCode, verifyUrl: d.verifyUrl, expiresIn: d.expiresIn, opened: false });
      note(`To sign in, go to ${d.verifyUrl}\nand type this code: ${d.userCode}`);
    }
    note('Waiting for you to approve in the browser (Ctrl-C to stop)');
    token = await waitForKey(call, d , callback);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdirSync leaves a folder that already exists as it was. hoppy's own folder is made its
    // owner's only either way; a folder named by --key-file or HOPPY_KEY_FILE may be shared, like /tmp.
    if (!file && !process.env.HOPPY_KEY_FILE) chmodSync(dir, 0o700);
    saveSecret(path, `${token}\n${BRAIN_LINE}${url}`, 'the key');
    await callback?.settle(true);
  } finally {
    await callback?.settle(false);
    callback?.close();
  }
  if (oldUnread) note(`hoppy could not read the key that was in ${path} before, so it may still work; revoke it in Hoppy, under Settings, Signed-in terminals`);
  // A key with no brain line (made by hand from the Keys page) may be from any brain, and only the brain that
  // made it may be sent it: sending it here to revoke it would hand this brain another brain's key.
  if (old && !old.brain)
    note(`the key that was in ${path} before does not say which brain made it, so hoppy sent it nowhere to revoke it; it may still work, so revoke it in Hoppy, under Settings, Signed-in terminals, if you made it, or ask an owner or admin of the workspace to revoke it on the Keys page`);
  else if (old?.brain) {
    try {
      const r = await revokeKey(old.brain, old.key, fetcher);
      note(r.refused ? `the key that was in ${path} before was already refused` : `revoked the key that was in ${path} before`);
    } catch (e) {
      note(`the key that was in ${path} before ${e instanceof AgentHostError ? 'still works' : 'may still work'}; revoke it in Hoppy, under Settings, Signed-in terminals`);
    }
  }
  const me = await new AgentHost({ url, apiKey: token, ...(fetcher ? { fetch: fetcher } : {}) }).me();
  if (!file && process.env.HOPPY_KEY) note('HOPPY_KEY is set, and hoppy uses it ahead of the key file; unset it to use this key');
  emit({ signedIn: true, keyFile: path, accountId: me.accountId, role: me.role, scopes: me.scopes }, `Signed in to account ${me.accountId ?? 'none'}${me.role ? ` as ${me.role}` : ''}.`);
  return 0;
}

/**
 * Waits for a sign-in's key: from the grant its callback receives, traded with the verifier, or
 * for a sign-in with no callback, by asking /v1/device/token until it is approved. A bound sign-in
 * is still asked about every interval, so a deny or an expiry in the browser ends the wait.
 */
async function waitForKey(call                                                     , d             , callback                 )                  {
  let pollMs = Number(process.env.HOPPY_POLL_MS) || d.interval * 1000;
  const deadline = Date.now() + d.expiresIn * 1000;
  const expired = (e                 ) => new AgentHostError(e?.status ?? 410, 'expired', 'the code expired before it was approved; run hoppy login again');
  for (;;) {
    const pause = new Promise      ((r) => setTimeout(r, pollMs, null));
    const grant = await (callback ? Promise.race([callback.grant, pause]) : pause);
    const res = grant
      ? await call('/v1/device/token', { deviceCode: d.deviceCode, grant, codeVerifier: callback .verifier })
      : Date.now() > deadline
        ? null
        : await call('/v1/device/token', { deviceCode: d.deviceCode });
    if (!res) throw expired();
    if (res.ok) {
      const token = String(((await res.json())                       ).token ?? '');
      // Hidden from here on, before anything else can print it.
      key = token;
      if (!token.startsWith('ak_')) throw new AgentHostError(502, 'bad_answer', 'the brain approved the sign-in but sent no key');
      return token;
    }
    const e = await refusal(res);
    if (!grant && (e.code === 'authorization_pending' || e.code === 'finish_in_browser')) continue;
    // The OAuth device flow's answer to asking too often: wait longer from then on.
    if (!grant && e.code === 'slow_down') {
      pollMs += 5000;
      continue;
    }
    if (e.code === 'denied') throw new AgentHostError(e.status, e.code, 'the sign-in was denied in the browser; nothing was saved');
    if (e.code === 'expired') throw expired(e);
    throw e;
  }
}

/**
 * logout: revokes the key in use on the brain that gave it, then removes the key file. A key that
 * brain already refuses is removed too. A key the brain cannot name or revoke is kept, with a
 * plain line saying it still works: removing it would leave a live key nobody can find. So is a
 * key this brain refuses when hoppy does not know which brain made it, since it may work on another.
 */
async function logout(urlGiven        , file                    , fetcher                          )                  {
  const fromEnv = !file && !!process.env.HOPPY_KEY;
  const path = fromEnv ? null : keyPath(file);
  if (path && !existsSync(path)) {
    emit({ revoked: false, keyId: null, keyFile: null }, 'not signed in; nothing to do');
    return 0;
  }
  const saved = readSaved(file);
  key = saved.key;
  const from = saved.brain;
  // A refusal from any other brain says nothing about the brain where the key works.
  if (from && from !== urlGiven) note(`this key is from ${from}, so hoppy logs out there`);
  const url = from ?? urlGiven;
  const where = path ? `is still in ${path}` : 'is still in HOPPY_KEY';
  const remove = () => {
    if (!path) return;
    rmSync(path, { force: true });
  };
  let r                                            ;
  try {
    r = await revokeKey(url, key, fetcher);
  } catch (e) {
    if (e instanceof AgentHostError) note(`the key still works and ${where}; revoke it in Hoppy, under Settings, Signed-in terminals, then delete the file${path ? '' : ' or unset HOPPY_KEY'}`);
    throw e;
  }
  if (r.refused) {
    if (path && !from)
      throw new AgentHostError(
        401,
        'unauthorized',
        `this brain refuses the key, but hoppy does not know which brain made it, so it may still work on another and is kept in ${path}; run hoppy logout with HOPPY_URL set to that brain, or delete ${path} yourself`
      );
    note('the brain already refuses this key');
    remove();
    emit({ revoked: false, keyId: r.keyId, keyFile: path }, path ? `removed ${path}` : 'unset HOPPY_KEY; the key in it no longer works');
    return 0;
  }
  remove();
  emit({ revoked: true, keyId: r.keyId, keyFile: path }, path ? `revoked the key and removed ${path}` : 'revoked the key in HOPPY_KEY; unset HOPPY_KEY');
  return 0;
}

/**
 * logs -f: each line as the agent writes it, from the brain's follow route, until the brain ends
 * the follow (exit 0) or Ctrl-C (exit 130). With --json, one JSON line per log line.
 */
async function follow(host           , agentId        )                  {
  const stop = new AbortController();
  process.on('SIGINT', () => {
    stop.abort();
    finish(130);
  });
  note(`following ${agentId}'s output; Ctrl-C stops`);
  try {
    for await (const l of await host.agents.followLogs(agentId, { signal: stop.signal })) {
      if (json) outJson(l);
      else (l.stream === 'stderr' ? note : out)(`${l.at} ${l.line}`);
    }
  } catch (e) {
    if (stop.signal.aborted) return never();
    throw e;
  }
  return stop.signal.aborted ? never() : 0;
}

/** files ls, put, get, mkdir, mv and rm. */
async function files(host           , sub        , agentId        , args          , force         )                  {
  switch (sub) {
    case 'ls': {
      const path = onAgent(args[0] ?? '/data');
      // Read raw: the route lists a folder as JSON but answers a file with its bytes.
      const res = await host.request          ('GET', `/v1/agents/${encodeURIComponent(agentId)}/files?path=${encodeURIComponent(path)}`, undefined, { raw: true });
      if (!res.headers.get('content-type')?.includes('json')) {
        await res.body?.cancel();
        throw new UsageError(`${path} is a file, not a folder; fetch it with hoppy files get ${agentId} ${path}`);
      }
      const { entries } = (await res.json())                            ;
      const line = (e           ) => `${e.type === 'dir' ? 'dir ' : 'file'}  ${String(e.size).padStart(10)}  ${e.modifiedAt}  ${e.name}`;
      emit({ agentId, path, entries }, entries.length ? entries.map(line).join('\n') : `${path} is empty`);
      return 0;
    }
    case 'put': {
      const local = need(args[0], 'the local file (or - for stdin)');
      if (local === '-' && !args[1]) throw new UsageError('files put from stdin needs the path to write on the agent');
      const path = onAgent(args[1] ?? basename(local));
      let bytes        ;
      try {
        bytes = local === '-' ? await readStdin() : readFileSync(local);
      } catch (e) {
        throw new UsageError(`could not read ${local} (${(e                         ).code ?? (e         ).message})`);
      }
      const r = await host.files.write(agentId, path, bytes);
      const size = r?.size ?? bytes.length;
      emit({ agentId, path: r?.path ?? path, size }, `put ${size} bytes at ${r?.path ?? path}`);
      return 0;
    }
    case 'get': {
      const path = onAgent(need(args[0], 'the path on the agent'));
      const local = args[1] ?? basename(path);
      if (local === '-' && json) throw new UsageError('files get to stdout prints the bytes, so it cannot print --json too; give a local file');
      if (local !== '-' && !force && existsSync(local)) throw new UsageError(`${local} exists; give --force to replace it`);
      // Read raw: the route answers a folder with its listing as JSON, which is not the file asked for.
      const res = await host.request          ('GET', `/v1/agents/${encodeURIComponent(agentId)}/files?path=${encodeURIComponent(path)}`, undefined, { raw: true });
      if (res.headers.get('content-type')?.includes('json')) {
        await res.body?.cancel();
        throw new UsageError(`${path} is a folder, not a file; list it with hoppy files ls ${agentId} ${path}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      // The file's own bytes, as they are: not scanned, since a change of even one byte breaks the file.
      if (local === '-') return await new Promise        ((r) => process.stdout.write(bytes, () => r(0)));
      try {
        writeFileSync(local, bytes);
      } catch (e) {
        // A folder that is not there, or a local folder by that name: the brain answered, so this is setup, not an unreachable brain.
        throw new UsageError(`could not write ${local} (${(e                         ).code ?? (e         ).message})`);
      }
      emit({ agentId, path, size: bytes.length, savedTo: local }, `saved ${path} (${bytes.length} bytes) to ${local}`);
      return 0;
    }
    case 'mkdir': {
      const path = onAgent(need(args[0], 'the folder path'));
      await host.files.mkdir(agentId, path);
      emit({ agentId, path }, `made ${path}`);
      return 0;
    }
    case 'mv': {
      const from = onAgent(need(args[0], 'the path to move'));
      const to = onAgent(need(args[1], 'the path to move it to'));
      await host.files.move(agentId, from, to);
      emit({ agentId, from, to }, `moved ${from} to ${to}`);
      return 0;
    }
    case 'rm': {
      const path = onAgent(need(args[0], 'the path to delete'));
      await host.files.delete(agentId, path);
      emit({ agentId, path, deleted: true }, `deleted ${path}`);
      return 0;
    }
  }
  return 2;
}

/** The codes and statuses the brain documents for PUT /v1/agents/{agentId}/env, and restart_required from a brain that saves only without apply: the only ones env set repeats. */
const ENV_SET_CODES = new Set([
  'bad_json', 'bad_request', 'unknown_model', 'model_not_supported', 'bad_env_name', 'reserved_env_name', 'bad_env_value', 'env_too_big',
  'unauthorized', 'insufficient_credit', 'missing_scope', 'account_suspended', 'agent_not_found', 'internal', 'runtime_error',
  'agent_exited', 'not_isolated', 'worker_unreachable', 'paused', 'boot_timeout', 'not_built_yet', 'not_found',
  'restart_required', 'env_changed', 'secret_too_short',
]);
const ENV_SET_STATUSES = new Set([400, 401, 402, 403, 404, 409, 500, 501, 502, 503, 504]);

/**
 * restartBy as env set says it: only a real time within the next day, rounded up to the minute, and never
 * any time that would repeat the value just sent. The brain picks every digit of it.
 */
function restartTime(given         , sent        )                {
  if (typeof given !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(given)) return null;
  const at = new Date(given);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== given) return null;
  const ahead = at.getTime() - Date.now();
  if (ahead < -60_000 || ahead > 86_400_000) return null;
  // Up to the next whole minute, so "by" this time stays true.
  const shown = new Date(Math.ceil(at.getTime() / 60_000) * 60_000).toISOString();
  return given === sent || shown.includes(sent) ? null : shown;
}

/**
 * What env set says when its call fails, in hoppy's own words only. A brain may repeat the value in
 * its message, in its code, in its status, or in an answer that is not JSON (which the parser's error
 * then quotes in part), so nothing of the answer is kept but a documented status and code.
 */
function envSetFailure(e         , name        , agentId        , sent        )        {
  if (e instanceof AgentHostError) {
    const status = ENV_SET_STATUSES.has(e.status) && String(e.status) !== sent ? e.status : 0;
    const known = typeof e.code === 'string' && (ENV_SET_CODES.has(e.code) || (status && e.code === `http_${status}`));
    const code = status && known && e.code !== sent ? e.code : 'refused';
    if (code === 'not_built_yet') return new AgentHostError(status, code, 'not built on this brain yet');
    if (code === 'restart_required')
      return new AgentHostError(status, code, `${name} was not set on ${agentId}: this brain does not restart an agent on --apply; set it without --apply, then hoppy restart ${agentId}`);
    if (code === 'secret_too_short')
      return new AgentHostError(status, code, `${name} was not set on ${agentId}: a secret must be at least 8 characters; if it is not a secret, set it without --secret`);
    return new AgentHostError(status, code, `the brain refused ${name} on ${agentId}; its message is not shown, as it may repeat the value`);
  }
  if (e instanceof SyntaxError)
    return new AgentHostError(0, 'bad_answer', `the brain's answer to setting ${name} on ${agentId} could not be read, and is not shown, as it may repeat the value; check with hoppy env ls ${agentId}`);
  const kind = (e         )?.name === 'TimeoutError' ? 'took too long' : 'did not finish';
  return new Error(`setting ${name} on ${agentId} ${kind}; check with hoppy env ls ${agentId}`);
}

/** env ls, set and rm. set reads the value from stdin and never prints it. */
async function envCommand(makeHost                              , sub        , agentId        , args          , secret         , apply         )                  {
  if (sub === 'ls') {
    const { vars } = await makeHost().agents.env.list(agentId);
    emit({ agentId, vars }, vars.length ? vars.map((v) => `${v.key}  ${v.secret ? '(secret)' : v.value}`).join('\n') : 'no settings');
    return 0;
  }
  const name = need(args[0], 'the setting name');
  if (sub === 'rm') {
    await makeHost().agents.env.delete(agentId, name);
    emit({ agentId, key: name, deleted: true }, `removed ${name} from ${agentId}`);
    return 0;
  }
  // An argument would sit in the shell's history and the process list; its text is not repeated here either.
  if (args.length > 1) throw new UsageError(`env set reads the value from stdin, never from an argument; pipe it in: printf %s "$VALUE" | hoppy env set ${agentId} ${name}`);
  // A pipe may add a newline. The terminal reader already consumes Enter outside a paste.
  const value = process.stdin.isTTY
    ? await readUnseen(`value for ${name} (not shown): `)
    : (await readStdin()).toString('utf8').replace(/\r?\n$/, '');
  if (!value) throw new UsageError(`no value for ${name} on stdin`);
  let r                                                                             ;
  try {
    // Sent either way: the brain stores a setting sent without "secret" as a secret, and refuses a short one.
    r = (await makeHost(value).agents.env.set(agentId, { [name]: value }, { secret, ...(apply ? { apply } : {}) }))            ;
  } catch (e) {
    throw envSetFailure(e, name, agentId, value);
  }
  const restartBy = restartTime(r?.restartBy, value);
  const done = { agentId, key: name, secret, applied: r?.applied === true, waitingForIdle: r?.waitingForIdle === true, restartBy };
  // Leave hoppy's own words intact. A [hidden] where one matches the value would give it away.
  const when = done.applied ? '; restarted with it' : done.waitingForIdle ? `; restarts with it once idle${done.restartBy ? `, by ${done.restartBy}` : ''}` : apply ? '' : '; it takes effect at the next restart (--apply restarts now)';
  emit(done, `set ${name}${secret ? ' (secret)' : ''} on ${agentId}${when}`);
  return 0;
}

/**
 * Serves MCP on stdin and stdout until the client closes stdin. A wrong setup does not stop it
 * starting: a coding tool shows a server that fails to start as a bare failure, while a tool error
 * says what to fix. While it is not set up, each tool call reads the setup again, so a key saved
 * by hoppy login after the start is used with no restart.
 */
async function mcp(urlGiven                    , keyFile                    , debug         )                  {
  const setup = () => {
    try {
      const url = brainUrl(urlGiven);
      key = keyFor(keyFile, url);
      const fetcher = noRedirects(debug ? debugFetch() : fetch);
      note(`hoppy mcp: serving on stdin and stdout for ${url}`);
      return {
        host: new AgentHost({ url, apiKey: key, fetch: fetcher }),
        live: { baseUrl: url, headers: { Authorization: `Bearer ${key}`, 'User-Agent': `hoppy/${VERSION}` }, fetch: fetcher },
        setupError: null,
      };
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      // Claude Code users meet this first; the plugin's /hoppy:login runs hoppy login for them.
      const setupError = e instanceof NoKeyError ? `not signed in: run /hoppy:login in Claude Code, or hoppy login in a terminal; or ${e.message.replace(/^not signed in: run hoppy login, or /, '')}` : e.message;
      note(`hoppy mcp: not set up: ${setupError}`);
      return { host: null, live: null, setupError };
    }
  };
  const { serve } = await import('./mcp.js');
  await serve({
    ...setup(),
    setup,
    hide,
    input: process.stdin,
    // stdout carries only the protocol, one message per line.
    write: (line) => process.stdout.write(`${line}\n`),
    log: note,
    pollMs: Number(process.env.HOPPY_POLL_MS) || 2000,
    version: VERSION,
  });
  return 0;
}

/** Prints a failure as --json's error shape on stdout, or as a line on stderr, and returns its exit code. */
function fail(e         )         {
  const [code, status, message, exit] =
    e instanceof UsageError
      ? ['usage', 0, e.message, 2]
      : e instanceof TaskRefused
        ? [e.code, 0, e.message, e.code === 'agent_busy' || e.code === 'pull_refused' ? 1 : 2]
        : e instanceof TaskFailed
        ? [e.code, 0, e.message, 1]
        : e instanceof AgentHostError
        ? [e.code, e.status, e.message, 1]
        : ['unreachable', 0, `could not reach the brain: ${(e         )?.message ?? e}`, 3];
  if (json) outJson({ error: { status, code, message } });
  // A route the brain knows but does not serve yet: say plainly which command is missing.
  if (code === 'not_built_yet' && doing === 'logout') note(`hoppy: ${message} (${status} ${code})`);
  else if (code === 'not_built_yet') note(`hoppy: this brain does not serve ${doing} yet (${status} ${code})`);
  else note(`hoppy: ${message}${code === 'usage' || code === 'unreachable' ? '' : status ? ` (${status} ${code})` : ` (${code})`}`);
  if (code === 'not_found') note(`this brain has no route for ${doing}; it may not serve it yet`);
  if (doing === 'login' && (code === 'not_built_yet' || code === 'not_found' || /does not serve hoppy login yet/.test(message          ))) note(`until then, ask an owner or admin of the workspace for a key from the Keys page and put it in ${keyPath(undefined)} (chmod 600)`);
  if (exit === 2) note('run hoppy help for the commands');
  return exit          ;
}

/**
 * Exits once what was written has left: on macOS a pipe is written in the background, so a bare
 * process.exit can cut the output short.
 */
function finish(code        ) {
  let left = 2;
  const done = () => --left === 0 && process.exit(code);
  process.stdout.write('', done);
  process.stderr.write('', done);
}

main(process.argv.slice(2)).then(finish, (e) => finish(fail(e)));
