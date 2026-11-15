/** Local fleet runs. Only ids returned by batch create can enter a run's deletion list. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentHostError, type AgentHost, type CreateAgent } from '../typescript/src/index.ts';
import { hiddenValue } from './hidden.ts';
import { POOL_NAME } from './pool.ts';
import { assignTask, lockLocal, DEFAULT_TASK_TOKENS, hideAll, prepareTask, REMOTE, TaskRefused, taskResult, taskTokenCap, waitTasks, type TaskInput, type TaskOptions, type TaskResult, type WaitOptions } from './task.ts';

/** A wait that is still running: how long it may hold for a task's final cost before it returns. */
type Waiting = { signal?: AbortSignal; untilMs: number; progress?: (line: string) => void };

/**
 * Text with no "call task_result again": a saved fleet result is what task_result gives from then on,
 * and a deleted agent has nothing more to read. A kept agent (a pool or keep fleet) whose cap restore
 * failed still holds its task cap and lock, and the next assign or pool claim on it tries again, so
 * that line says so instead.
 */
const final = (text: string, kept = false) => (kept ? text.replace(/^(Could not restore the earlier cap: .*)\. Call task_result again\.$/m, '$1. The next assign or pool claim on this agent tries again.') : text).replace(/[;:,]?\s*\.?\s*[Cc]all task_result again[^.\n]*\./g, '.');

/**
 * The line saying a cap was left as it is (under 1,000 tokens left, changed while the task ran, or no
 * longer this task's lock), which means nothing for an agent the fleet deletes. The value keeps it. A
 * failed restore ("Could not restore") stays in the text: it says the brain refused or did not answer.
 */
const leftAsIs = (line: string, result: TaskResult) => typeof result.value.capRestoreError === 'string' && line === result.value.capRestoreError && !line.startsWith('Could not restore');

const ID = /^[0-9a-f]{12}$/;
const taskFields = ['goal', 'repo', 'workdir', 'files', 'check', 'returns', 'check_seconds', 'token_cap', 'push'];
const createFields = ['harness', 'image', 'model', 'instructions'];
type Row = { index: number; agentId: string | null; tokenCap: number; capEcho: number | null; task: string | null; messageId: string | null; result: TaskResult | null; deleted: boolean; cleanupError: string | null };
export type FleetRun = { v: 1; run: string; brain: string; accountId: string; keep: boolean; pool?: string; created: string; ended: string | null; createUnknown: boolean; agents: Row[]; tasks: string[] };

