/** Ready clones owned by one local pool. Task locks also protect reset and replacement. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { AgentHostError, type AgentHost, type CreateAgent } from '../typescript/src/index.ts';
import { hiddenValue } from './hidden.ts';
import { agentClaimed, assignTask, brainWords, CAP_MIN, CHECK_SECONDS, cloneRepo, hideAll, holdPreparation, lockLocal, PreparationUnknown, prepareTask, q, REMOTE, runCheck, TaskFailed, TaskRefused, taskResult, wholeCount, type Assigned, type TaskInput, type TaskOptions } from './task.ts';

/**
 * A pool name: its agents are named hoppy-pool-<name>-<8 hex>, and an agent name is 1 to 32 lowercase
 * letters, digits, - or _, which leaves 12 for the name.
 */
export const POOL_NAME = /^[a-z0-9][a-z0-9_-]{0,11}$/;
/**
 * The names fill took before POOL_NAME. One of them that POOL_NAME refuses never made an agent (create
 * refused its agents' names), but it left a pool record, so reading, listing and draining still accept
 * it; only a new pool needs POOL_NAME.
 */
const OLD_POOL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const CONVERSATIONS = 100;
const GIT = 'git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false';
/** Harness state outside the clone, using the homes in the image recipes and bridges. */
export const HARNESS_MEMORY: Record<string, string[]> = {
  'claude-code': ['/data/home/.claude/CLAUDE.md', '/data/home/.claude/projects'],
  codex: ['/data/home/.codex/AGENTS.md', '/data/home/.codex/memories'],
  opencode: ['/data/opencode/config/opencode/AGENTS.md'],
  hermes: ['/data/hermes/memories'],
};
/** Instructions and settings outside the clone that a harness loads into every session, from the image recipes and bridges. A change to any means refill, not reuse. */
export const HARNESS_SETTINGS = [
  '/data/workspace/CLAUDE.md', '/data/workspace/AGENTS.md', '/data/workspace/.claude', '/data/workspace/opencode.json', '/data/workspace/opencode.jsonc', '/data/workspace/.opencode',
  '/data/home/.claude/settings.json', '/data/home/.claude/settings.local.json', '/data/home/.claude/agents', '/data/home/.claude/commands', '/data/home/.claude/skills',
  '/data/home/.codex/config.toml',
  '/data/opencode/config/opencode/opencode.json', '/data/opencode/config/opencode/opencode.jsonc',
  '/data/hermes/SOUL.md', '/data/hermes/config.yaml',
];
// -I keeps the working folder, user site folders and PYTHON* settings out of the module search, and -S skips
// start-up files: the clone and the disk hold whatever the last task left, and a planted module would run as code.
const PYTHON = 'python3 -I -S -c';

type Template = { harness: string; image?: string; model?: string; instructions?: string; repo: string; workdir: string; setup?: string; check: string; token_cap: number; awake: boolean };
type Member = { agentId: string; fingerprint: string | null; conversations: { id: string; messageId: string }[]; task: string | null; wakeMs: number | null; error: string | null };
export type Pool = { v: 1; name: string; brain: string; accountId: string; template: Template; size: number; agents: Member[]; createUnknown: boolean };
class Dirty extends Error {}
class Refilled extends Error {}
class CapUsed extends Error {}
/** Only the brain's own answer that the agent no longer exists; any other refusal may pass. */
const gone = (e: unknown) => e instanceof AgentHostError && e.status === 404 && e.code === 'agent_not_found';
/** One measured claude-code task used about 160k tokens (a django task 156k to 317k), so a lower pool cap runs out within a task or two. */
export const POOL_CAP_WARN = 250_000;

/** A warning for a pool template whose cap is likely to run out, or null. Not an error: a person may want a small cap. */
export function poolCapWarning(template: unknown): string | null {
  const t = template as { harness?: unknown; token_cap?: unknown } | null;
  if (!t || t.harness !== 'claude-code' || typeof t.token_cap !== 'number' || t.token_cap >= POOL_CAP_WARN) return null;
  return `warning: token_cap ${t.token_cap} is under ${POOL_CAP_WARN}; one claude-code task uses about 160k tokens, so each pool agent may run out of cap after a task or two. Raise the template's token_cap if that is not what you want.`;
}

/** Hashes paths, types and contents without following links or executing git configuration. Covers every git file the reset keeps that can change what a checkout runs or shows, and the harness instructions and settings outside the clone. */
export function fingerprintCommand(workdir: string): string {
  return `cd ${q(workdir)} && ${PYTHON} ${q(`# hoppy-pool-fingerprint
import hashlib, os, stat
h = hashlib.sha256()
def add(path):
    if not os.path.lexists(path):
        h.update(path.encode() + b'\\0missing\\0')
        return
    s = os.lstat(path)
    h.update(path.encode() + b'\\0' + str(s.st_mode).encode() + b'\\0')
    if stat.S_ISLNK(s.st_mode): h.update(os.readlink(path).encode())
    elif stat.S_ISREG(s.st_mode):
        with open(path, 'rb') as f:
            for block in iter(lambda: f.read(65536), b''): h.update(block)
    elif stat.S_ISDIR(s.st_mode):
        for name in sorted(os.listdir(path)): add(path + '/' + name)
if os.path.isdir('.git') and not os.path.islink('.git'):
    for name in ['config', 'config.worktree', 'hooks', 'info', 'commondir', 'objects/info']: add('.git/' + name)
else: add('.git')
home = os.path.expanduser('~')
for name in [os.environ.get('GIT_CONFIG_GLOBAL') or home + '/.gitconfig', (os.environ.get('XDG_CONFIG_HOME') or home + '/.config') + '/git/config', os.environ.get('GIT_CONFIG_SYSTEM') or '/etc/gitconfig']: add(name)
for name in ${JSON.stringify(HARNESS_SETTINGS)}: add(name)
print(h.hexdigest())`)}`;
}

/** Resets only the clone, keeping ignored installs, then clears the named harness memory. */
export function resetCommand(workdir: string, harness: string, branch: string): string {
  const memory = HARNESS_MEMORY[harness];
  if (!memory) throw new TaskRefused('usage', 'this harness has no pool memory cleanup rule');
  const clear = `import os, pathlib, shutil
for name in ${JSON.stringify(memory)}:
    p = pathlib.Path(name)
    if any(parent.is_symlink() for parent in p.parents): raise ValueError('memory parent is a link')
    if p.is_symlink() or p.is_file(): p.unlink()
    elif p.is_dir(): shutil.rmtree(p)`;
  return `cd ${q(workdir)} && ${GIT} fetch --no-recurse-submodules --prune origin && ${GIT} remote set-head origin --auto && ${GIT} reset --hard refs/remotes/origin/HEAD && ${GIT} clean -fd && ${GIT} checkout -b ${q(branch)} && ${PYTHON} ${q(clear)}`;
}

function nameOf(name: unknown, options: TaskOptions, rule = POOL_NAME): string {
  if (typeof name === 'string' && hideAll(name, options.hide) !== name) throw new TaskRefused('key_refused', 'pool name looks like a key or token; no pool was changed');
  if (typeof name !== 'string' || !rule.test(name)) throw new TaskRefused('usage', "pool name needs 1 to 12 lowercase letters, digits, underscores or hyphens, starting with a letter or digit, so its agents' names fit the 32 characters an agent name may have");
  return name;
}

function templateOf(value: unknown, options: TaskOptions): Template {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskRefused('usage', 'pool fill needs a template object');
  const t = value as Record<string, any>;
  const fields = ['harness', 'image', 'model', 'instructions', 'repo', 'workdir', 'setup', 'check', 'token_cap', 'awake'];
  if (Object.keys(t).some(k => !fields.includes(k))) throw new TaskRefused('usage', 'unknown pool template field; see hoppy pool fill in the CLI guide');
  if (JSON.stringify(hiddenValue(t, s => hideAll(s, options.hide))) !== JSON.stringify(t)) throw new TaskRefused('key_refused', 'a pool field looks like a key or token; give secrets as agent settings');
  for (const k of fields.filter(k => !['token_cap', 'awake'].includes(k))) if (t[k] !== undefined && (typeof t[k] !== 'string' || !t[k].trim())) throw new TaskRefused('usage', `pool ${k} must be text`);
  if (!Object.hasOwn(HARNESS_MEMORY, t.harness)) throw new TaskRefused('usage', 'pool harness must be claude-code, codex, opencode or hermes, with a known memory cleanup rule');
  if (!t.repo || !t.check) throw new TaskRefused('usage', 'pool template needs repo and check; setup is optional');
  if (t.awake !== undefined && typeof t.awake !== 'boolean') throw new TaskRefused('usage', 'awake must be true or false');
  const prepared = prepareTask({ agentId: 'pending', goal: 'prepare pool', repo: t.repo, workdir: t.workdir, tokenCap: t.token_cap }, options);
  const workdir = posix.normalize(prepared.workdir);
  if (!workdir.startsWith('/data/') || workdir === '/data/' || ['/data/home', '/data/hermes', '/data/opencode'].some(p => workdir === p || workdir.startsWith(p + '/'))) throw new TaskRefused('usage', 'pool workdir must be a clone folder under /data, outside the harness home');
  return { ...t, repo: prepared.clone!.url, workdir, token_cap: prepared.tokenCap, awake: t.awake === true } as Template;
}