function object(value: unknown, fields: string[], name: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskRefused('usage', `${name} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new TaskRefused('usage', `${name} has an unknown field; see hoppy fleet run in the CLI guide`);
  return value as Record<string, any>;
}

function inputs(given: unknown, o: TaskOptions) {
  const s = object(given, ['template', 'tasks', 'keep', 'pool'], 'fleet');
  if (s.pool !== undefined && (typeof s.pool !== 'string' || !POOL_NAME.test(s.pool))) throw new TaskRefused('usage', 'pool must be a local pool name: 1 to 12 lowercase letters, digits, underscores or hyphens');
  const template = object(s.template ?? (s.pool ? {} : undefined), [...(s.pool ? [] : createFields), ...taskFields.filter(f => f !== 'goal')], 'template');
  if (!Array.isArray(s.tasks) || s.tasks.length < 1 || s.tasks.length > 50) throw new TaskRefused('usage', 'a fleet needs 1 to 50 tasks in one batch');
  if (s.keep !== undefined && typeof s.keep !== 'boolean') throw new TaskRefused('usage', 'keep must be true or false');
  if (!s.pool && !template.harness && !template.image) throw new TaskRefused('usage', 'template needs harness or image');
  const create: Record<string, string> = {};
  for (const field of createFields) {
    if (template[field] === undefined) continue;
    if (typeof template[field] !== 'string' || !template[field].trim()) throw new TaskRefused('usage', `template ${field} must be text`);
    create[field] = template[field];
  }
  // Check before saving or creating: a template can carry instructions as well as task fields.
  const text = JSON.stringify(s);
  if (JSON.stringify(hiddenValue(s, value => hideAll(value, o.hide))) !== text) throw new TaskRefused('key_refused', 'a fleet field looks like a key or token; give secrets as agent settings, never in a fleet spec');
  const tasks = s.tasks.map((value: unknown) => {
    const row = object(value, taskFields, 'task');
    const a = { ...template, ...row };
    for (const field of ['goal', 'repo', 'workdir', 'check', 'returns']) if (a[field] !== undefined && typeof a[field] !== 'string') throw new TaskRefused('usage', `${field} must be text`);
    const task: TaskInput = { agentId: 'pending', goal: a.goal, repo: a.repo, workdir: a.workdir, files: a.files, check: a.check, returns: a.returns, checkSeconds: a.check_seconds, tokenCap: taskTokenCap(a.token_cap === undefined ? DEFAULT_TASK_TOKENS : a.token_cap), push: a.push };
    prepareTask({ ...task, repo: task.repo ?? (s.pool ? 'pending/repo' : undefined) }, o);
    return task;
  });
  return { create, tasks, keep: s.keep === true, pool: s.pool as string | undefined };
}

function records(dir: string): FleetRun[] {
  const folder = join(dir, 'fleets');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(f => /^[0-9a-f]{12}\.json$/.test(f)).map(f => {
    const refused = new TaskRefused('usage', `fleet file ${join(folder, f)} cannot be read; no agents were deleted. Check that run in the dashboard, then move the file away`);
    let r: FleetRun;
    try { r = JSON.parse(readFileSync(join(folder, f), 'utf8')) as FleetRun; } catch { throw refused; }
    if (r?.v !== 1 || `${r.run}.json` !== f || !Array.isArray(r.agents)) throw refused;
    return r;
  });
}

/** Startup reminder only. It never changes agents or reads the saved task output. */
export function unfinishedFleets(dir: string): string | null {
  // A reminder must never block the command it is printed before, fleet clean included.
  let runs: string[];
  try { runs = records(dir).filter(r => !r.ended).map(r => r.run); } catch (e) { return (e as Error).message; }
  return runs.length ? `Unfinished fleets: ${runs.join(', ')}. Use hoppy fleet list and hoppy fleet clean <run>.` : null;
}

/** One CLI command or MCP session; close cleans only the runs this instance started. */
export class FleetManager {
  host: AgentHost;
  options: TaskOptions;
  owned = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(host: AgentHost, options: TaskOptions) { this.host = host; this.options = options; }

  private serial<T>(run: string, f: () => Promise<T>): Promise<T> {
    const locked = async () => {
      const unlock = await lockLocal(this.options, `fleet-${run}`);
      try { return await f(); } finally { unlock(); }
    };
    const next = this.pending.then(locked, locked);
    this.pending = next.catch(() => {});
    return next;
  }

  private async account(write = false) {
    const me = await this.host.me();
    if (!me.accountId || (write && (me.role === 'viewer' || !me.scopes.includes('agents')))) throw new AgentHostError(403, 'missing_scope', 'this member or key cannot change agents');
    return me.accountId;
  }

  private save(r: FleetRun) {
    const folder = join(this.options.dir, 'fleets');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, `${r.run}.json`);
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify(r) + '\n', { mode: 0o600 });
    renameSync(temp, file);
  }

  async list(): Promise<FleetRun[]> {
    const saved = records(this.options.dir);
    if (!saved.length) return [];
    const account = await this.account();
    return saved.filter(r => r.brain === this.host.url && r.accountId === account);
  }

  private failure(row: Row, code: string, error: unknown): TaskResult {
    const message = hideAll(String((error as Error)?.message ?? error), this.options.hide);
    return { text: `${REMOTE}\nFleet task ${row.index + 1}: failed, ${code}. ${message}`, value: { task: row.task, agentId: row.agentId, status: 'failed', failedBecause: code, check: null, cost: null, error: { code: (error as AgentHostError)?.code ?? code, message } } };
  }

  start(given: unknown, signal?: AbortSignal): Promise<FleetRun> {
    const run = randomBytes(6).toString('hex');
    return this.serial(run, async () => {
      const spec = inputs(given, this.options);
      const accountId = await this.account(true);
      signal?.throwIfAborted();
      const r: FleetRun = { v: 1, run, brain: this.host.url, accountId, keep: spec.keep, ...(spec.pool ? { pool: spec.pool } : {}), created: new Date().toISOString(), ended: null, createUnknown: !spec.pool, agents: [], tasks: [] };
      this.save(r);
      this.owned.add(r.run);
      try {
        // Never abort or retry create: its answer is the only safe source of ids for cleanup.
        const made = spec.pool ? [] : await this.host.agents.createMany(spec.tasks.map((t, i) => ({ ...spec.create, name: `hoppy-fleet-${r.run}-${i + 1}`, tokenCap: t.tokenCap } as CreateAgent)));
        r.agents = spec.tasks.map((t, index) => {
          const created = made[index];
          const row: Row = { index, agentId: created?.ok ? created.agent.id : null, tokenCap: t.tokenCap!, capEcho: created?.ok ? created.agent.tokenCap ?? null : null, task: null, messageId: null, result: null, deleted: false, cleanupError: null };
          if (spec.pool) return row;
          if (!created?.ok) row.result = this.failure(row, 'not_created', created?.error ?? new Error('the brain gave no create result'));
          else if (row.capEcho !== row.tokenCap) row.result = this.failure(row, 'cap_not_confirmed', new Error('the brain did not confirm the create token cap; no task was sent'));
          return row;
        });
        r.createUnknown = false;
        this.save(r);
        for (const row of r.agents) {
          if (signal?.aborted) break;
          if ((!row.agentId && !spec.pool) || row.result) continue;
          try {
            await assignTask(this.host, { ...spec.tasks[row.index], agentId: spec.pool ? undefined : row.agentId!, ...(spec.pool ? { pool: spec.pool } : {}) }, { ...this.options, signal, taskCreated: task => {
              row.agentId = task.agentId;
              row.task = task.task;
              row.messageId = task.messageId;
              r.tasks.push(task.task);
              this.save(r);
            } });
          } catch (e) {
            row.result = this.failure(row, 'not_sent', e);
          }
          this.save(r);
        }
        if (signal?.aborted) await this.cleanup(r, false);
        else if (r.agents.every(a => a.result)) await this.finish(r);
        return r;
      } catch (e) {
        if (e instanceof AgentHostError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) r.createUnknown = false;
        await this.cleanup(r, false);
        throw e;
      }
    });
  }

  private async total(agent: string) {
    const cost = { modelCalls: 0, promptTokens: 0, completionTokens: 0, scope: 'agent' };
    const cursors = new Set<string>();
    let before: string | null = null;
    try {
      do {
        const page: { calls: { inputTokens: number | null; outputTokens: number | null }[]; nextBefore: string | null } = await this.host.request('GET', `/v1/agents/${encodeURIComponent(agent)}/model-calls?limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`);
        for (const c of page.calls) { cost.modelCalls++; cost.promptTokens += c.inputTokens ?? 0; cost.completionTokens += c.outputTokens ?? 0; }
        before = page.nextBefore;
        if (before && cursors.has(before)) return null;
        if (before) cursors.add(before);
      } while (before);
      return cost;
    } catch { return null; }
  }

  /**
   * Saves a task's final result, then deletes the fleet's agent when every task has one. A cost read
   * before it is settled is provisional, and the agent cannot be read after it is deleted, so a wait
   * still running holds until the cost settles (the agent is idle by then) and reads the result again;
   * anything else gets the result back unsaved, with the time to collect it.
   */
  private async collect(task: string, result: TaskResult, waiting?: Waiting): Promise<TaskResult> {
    const found = (await this.list()).find(r => r.tasks.includes(task));
    if (!found) return result;
    const saved = found.agents.find(a => a.task === task)?.result;
    if (saved) return saved;
    const ended = result.value.status !== 'running' && result.value.status !== 'unknown';
    const at = typeof result.value.costSettlesAt === 'string' ? Date.parse(result.value.costSettlesAt) : NaN;
    if (ended && result.value.costSettled === false && Number.isFinite(at)) {
      const what = found.pool ? 'releasing' : found.keep ? 'keeping' : 'deleting';
      if (waiting && at <= waiting.untilMs && !waiting.signal?.aborted) {
        waiting.progress?.(`task ${task} ended; waiting until ${new Date(at).toISOString()} for its final cost before ${what} its agent`);
        try { await sleep(Math.max(0, at - Date.now()), undefined, { signal: waiting.signal }); }
        catch { return result; }
        try { result = await taskResult(this.host, task, this.options); }
        catch (e) { if (!(e instanceof TaskRefused && e.code === 'agent_busy')) throw e; }
      }
      if (result.value.costSettled === false) {
        const line = `Fleet ${found.run}: agent ${result.value.agentId} is kept until this task's final cost can be read, from ${new Date(at).toISOString()}; call wait with this task again from then to collect it${what === 'deleting' ? ' and delete the agent' : ''}.`;
        return { text: `${REMOTE}\n${line}\n${result.text.slice(REMOTE.length + 1)}`, value: { ...result.value, fleetHeldUntil: new Date(at).toISOString() } };
      }
    }
    return this.serial(found.run, async () => {
      const r = (await this.list()).find(r => r.run === found.run)!;
      const row = r.agents.find(a => a.task === task)!;
      if (row.result) return row.result;
      if (result.value.status === 'running' || result.value.status === 'unknown') return result;
      if (r.pool) row.result = { text: final(result.text, true), value: result.value };
      else {
        const cost = await this.total(row.agentId!);
        const text = final(result.text.split('\n').filter(l => !l.startsWith('Cost:') && (r.keep || !leftAsIs(l, result))).join('\n'), r.keep);
        row.result = { text: `${REMOTE}\n${cost ? `Whole fleet agent cost: ${cost.modelCalls} model calls, ${cost.promptTokens} prompt and ${cost.completionTokens} completion tokens.` : 'Whole fleet agent cost could not be read.'}\n${text.slice(REMOTE.length + 1)}`, value: { ...result.value, cost } };
      }
      this.save(r);
      if (r.agents.every(a => a.result)) await this.finish(r);
      return row.result;
    });
  }

  async result(task: string): Promise<TaskResult> {
    const saved = (await this.list()).flatMap(r => r.agents).find(a => a.task === task)?.result;
    return saved ?? this.collect(task, await taskResult(this.host, task, this.options));
  }

  async wait(tasks: string[], w: WaitOptions): Promise<TaskResult> {
    if (!Array.isArray(tasks) || !tasks.length || tasks.some(t => typeof t !== 'string' || !ID.test(t)) || new Set(tasks).size > 50) throw new TaskRefused('usage', 'wait needs 1 to 50 task ids');
    if (w.until !== undefined && !['any', 'all'].includes(w.until)) throw new TaskRefused('usage', 'until must be any or all');
    const untilMs = Date.now() + w.timeoutMs;
    const runs = (await this.list()).filter(r => r.tasks.some(t => tasks.includes(t)));
    if (!runs.length) return waitTasks(this.host, tasks, w, this.options);
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      cancellation ??= Promise.all(runs.map(r => this.clean(r.run, false)));
      cancellation.catch(() => {});
    };
    w.signal?.addEventListener('abort', cancel, { once: true });
    if (w.signal?.aborted) cancel();
    try {
      const cached = new Map(runs.flatMap(r => r.agents.filter(a => a.task && a.result).map(a => [a.task!, a.result!] as const)));
      const fresh = tasks.filter(t => !cached.has(t));
      const read = fresh.length ? await waitTasks(this.host, fresh, { ...w, ...(w.until === 'any' && tasks.some(t => cached.has(t)) ? { timeoutMs: 0 } : {}) }, this.options) : null;
      const results: TaskResult[] = [];
      for (const task of [...new Set(tasks)]) {
        const value = read?.value.tasks.find((v: any) => v.task === task);
        results.push(cached.get(task) ?? await this.collect(task, value.status === 'running' || value.status === 'unknown' ? { value, text: `${REMOTE}\nTask ${task}: ${value.status}.` } : await taskResult(this.host, task, this.options), { signal: w.signal, untilMs, progress: w.progress }));
      }
      await cancellation;
      const latest = (await this.list()).filter(r => runs.some(wanted => wanted.run === r.run));
      const fleets = latest.map(r => ({ run: r.run, ended: r.ended, keep: r.keep, pool: r.pool, cleanupErrors: r.agents.filter(a => a.cleanupError).map(a => ({ agentId: a.agentId, error: a.cleanupError })) }));
      const held = (run: FleetRun | undefined) => results.filter(x => x.value.fleetHeldUntil && run?.tasks.includes(x.value.task)).map(x => x.value.fleetHeldUntil as string).sort().at(-1);
      const unfinished = (run: string) => {
        const until = held(latest.find(r => r.run === run));
        return until ? `unfinished, waiting for final costs; call wait with its tasks again from ${until}, or hoppy fleet clean ${run} to delete its agents now` : `unfinished; hoppy fleet clean ${run}`;
      };
      const lines = [REMOTE, ...results.map(r => `- Task ${r.value.task}: ${r.value.status}.`), ...fleets.map(r => `Fleet ${r.run}: ${r.ended ? r.pool ? 'ended, pool agents retained' : r.keep ? 'ended, agents kept' : 'ended, agents deleted' : unfinished(r.run)}`)];
      return { text: [...lines, ...results.map(r => r.text.slice(REMOTE.length + 1))].join('\n'), value: { ...(read?.value ?? { until: w.until ?? 'all', timedOut: false, seconds: 0 }), tasks: results.map(r => r.value), fleets } };
    } finally {
      w.signal?.removeEventListener('abort', cancel);
      await cancellation;
    }
  }

  private async finish(r: FleetRun) {
    if (r.keep || r.pool) { r.ended = new Date().toISOString(); this.save(r); }
    else await this.cleanup(r, false);
  }

  private async cleanup(r: FleetRun, explicit: boolean) {
    if (r.keep && !explicit) return;
    for (const row of r.agents) {
      if (!row.agentId || row.deleted) continue;
      row.cleanupError = null;
      if (row.messageId && !row.result) {
        try { await this.host.agents.cancel(row.agentId, row.messageId); }
        catch (e) { if (!(e instanceof AgentHostError && [404, 409].includes(e.status))) row.cleanupError = hideAll(String((e as Error).message), this.options.hide); }
      }
      // Borrowed agents belong to the pool. Their next claim settles any owed check and cap.
      if (r.pool) {
        if (!row.result && !row.cleanupError) row.result = this.failure(row, 'cancelled', new Error('the pool fleet was cancelled before its result was collected'));
        this.save(r);
        continue;
      }
      try { await this.host.agents.delete(row.agentId); row.deleted = true; row.cleanupError = null; }
      catch (e) {
        if (e instanceof AgentHostError && e.status === 404) row.deleted = true;
        else row.cleanupError = hideAll(String((e as Error).message), this.options.hide);
      }
      if (row.deleted && !row.result) row.result = this.failure(row, 'cancelled', new Error('the fleet was cleaned before its result was collected'));
      this.save(r);
    }
    r.ended = !r.createUnknown && r.agents.every(a => !a.agentId || (r.pool ? !a.cleanupError : a.deleted)) ? new Date().toISOString() : null;
    this.save(r);
  }

  clean(run: string, explicit = true): Promise<FleetRun> {
    if (!ID.test(run)) throw new TaskRefused('usage', 'give the run id from hoppy fleet list');
    return this.serial(run, async () => {
      await this.account(true);
      const r = (await this.list()).find(r => r.run === run);
      if (!r) throw new TaskRefused('usage', 'no such fleet for this brain and account on this computer');
      await this.cleanup(r, explicit);
      return r;
    });
  }

  async close(): Promise<void> {
    await this.pending;
    // One failed run must not leave the later ones running; the first error is still reported.
    const errors: unknown[] = [];
    for (const run of this.owned) await this.clean(run, false).catch(e => errors.push(e));
    if (errors.length) throw errors[0];
  }
}