export class PoolManager {
  readonly host: AgentHost;
  readonly options: TaskOptions;
  /** The waits before each retry of a fresh agent's exec refused 502 runtime_error: about a minute in all. */
  retryWaitsMs = [10_000, 20_000, 30_000];
  constructor(host: AgentHost, options: TaskOptions) { this.host = host; this.options = options; }

  /**
   * The host for a fresh agent's setup: an exec refused 502 runtime_error is sent again after each of
   * retryWaitsMs. The brain says that when the new machine cannot run a command yet ("try again in a
   * minute"); clone, setup, check and fingerprint are each safe to run again.
   */
  private patient(): AgentHost {
    const host = this.host;
    const waits = this.retryWaitsMs;
    const signal = this.options.signal;
    const patient = Object.create(host) as AgentHost;
    patient.request = (async (method: string, path: string, body?: unknown, opts?: Record<string, unknown>) => {
      for (let tries = 0; ; tries++) {
        try {
          return await host.request(method, path, body, opts);
        } catch (e) {
          if (!(tries < waits.length && method === 'POST' && path.endsWith('/exec') && e instanceof AgentHostError && e.status === 502 && e.code === 'runtime_error')) throw e;
          await pause(waits[tries], undefined, { signal });
        }
      }
    }) as AgentHost['request'];
    return patient;
  }

  private async account(write = false) {
    const me = await this.host.me();
    if (!me.accountId || (write && (me.role === 'viewer' || !me.scopes.includes('agents')))) throw new AgentHostError(403, 'missing_scope', 'this member or key cannot change agents');
    return me.accountId;
  }

  private prefix(account: string) { return createHash('sha256').update(this.host.url + '\n' + account).digest('hex').slice(0, 20); }
  private path(name: string, account: string) { return join(this.options.dir, 'pools', `${this.prefix(account)}-${nameOf(name, this.options, OLD_POOL_NAME)}.json`); }
  private read(name: string, account: string): Pool | null {
    const path = this.path(name, account);
    if (!existsSync(path)) return null;
    try {
      const p = JSON.parse(readFileSync(path, 'utf8')) as Pool;
      if (p.v !== 1 || p.name !== name || p.accountId !== account || p.brain !== this.host.url || !Array.isArray(p.agents)) throw new Error();
      return p;
    } catch { throw new TaskRefused('usage', `pool ${name} file cannot be read; no agents were changed`); }
  }
  private save(p: Pool) {
    mkdirSync(join(this.options.dir, 'pools'), { recursive: true, mode: 0o700 });
    const path = this.path(p.name, p.accountId);
    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify(p) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  }

  private async serial<T>(name: string, f: (account: string) => Promise<T>): Promise<T> {
    nameOf(name, this.options, OLD_POOL_NAME);
    const account = await this.account(true);
    return this.locked(name, account, () => f(account));
  }

  private async locked<T>(name: string, account: string, f: () => Promise<T>): Promise<T> {
    let unlock: (() => void) | undefined;
    // Pool metadata changes take turns across clients; the task lock still decides each claim.
    while (!unlock) {
      this.options.signal?.throwIfAborted();
      try { unlock = await lockLocal(this.options, `pool-${this.prefix(account)}-${name}`); }
      catch (e) {
        if (!(e instanceof TaskRefused && e.code === 'agent_busy')) throw e;
        await pause(50, undefined, { signal: this.options.signal });
      }
    }
    try { return await f(); } finally { unlock(); }
  }

  private async dirty(row: Member): Promise<boolean> {
    const list = await this.host.conversations.list(row.agentId, CONVERSATIONS);
    // The served list has no cursor. A full page cannot prove that no outside chat is hidden.
    if (list.length >= CONVERSATIONS) return true;
    for (const c of list) {
      const own = row.conversations.find(x => x.id === c.id);
      if (!own) return true;
      const { messages } = await this.host.conversations.get(row.agentId, c.id, 200);
      if (messages.length >= 200 || messages.some(m => m.role === 'user' && m.messageId !== own.messageId)) return true;
    }
    return false;
  }

  /** dirty, or gone when the brain says the agent no longer exists (deleted by hand, as the CLI guide advises for a retired agent). */
  private async standing(row: Member): Promise<'gone' | 'dirty' | null> {
    try { return await this.dirty(row) ? 'dirty' : null; }
    catch (e) { if (gone(e)) return 'gone'; throw e; }
  }

  private async command(id: string, command: string, host = this.host): Promise<string> {
    let out: { exitCode: number; stdout: string; stderr: string };
    try {
      // Client cancellation cannot stop a remote exec. Its claim holds until it answers.
      out = await host.request('POST', `/v1/agents/${encodeURIComponent(id)}/exec`, { command: `timeout --kill-after=5 ${CHECK_SECONDS} sh -c ${q(command)}` }, { timeout: CHECK_SECONDS + 60 });
    } catch (e) {
      const words = e instanceof AgentHostError ? `the brain answered: ${brainWords(e)}` : `no answer came: ${(e as Error).message}`;
      throw new PreparationUnknown(hideAll(`A pool command on agent ${id} may still be running there; ${words}`, this.options.hide));
    }
    if (out.exitCode !== 0) throw new TaskFailed('pool_command_failed', `A pool command on agent ${id} ended with exit ${out.exitCode}.\n${REMOTE}\n${hideAll(out.stdout + out.stderr, this.options.hide).slice(-1000) || '(no output)'}`);
    return out.stdout.trim();
  }

  private async fingerprint(id: string, workdir: string, host = this.host): Promise<string> {
    const value = await this.command(id, fingerprintCommand(workdir), host);
    if (!/^[0-9a-f]{64}$/.test(value)) throw new TaskFailed('pool_fingerprint_unreadable', `the clone on agent ${id} did not return a fingerprint; no task was sent`);
    return value;
  }

  private async make(p: Pool): Promise<Member> {
    p.createUnknown = true;
    this.save(p);
    const t = p.template;
    let agent;
    try {
      agent = await this.host.agents.create({ name: `hoppy-pool-${p.name}-${randomBytes(4).toString('hex')}`, harness: t.harness, ...(t.image ? { image: t.image } : {}), ...(t.model ? { model: t.model } : {}), ...(t.instructions ? { instructions: t.instructions } : {}), tokenCap: t.token_cap, lightSleepSeconds: t.awake ? 0 : 30, deepSleepSeconds: 60 } as CreateAgent);
    } catch (e) {
      if (e instanceof AgentHostError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) { p.createUnknown = false; this.save(p); }
      throw e;
    }
    const row: Member = { agentId: agent.id, fingerprint: null, conversations: [], task: null, wakeMs: null, error: null };
    p.agents.push(row);
    p.createUnknown = false;
    this.save(p);
    const fresh = this.patient();
    try {
      if (agent.tokenCap !== t.token_cap) throw new TaskRefused('cap_not_confirmed', 'the brain did not confirm the pool token cap; no setup or task was sent');
      if (agent.harness?.id !== t.harness) throw new TaskRefused('usage', 'the created harness differs from the pool memory cleanup rule');
      const error = await cloneRepo(fresh, agent.id, t.repo, t.workdir, this.options);
      if (error) throw new TaskFailed('pool_setup_failed', `The pool clone on agent ${agent.id} failed.\n${REMOTE}\n${error}`);
      for (const check of [t.setup, t.check].filter(Boolean)) {
        const result = await runCheck(fresh, { agentId: agent.id, workdir: t.workdir, check: check!, checkSeconds: CHECK_SECONDS }, this.options.hide);
        if (!result) throw new TaskFailed('pool_setup_failed', `The pool setup or check on agent ${agent.id} could not run: the agent could not be reached for it.`);
        if (result.exitCode !== 0) throw new TaskFailed('pool_setup_failed', `The pool setup or check on agent ${agent.id} failed${result.notRun ? ', not run' : `, exit ${result.exitCode}`}.\n${REMOTE}\n${result.output || '(no output)'}`);
      }
      // The connector rewrites the workspace instructions when the agent starts (its '- Git:' line), so
      // the fingerprint is taken after a start, as each claim's wake is one.
      await this.host.agents.restart(agent.id);
      row.fingerprint = await this.fingerprint(agent.id, t.workdir, fresh);
      if (!t.awake) await this.host.agents.sleep(agent.id, 'deep');
      this.save(p);
      return row;
    } catch (e) {
      row.error = hideAll(String((e as Error).message), this.options.hide);
      row.fingerprint = null;
      this.save(p);
      // The words are hidden; the kind of failure keeps its own code.
      if (e instanceof TaskRefused) throw new TaskRefused(e.code, row.error);
      if (e instanceof AgentHostError) throw new AgentHostError(e.status, e.code, row.error);
      throw new TaskFailed(e instanceof TaskFailed && e.code !== 'preparation_unknown' ? e.code : 'pool_setup_failed', row.error);
    }
  }

  async fill(name: string, given: unknown, size = 2): Promise<Pool> {
    const template = templateOf(given, this.options);
    if (!Number.isInteger(size) || size < 1 || size > 50) throw new TaskRefused('usage', 'pool size must be a whole number from 1 to 50');
    nameOf(name, this.options);
    return this.serial(name, async accountId => {
      const p = this.read(name, accountId) ?? { v: 1, name, brain: this.host.url, accountId, template, size, agents: [], createUnknown: false };
      if (p.agents.length && JSON.stringify(p.template) !== JSON.stringify(template)) throw new TaskRefused('usage', 'pool template changed; drain this pool or choose a new name');
      if (p.createUnknown) throw new TaskRefused('usage', 'a pool create answer was lost; inspect the account before filling again; hoppy will not guess ids from names');
      if (p.agents.some(a => a.error || !a.fingerprint)) throw new TaskRefused('usage', 'pool has failed agents; drain them before filling again');
      p.template = template;
      p.size = size;
      this.save(p);
      const failed: { agentId: string; error: unknown }[] = [];
      while (p.agents.length < size) {
        const before = p.agents.length;
        try { await this.make(p); }
        catch (e) {
          // A create that failed made no agent: stop. One made agent that failed is kept for drain while the rest fill.
          if (p.agents.length === before) throw e;
          failed.push({ agentId: p.agents.at(-1)!.agentId, error: e });
        }
      }
      if (failed.length) {
        const first = failed[0].error as Error & { code?: string };
        if (failed.length === size) throw first;
        throw new TaskFailed('pool_setup_failed', `pool ${name}: ${size - failed.length} of ${size} agents ready; ${failed.map(f => f.agentId).join(', ')} failed and ${failed.length === 1 ? 'is' : 'are'} kept for hoppy pool drain. First failure: ${first.message}`);
      }
      return p;
    });
  }

  async list() {
    const account = await this.account();
    const folder = join(this.options.dir, 'pools');
    if (!existsSync(folder)) return [];
    const prefix = this.prefix(account) + '-';
    const pools = readdirSync(folder).filter(f => f.startsWith(prefix) && f.endsWith('.json')).map(f => this.read(f.slice(prefix.length, -5), account)!);
    return Promise.all(pools.map(async p => {
      const agents = await Promise.all(p.agents.map(async row => {
        const standing = await this.standing(row);
        return { ...row, status: standing ?? (agentClaimed(this.options, row.agentId) ? 'busy' : row.error || !row.fingerprint ? 'failed' : 'ready') };
      }));
      const ids = agents.filter(a => a.status === 'gone').map(a => a.agentId);
      // Shown as gone this once, then dropped, so a pool never keeps an agent the brain has no more.
      if (ids.length) await this.locked(p.name, account, async () => {
        const now = this.read(p.name, account);
        if (!now) return;
        now.agents = now.agents.filter(a => !ids.includes(a.agentId));
        this.save(now);
      });
      return { ...p, agents };
    }));
  }

  assign(input: TaskInput): Promise<Assigned> {
    return this.serial(input.pool!, async account => {
      const p = this.read(input.pool!, account);
      if (!p) throw new TaskRefused('usage', 'no such pool for this brain and account on this computer');
      const { pool: _pool, ...task } = input;
      const wanted = { ...task, agentId: 'pending', repo: task.repo ?? p.template.repo, workdir: task.workdir ?? p.template.workdir, tokenCap: task.tokenCap ?? p.template.token_cap };
      const prepared = prepareTask(wanted, this.options);
      if (prepared.clone?.url !== p.template.repo || posix.normalize(prepared.workdir) !== p.template.workdir) throw new TaskRefused('usage', 'a pool task must use the pool repository and workdir');
      const candidates = [...p.agents];
      const replacements = new Set<string>();
      let capUsed = 0;
      for (const row of candidates) {
        if (!row.fingerprint || row.error) continue;
        try {
          return await assignTask(this.host, { ...wanted, agentId: row.agentId }, { ...this.options, taskCreated: undefined, prepareAgent: async rec => {
            if (await this.dirty(row)) throw new Dirty();
            // Read before the wake and reset: the task would only be refused token_cap_reached after them.
            const agent = await this.host.agents.get(row.agentId);
            if (typeof agent.tokenCap === 'number' && wholeCount(agent.tokensUsed) && agent.tokenCap - agent.tokensUsed < CAP_MIN) throw new CapUsed();
            row.task = rec.task;
            this.save(p);
            const began = Date.now();
            await this.host.agents.wake(row.agentId);
            row.wakeMs = Date.now() - began;
            this.save(p);
            if (await this.fingerprint(row.agentId, p.template.workdir) !== row.fingerprint) {
              if (replacements.has(row.agentId)) {
                row.error = `the replacement clone on agent ${row.agentId} changed before its first task; drain it and check the template before filling again`;
                this.save(p);
                throw new TaskFailed('pool_clone_changed', row.error);
              }
              await this.host.agents.delete(row.agentId);
              p.agents = p.agents.filter(a => a !== row);
              this.save(p);
              throw new Refilled();
            }
            holdPreparation(this.options, rec);
            await this.command(row.agentId, resetCommand(p.template.workdir, p.template.harness, rec.branch ?? `hoppy/task-${rec.task}`));
            row.conversations.push({ id: rec.conversationId, messageId: rec.messageId });
            rec.pool = p.name;
            this.save(p);
            this.options.taskCreated?.(rec);
          } });
        } catch (e) {
          if (e instanceof PreparationUnknown) { row.error = e.message; this.save(p); throw e; }
          if (e instanceof Refilled) {
            const replacement = await this.make(p);
            replacements.add(replacement.agentId);
            candidates.push(replacement);
            continue;
          }
          if (e instanceof CapUsed) { capUsed++; continue; }
          if (e instanceof Dirty || (e instanceof TaskRefused && e.code === 'agent_busy')) continue;
          throw e;
        }
      }
      if (capUsed) throw new TaskRefused('token_cap_reached', `token_cap_reached: the free agents in pool ${p.name} have used their token cap (${capUsed} with under ${CAP_MIN} tokens left); no task was sent. Raise the template's token_cap, or drain and refill the pool (hoppy pool drain ${p.name}, then hoppy pool fill).`);
      throw new TaskRefused('agent_busy', `no free agent in pool ${p.name}; busy, dirty or failed agents were left alone`);
    });
  }

  drain(name: string): Promise<Pool> {
    return this.serial(name, async account => {
      const p = this.read(name, account);
      if (!p) throw new TaskRefused('usage', 'no such pool for this brain and account on this computer');
      const forget = (row: Member) => { p.agents = p.agents.filter(a => a !== row); this.save(p); };
      for (const row of [...p.agents]) {
        const standing = await this.standing(row);
        if (standing === 'gone') { forget(row); continue; }
        if (standing === 'dirty') continue;
        if (row.task && agentClaimed(this.options, row.agentId)) await taskResult(this.host, row.task, this.options);
        const unlock = await lockLocal(this.options, row.agentId);
        try {
          if (agentClaimed(this.options, row.agentId)) continue;
          const now = await this.standing(row);
          if (now === 'dirty') continue;
          if (now !== 'gone') {
            try { await this.host.agents.delete(row.agentId); }
            catch (e) { if (!(e instanceof AgentHostError && e.status === 404)) throw e; }
          }
          forget(row);
        } finally { unlock(); }
      }
      // An empty record has nothing left to drain, and a fill under its name starts a new one.
      if (!p.agents.length && !p.createUnknown) unlinkSync(this.path(name, account));
      return p;
    });
  }
}
