/**
 * The agent host from TypeScript: agents, chat, files, conversations, settings, keys and more, over
 * the host's HTTP API. No dependencies: it needs only fetch and Web Crypto, so it runs in Node 22+,
 * Deno, Bun, browsers and edge runtimes.
 *
 *   const host = new AgentHost({ url: 'https://agents.example.com', apiKey: process.env.AGENT_HOST_KEY });
 *   const agent = await host.agents.create({ name: 'support', harness: 'hermes' });
 *   const { response } = await host.agents.chat(agent.id, 'Summarise the open tickets');
 *
 * Or watch the reply as it is written:
 *
 *   const reply = host.agents.stream(agent.id, 'Summarise the open tickets');
 *   for await (const e of reply) process.stdout.write(e.kind === 'response.output_text.delta' ? String(e.delta) : '');
 *   const { response } = await reply.final();
 */

import { EventsNotServed, LiveReader, StreamError, type LiveOptions, type MessageRecord } from './stream.ts';

export { CALL_TRIES, EVENTS_NEVER_SERVED, EventsNotServed, fold, HEARTBEAT_DEAD_MS, isRestarted, LiveReader, newTurn, REDIAL_MS, StreamError } from './stream.ts';
export type { AgentEvent, LiveOptions, MessageRecord, RestartedEvent, TextPart, ToolStep, Turn, TurnItem } from './stream.ts';

export type AgentState = 'running' | 'paused' | 'stopped';

/** An agent's computer use: whether it is on, the desktop it uses, and whether that desktop is another agent's. */
export type ComputerUse = { enabled: boolean; desktopId: string | null; state: AgentState | null; shared: boolean };

export type Agent = {
  id: string;
  name: string;
  image: string;
  state: AgentState;
  lightSleepSeconds: number;
  deepSleepSeconds: number;
  /** Brain token limit and use since it was set; absent on older hosts. Null removes the cap. */
  tokenCap?: number | null;
  tokensUsed?: number;
  baseAgentId: string | null;
  externalUserId: string | null;
  harness: { id: string; name: string; version: string | null } | null;
  model: string | null;
  site: { port: number; public: boolean } | null;
  /** The size it asked for, which every machine of it is made at; null only for an agent from before records kept one. */
  size: { cpus: number; memoryMb: number; diskMb: number } | null;
  ownerId: string | null;
  lastActiveAt: string;
  createdAt: string;
};

export type CreateAgent = {
  name: string;
  /** A harness from host.harnesses(), such as "hermes"; or give image instead. */
  harness?: string;
  /** A Docker image that answers the agent contract (GET /health, POST /chat). */
  image?: string;
  /** A model id, or "auto" for the host to choose per call. */
  model?: string;
  instructions?: string;
  env?: Record<string, string>;
  cpus?: number;
  memoryMb?: number;
  /** The size of its /data disk in MB, 1024 to 10240 (the default). */
  diskMb?: number;
  /** 0 keeps the agent always awake. */
  lightSleepSeconds?: number;
  deepSleepSeconds?: number;
  tokenCap?: number | null;
  site?: { port: number; public: boolean };
};

/** A file a message wrote or changed under /data/outbox or /data/workspace; read it with host.files.read. */
export type ProducedFile = { path: string; size: number; modifiedAt: string };
export type ChatReply = { messageId: string; response: string; files: ProducedFile[]; conversationId?: string };
export type Resized = { agent: Agent; applied: boolean; waitingForIdle: boolean; restartBy: string | null };
export type ExecResult = { exitCode: number; stdout: string; stderr: string };
export type FileEntry = { name: string; type: 'file' | 'dir' | 'link' | 'other'; size: number; modifiedAt: string };
export type Conversation = { id: string; source: string; title: string; createdAt: string; lastAt: string; messages: number; preview?: string; pinned?: boolean };
export type Message = { messageId: string; role: 'user' | 'agent'; text: string; status: 'done' | 'failed'; at: string; files: ProducedFile[] };
export type ChannelState = {
  kind: string;
  name: string;
  connected: boolean;
  address: string | null;
  allowed: string[];
  lastError: string | null;
  setupUrl?: string | null;
  link?: { label: string; url: string } | null;
};
export type App = { slug: string; name: string; logo: string | null; description?: string | null };
/** One tool of an app account; label is the app's own word on what it does to the account. */
export type AppTool = { name: string; description: string | null; label: 'read' | 'write' | 'destructive' };
export type AppAccount = { appAccountId: string; name: string | null; app: App; healthy: boolean; createdAt: string | null; agents: string[] };
export type Build = {
  id: string;
  agentId: string | null;
  repo: string;
  ref: string;
  dir: string | null;
  status: 'running' | 'succeeded' | 'failed';
  image: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  log?: string;
};
export type Trigger = {
  id: string;
  type: 'cron' | 'webhook';
  source: 'user' | 'agent';
  enabled: boolean;
  cron?: string;
  prompt?: string;
  nextRunAt?: string | null;
};
/** A recipe an agent wrote up after a chat that went well: what a list shows and where its file is on that agent's computer. */
export type Playbook = {
  id: string;
  agentId: string;
  name: string;
  summary: string;
  path: string;
  conversationId: string | null;
  blanks: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
};
export type Webhook = {
  id: string;
  url: string;
  events: string[];
  description: string;
  createdAt: string;
  lastDelivery: WebhookDelivery | null;
};
export type WebhookDelivery = {
  eventId: string;
  type: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastCode: number | null;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt?: string;
};
/** One delivery's body; sequence counts an agent's events in the order they happened, for receivers that need order. */
export type WebhookEvent = { id: string; type: string; createdAt: string; sequence?: number; data: Record<string, unknown> };
/**
 * A skill of an agent. On Hoppy's service Markdown its instructions carry, with its text, size,
 * last change and who added and changed it; on a standalone agent host a folder in its /data/skills. A caller
 * without the agents scope (a viewer, a read-only key) gets no text or description, and textHidden.
 * skipped is true, with skippedReason, for a stored skill the agent's instructions leave out because
 * it no longer passes the code fence rules: replace or delete it.
 */
export type Skill = {
  name: string; description?: string; source: 'built-in' | 'upload'; installedAt: string;
  bytes?: number; text?: string; textHidden?: true; updatedAt?: string; createdBy?: string | null; updatedBy?: string | null;
  skipped?: boolean; skippedReason?: string;
};
/** Whether a skill change is in the agent's running machine yet (Hoppy's service). */
export type SkillApplied = { applied: boolean; appliesAtNextStart: boolean; waitingForIdle: boolean; restartBy: string | null };
/** This SDK's version, as its package.json names it; every call sends it in User-Agent. */
export const VERSION = '0.1.0';

/** A remote MCP server whose tools reach the agent as <name>_<tool>; headers are only the names, their values never leave the host. */
export type ToolServer = { id: string; name: string; url: string; headers: string[]; tools: string[]; error: string | null; createdAt: string };
/** Every tool seen offered to or called by the agent's model, and the ones turned off. */
export type Tools = { tools: { name: string; on: boolean }[]; off: string[] };
/** One thing that happened to an agent: created, state, message.done or message.failed. */
export type Activity = { at: string; kind: string; detail: Record<string, unknown> };
/** One tool call the agent's model made, with the gist of what for. */
export type Step = { at: string; tool: string; detail: string };
/** One line of the agent's own output, as following its log gives them. */
export type LogLine = { at: string; stream: 'stdout' | 'stderr'; line: string };
/** Live figures read without waking the agent; null where its machine has none, such as a container while it sleeps. */
export type AgentStats = {
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  readAt?: string;
  invocations: number;
  /** What the agent's /data takes on its server, as last measured within 30 days, asleep or awake; disk is billed on it. Hoppy's service only. */
  diskUsedBytes?: number | null;
  /** The agent's disk size in bytes. Hoppy's service only. */
  diskLimitBytes?: number | null;
};
/** How one create of a batch ended, in the order they were sent. */
export type BatchResult = { ok: true; agent: Agent } | { ok: false; error: { code: string; message: string } };
/** Where a message stands: running, done with its response, or failed with its reason. */
export type MessageStatus = {
  messageId: string;
  status: 'running' | 'done' | 'failed';
  response: string | null;
  error: string | null;
  reason: string | null;
  files: ProducedFile[];
};
/**
 * One event of a message, in order: accepted, then done with the agent's HTTP status, or failed with
 * the error's status and code. id is <job>@<seq>; give it back as lastEventId to resume after it.
 */
export type ChatEvent = { id: string; job: string; seq: number; name: string; status?: number; error?: { status: number; code: string } };
/** Model calls over the window, as the models reported them (never the bill). */
export type Usage = {
  days: number;
  tokensAre: string;
  daily: { day: string; calls: number; failed: number; prompt_tokens: number; completion_tokens: number }[];
  byAgent: { agent_id: string; calls: number }[];
};
/** One agent's model calls over the window, or since a time, by model, and its latest failures. */
export type AgentUsage = { days: number; since?: string; tokensAre: string; models: Record<string, unknown>[]; recentFailures: Record<string, unknown>[] };
/** Who the credential is: the host's own admin token (kind operator), an API key, or a member signed in through Hopscotch, with its account, role and scopes. */
export type Caller = {
  kind: 'operator' | 'key' | 'member';
  accountId: string | null;
  role: 'admin' | 'member' | 'viewer' | null;
  scopes: string[];
  member?: Record<string, unknown> | null;
  /** For an API key, its own id, which it can revoke itself by. */
  keyId?: string;
};
export type ApiKey = { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
/** One of your own customers, by your own id for them, with the copies of your agents that are theirs. */
export type Customer = {
  accountId: string;
  externalId: string;
  displayName: string | null;
  status: 'active' | 'suspended';
  /** Model tokens a month (UTC) across their agents; null is no cap. */
  tokenCapMonthly: number | null;
  tokensThisMonth: number;
  agents: { id: string; baseAgentId: string | null; state: AgentState }[];
  createdAt: string;
};
export type CustomerScope = 'chat' | 'console' | 'logs' | 'files';
/** A short-lived eu_ token a customer's browser can use for their own agents only. */
export type CustomerToken = { token: string; expiresAt: string; scopes: CustomerScope[] };
/** A base agent's cap on customer copies, its warm pool, and how many of each it has. */
export type Serving = { maxInstances: number; warmPool: number; instances: number; warmReady: number; warmStarting: number };
/** Where a front door message stands; agentId is the customer's own copy, null while it is being made. */
export type FrontDoorMessage = {
  messageId: string;
  externalUserId: string;
  agentId: string | null;
  status: 'provisioning' | 'queued' | 'replied' | 'failed';
  reply: string | null;
  error?: string | null;
  /** Why the platform stopped it, when failed; null for a cause of the agent's own. */
  reason?: string | null;
  replayed?: boolean;
};

/** What the host answered when it refused, with its own error code, such as "agent_not_found". */
export class AgentHostError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AgentHostError';
    this.status = status;
    this.code = code;
  }
}

/** The client's options; the Python SDK takes the same ones. */
export type AgentHostOptions = {
  /** The host's address, such as https://agents.example.com. */
  url: string;
  /** An API key (ak_…) or the host token. */
  apiKey: string;
  /** A fetch to use instead of the global one, such as one with a proxy: the custom transport. */
  fetch?: typeof fetch;
  /** Seconds one call may take, its retries and their waits included, before it fails with a TimeoutError; 120 by default. A chat call waits up to 30 s for its answer on each call, so keep it above that. */
  timeout?: number;
  /** How many more times a call that cannot write twice is sent after a network error or a 5xx other than 501; 3 by default, 0 sends every call once. */
  maxRetries?: number;
};

/** The seconds a call may take when the client sets no timeout. */
export const DEFAULT_TIMEOUT = 120;
/** How many more times a safe call is sent when the client sets no maxRetries. */
export const DEFAULT_MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How often chat() checks a message's record when the brain will not serve this caller its stream. */
const CHECK_MS = 2000;
/** Waits ms, or rejects with the signal's reason as soon as it aborts. */
const pause = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
/**
 * The wait before try number attempt + 2: 0.5 s, then 1 s, then 2 s, each up to a quarter longer
 * so many clients cut off at once do not all come back together, or longer when the host's
 * Retry-After asks for it (a draining worker does), up to a minute.
 */
const backoff = (attempt: number, res?: Response) => {
  const asked = Number(res?.headers.get('retry-after'));
  const ms = 500 * 2 ** attempt * (1 + Math.random() / 4);
  return Number.isFinite(asked) && asked > 0 ? Math.max(ms, Math.min(asked, 60) * 1000) : ms;
};
const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString();
  return s ? `?${s}` : '';
};
const seg = encodeURIComponent;
/** A chat send's body without its messageId and wait, which each caller sets. */
const chatBody = (message: string, opts: { conversationId?: string; source?: string; files?: { name: string; data: Uint8Array }[] }) => ({
  message,
  ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
  ...(opts.source ? { source: opts.source } : {}),
  ...(opts.files?.length ? { files: opts.files.map((f) => ({ name: f.name, data: base64(f.data) })) } : {}),
});
const base64 = (bytes: Uint8Array) => {
  let s = '';
  // In chunks, since spreading millions of bytes into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export class AgentHost {
  readonly url: string;
  private readonly key: string;
  private readonly doFetch: typeof fetch;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(options: AgentHostOptions) {
    if (!options?.url || !options.apiKey) throw new Error('AgentHost needs url and apiKey');
    this.url = options.url.replace(/\/+$/, '');
    this.key = options.apiKey;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * One call to the API; JSON in and out unless raw is asked for. Throws AgentHostError on a
   * refusal and a TimeoutError past its timeout (seconds, the client's unless given; null for none).
   * A call that cannot write twice is sent again after a network error or a 5xx other than 501, up
   * to the client's maxRetries, with growing waits: a GET or HEAD, one with an Idempotency-Key header, or one
   * whose caller says retry (a chat send, which carries its message id). Every other call is sent once.
   * A key makes a resend safe only on a route that runs a repeated key once (today only a webhook
   * trigger's address); every other route ignores it.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: { raw?: boolean; contentType?: string; signal?: AbortSignal; timeout?: number | null; headers?: Record<string, string>; retry?: boolean } = {}
  ): Promise<T> {
    const seconds = opts.timeout === undefined ? this.timeout : opts.timeout;
    const isBytes = body instanceof Uint8Array || body instanceof ArrayBuffer || (typeof Blob !== 'undefined' && body instanceof Blob);
    const keyed = Object.keys(opts.headers ?? {}).some((h) => h.toLowerCase() === 'idempotency-key');
    const retries = (opts.retry ?? (method === 'GET' || method === 'HEAD' || keyed)) ? this.maxRetries : 0;
    // One deadline for the whole call, so a host that keeps failing cannot stretch it past its timeout.
    // It is a timer rather than AbortSignal.timeout so a test's mocked clock can run it. Left to fire
    // after the call, it aborts nothing, and a raw answer read after this returns keeps it.
    const deadline = seconds === null ? undefined : new AbortController();
    if (deadline) {
      const timer = setTimeout(() => deadline.abort(new DOMException(`${method} ${path} took longer than ${seconds} s`, 'TimeoutError')), (seconds as number) * 1000);
      // Like AbortSignal.timeout's, it must not hold the process open.
      (timer as { unref?: () => void }).unref?.();
    }
    const signal = opts.signal && deadline ? AbortSignal.any([opts.signal, deadline.signal]) : (opts.signal ?? deadline?.signal);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(`${this.url}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.key}`,
            'User-Agent': `agent-host-typescript/${VERSION}`,
            ...(body === undefined ? {} : { 'Content-Type': opts.contentType ?? (isBytes ? 'application/octet-stream' : 'application/json') }),
            ...opts.headers,
          },
          body: body === undefined ? undefined : isBytes ? (body as BodyInit) : JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
        // A 501 says the route is not built, and no later try finds it built.
        if (res.status >= 500 && res.status !== 501 && attempt < retries) {
          await res.body?.cancel().catch(() => {});
          await pause(backoff(attempt, res), signal);
          continue;
        }
        if (!res.ok) {
          const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
          throw new AgentHostError(res.status, err?.error?.code ?? `http_${res.status}`, err?.error?.message ?? `${method} ${path} answered ${res.status}`);
        }
        if (opts.raw) return res as T;
        return (res.status === 204 ? null : await res.json()) as T;
      } catch (e) {
        // A timeout or the caller's own abort ends the call; only a lost connection is tried again.
        if (e instanceof AgentHostError || signal?.aborted || attempt >= retries) throw e;
        await pause(backoff(attempt), signal);
      }
    }
  }

  /** Agents: their lifecycle, chat and commands. */
  readonly agents = {
    list: async () => (await this.request<{ agents: Agent[] }>('GET', '/v1/agents')).agents,
    get: (id: string) => this.request<Agent>('GET', `/v1/agents/${seg(id)}`),
    create: (input: CreateAgent) => this.request<Agent>('POST', '/v1/agents', input),
    /** Creates up to 50 agents in one call; one that is refused does not stop the others. */
    createMany: async (inputs: CreateAgent[]) => (await this.request<{ results: BatchResult[] }>('POST', '/v1/agents/batch', { agents: inputs })).results,
    /** Changes sleep settings or the token cap; a field left out keeps its value. Naming tokenCap resets its count. */
    update: (id: string, input: { lightSleepSeconds?: number; deepSleepSeconds?: number; tokenCap?: number | null }) => this.request<Agent>('PATCH', `/v1/agents/${seg(id)}`, input),
    delete: (id: string) => this.request<null>('DELETE', `/v1/agents/${seg(id)}`),
    wake: (id: string) => this.request<Agent>('POST', `/v1/agents/${seg(id)}/wake`),
    sleep: (id: string, stage: 'light' | 'deep' = 'light') => this.request<Agent>('POST', `/v1/agents/${seg(id)}/sleep`, { stage }),
    restart: (id: string) => this.request<Agent>('POST', `/v1/agents/${seg(id)}/restart`),
    /**
     * Gives the agent another size, within 4 CPUs, 8192 MB of memory and 10 GB of disk; a field left
     * out keeps its value. A running agent gets a new machine on the same /data once it answers no
     * message (applied and waitingForIdle say which); a sleeping one gets it at its next wake.
     */
    resize: (id: string, size: { cpus?: number; memoryMb?: number; diskMb?: number }) => this.request<Resized>('POST', `/v1/agents/${seg(id)}/resize`, size),
    /** Moves the agent to another image, or the same one rebuilt, keeping /data. */
    redeploy: (id: string, image?: string) => this.request<Agent>('POST', `/v1/agents/${seg(id)}/redeploy`, image ? { image } : {}),
    /** Runs a shell command in the agent's container. */
    exec: (id: string, command: string) => this.request<ExecResult>('POST', `/v1/agents/${seg(id)}/exec`, { command }),
    /** Turns the agent's own desktop on or off. */
    computer: (id: string, enabled: boolean) => this.request<{ enabled: boolean }>('PUT', `/v1/agents/${seg(id)}/computer`, { enabled }),
    /** Whether the agent has computer use, and the desktop it uses. */
    computerState: (id: string) => this.request<ComputerUse>('GET', `/v1/agents/${seg(id)}/computer`),
    /**
     * Sends a message and waits for the reply, however long the agent works on it. Throws
     * AgentHostError("message_failed") when the agent failed. Sending the same messageId again
     * returns the first outcome rather than asking twice, so a retry is safe. files (a Buffer works
     * as data) are saved in /data/inbox/<messageId>/ for the agent, at most 10 and 25 MB in all; the
     * reply's files are what the message wrote under /data/outbox and /data/workspace. A reply not
     * done within the send's 30 s is followed on its live stream, not polled, unless the brain
     * never serves this caller the stream (an API key gets 503 key_chat_events_unavailable on the
     * dev brain): then its record is checked every 2 s. signal stops the wait (the message runs
     * on: cancel stops it).
     */
    chat: async (
      id: string,
      message: string,
      opts: { conversationId?: string; messageId?: string; source?: string; files?: { name: string; data: Uint8Array }[]; signal?: AbortSignal } = {}
    ): Promise<ChatReply> => {
      // Made here rather than by the host, so a send tried again is the same message and runs once.
      const messageId = opts.messageId || crypto.randomUUID();
      let r: MessageRecord;
      try {
        r = await this.request<MessageRecord>('POST', `/v1/agents/${seg(id)}/chat`, { ...chatBody(message, opts), wait: 30, messageId }, { retry: true, signal: opts.signal });
      } catch (e) {
        // The host took an earlier try whose answer was lost: follow that one instead.
        if (!(e instanceof AgentHostError && e.status === 409 && e.code === 'message_in_progress')) throw e;
        r = { messageId, status: 'running', response: null };
      }
      if (r.status === 'running') {
        try {
          r = await this.live(id, { messageId, signal: opts.signal }).final();
        } catch (e) {
          if (!(e instanceof EventsNotServed)) throw e instanceof StreamError ? new AgentHostError(e.status, e.code, e.message) : e;
          // No redial will change this refusal, and the message runs on regardless: its record is
          // the one way left to learn when it is done.
          for (;;) {
            r = await this.request<MessageRecord>('GET', `/v1/agents/${seg(id)}/chat/${seg(messageId)}`, undefined, { retry: true, signal: opts.signal });
            if (r.status !== 'running') break;
            await pause(CHECK_MS, opts.signal);
          }
        }
      }
      if (r.status === 'failed') throw new AgentHostError(200, 'message_failed', r.error ?? r.response ?? 'the agent failed to answer');
      return { messageId: r.messageId, response: r.response ?? '', files: (r.files ?? []) as ProducedFile[], ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) };
    },
    /**
     * Sends a message and follows its reply as it is written: iterate it for agent events v1 as
     * they come (reply.turn folds them so far: text, tool steps, plan, status), and await
     * reply.final() for the record once it ends. Nothing is sent until it is read. It picks its own
     * messageId unless given one, so a send tried again runs once; a dropped connection resumes
     * from the last event shown, with nothing missed or shown twice. Throws StreamError with the
     * brain's code when refused. Leaving the loop leaves the message running: cancel stops it.
     */
    stream: (
      id: string,
      message: string,
      opts: { conversationId?: string; messageId?: string; source?: string; files?: { name: string; data: Uint8Array }[]; signal?: AbortSignal } = {}
    ): LiveReader => this.live(id, { messageId: opts.messageId, signal: opts.signal, send: chatBody(message, opts) }),
    /**
     * Follows a message already sent, as stream does: from its start, after an event id
     * (<job>@<seq>, an event's id), or from a snapshot of the turn so far.
     */
    attach: (id: string, messageId: string, opts: { after?: string; snapshot?: boolean; signal?: AbortSignal } = {}): LiveReader =>
      this.live(id, { messageId, ...opts }),
    /**
     * Sends a message and returns where it stands after at most wait seconds (0 by default, so at
     * once): running, or already done or failed. Check it with message, or follow it with
     * chatEvents. As with chat, the same messageId again is the same message, so a retry is safe.
     */
    send: (
      id: string,
      message: string,
      opts: { conversationId?: string; messageId?: string; source?: string; wait?: number; files?: { name: string; data: Uint8Array }[] } = {}
    ) =>
      this.request<MessageStatus>(
        'POST',
        `/v1/agents/${seg(id)}/chat`,
        {
          ...chatBody(message, opts),
          wait: opts.wait ?? 0,
          // Made here rather than by the brain, so a send tried again is the same message and runs once.
          messageId: opts.messageId || crypto.randomUUID(),
        },
        // A wait longer than the client's timeout must not cut the call short.
        { retry: true, ...(opts.wait ? { timeout: Math.max(this.timeout, opts.wait + 30) } : {}) }
      ),
    /** Where a message stands, without waiting. */
    message: (id: string, messageId: string) => this.request<MessageStatus>('GET', `/v1/agents/${seg(id)}/chat/${seg(messageId)}`),
    /**
     * Follows a message's events as they happen, until its outcome is recorded (then read it with
     * message) or signal aborts:
     *   for await (const e of await host.agents.chatEvents(id, messageId)) console.log(e.name)
     * Give the last event's id as lastEventId to resume after it, missing nothing and seeing nothing
     * twice. The client's timeout does not apply, since an agent can work a long time between events.
     */
    chatEvents: async (id: string, messageId: string, opts: { lastEventId?: string; signal?: AbortSignal } = {}): Promise<AsyncIterable<ChatEvent>> =>
      serverEvents(
        await this.request<Response>('GET', `/v1/agents/${seg(id)}/chat/${seg(messageId)}/events`, undefined, {
          raw: true,
          signal: opts.signal,
          timeout: null,
          headers: { Accept: 'text/event-stream', ...(opts.lastEventId ? { 'Last-Event-ID': opts.lastEventId } : {}) },
        })
      ),
    /** One agent's model calls over the last days (30 by default), or since a time (an ISO date) in place of days. */
    usage: (id: string, opts: { days?: number; since?: string } = {}) =>
      this.request<AgentUsage>('GET', `/v1/agents/${seg(id)}/usage${q({ days: opts.days, since: opts.since })}`),
    /** What happened to the agent, newest first: up to limit (1 to 500, 100 by default). */
    activity: async (id: string, limit?: number) => (await this.request<{ activity: Activity[] }>('GET', `/v1/agents/${seg(id)}/activity${q({ limit })}`)).activity,
    /** The tools the agent's model called, newest first; given a message id, only that message's. */
    steps: async (id: string, messageId?: string) => (await this.request<{ steps: Step[] }>('GET', `/v1/agents/${seg(id)}/steps${q({ message: messageId })}`)).steps,
    /** The last 200 lines of the agent's own output, each starting with the time it was written. */
    logs: (id: string) => this.request<{ stdout: string; stderr: string }>('GET', `/v1/agents/${seg(id)}/logs`),
    /**
     * Follows the agent's output live, line by line, until signal aborts it or the host ends it:
     *   for await (const l of await host.agents.followLogs(id)) console.log(l.line)
     * The client's timeout does not apply, since a quiet agent can go a long time without a line.
     */
    followLogs: async (id: string, opts: { signal?: AbortSignal } = {}): Promise<AsyncIterable<LogLine>> =>
      ndjson<LogLine>(await this.request<Response>('GET', `/v1/agents/${seg(id)}/logs${q({ follow: '1' })}`, undefined, { raw: true, signal: opts.signal, timeout: null })),
    /** Its CPU, memory and network use, read without waking it, and the messages it was ever sent. */
    stats: (id: string) => this.request<AgentStats>('GET', `/v1/agents/${seg(id)}/stats`),
    /** Stops a message the agent is still working on. */
    cancel: (id: string, messageId: string) => this.request('POST', `/v1/agents/${seg(id)}/chat/${seg(messageId)}/cancel`),
    env: {
      list: (id: string) => this.request<{ vars: { key: string; secret: boolean; value: string | null; updatedAt: string }[] }>('GET', `/v1/agents/${seg(id)}/env`),
      /** Sets variables; apply restarts the agent so they take effect, once it is answering no message or at the latest at the answer's restartBy (its waitingForIdle says it waits). */
      set: (id: string, vars: Record<string, string>, opts: { secret?: boolean; apply?: boolean } = {}) =>
        this.request('PUT', `/v1/agents/${seg(id)}/env`, { vars, ...opts }),
      delete: (id: string, key: string) => this.request('DELETE', `/v1/agents/${seg(id)}/env/${seg(key)}`),
    },
  };

  /** Every conversation an agent had, on every channel, with what was said. */
  readonly conversations = {
    list: async (agentId: string, limit?: number) =>
      (await this.request<{ conversations: Conversation[] }>('GET', `/v1/agents/${seg(agentId)}/conversations${q({ limit })}`)).conversations,
    get: (agentId: string, conversationId: string, limit?: number) =>
      this.request<{ conversation: Conversation; messages: Message[] }>(
        'GET',
        `/v1/agents/${seg(agentId)}/conversations/${seg(conversationId)}${q({ limit })}`
      ),
    /** Gives one conversation a name of 1 to 80 characters on one line (Hoppy's service only); answers the conversation as get does. */
    rename: (agentId: string, conversationId: string, title: string) =>
      this.request<{ conversation: Conversation; messages: Message[] }>('PATCH', `/v1/agents/${seg(agentId)}/conversations/${seg(conversationId)}`, { title }),
    /** Pins one conversation so it is listed before the unpinned ones, or unpins it with false (Hoppy's service only); answers the conversation as get does. */
    pin: (agentId: string, conversationId: string, pinned = true) =>
      this.request<{ conversation: Conversation; messages: Message[] }>('PATCH', `/v1/agents/${seg(agentId)}/conversations/${seg(conversationId)}`, { pinned }),
    /** Deletes the brain's records of one conversation: its messages and their steps, so the list, the reads and the agent's conversations tools no longer find it. The harness's own session for that conversation id and any files stay on the agent's disk, so a new message under the same id (main included) can bring the old history back to the agent. Refused with 409 conversation_busy while a message in it is being answered. */
    delete: (agentId: string, conversationId: string) =>
      this.request<null>('DELETE', `/v1/agents/${seg(agentId)}/conversations/${seg(conversationId)}`),
  };

  /** Files under the agent's /data, which survives sleep, restart and redeploy. */
  readonly files = {
    list: async (agentId: string, path = '/data') =>
      (await this.request<{ path: string; entries: FileEntry[] }>('GET', `/v1/agents/${seg(agentId)}/files${q({ path })}`)).entries,
    /** A file's bytes. */
    read: async (agentId: string, path: string) =>
      new Uint8Array(await (await this.request<Response>('GET', `/v1/agents/${seg(agentId)}/files${q({ path })}`, undefined, { raw: true })).arrayBuffer()),
    /**
     * Writes a file. With ifMtime (the file's time in ms as last seen, 0 for a file that must not
     * exist yet) it is written only over that file and the answer carries mtime, its new time;
     * otherwise the call throws 409 file_changed, whose body carries the file's time now.
     */
    write: (agentId: string, path: string, data: Uint8Array | string, opts: { ifMtime?: number } = {}) =>
      this.request<{ path: string; size: number; mtime?: number }>(
        'PUT',
        `/v1/agents/${seg(agentId)}/files${q({ path, ifMtime: opts.ifMtime })}`,
        typeof data === 'string' ? new TextEncoder().encode(data) : data
      ),
    delete: (agentId: string, path: string) => this.request<null>('DELETE', `/v1/agents/${seg(agentId)}/files${q({ path })}`),
    mkdir: (agentId: string, path: string) => this.request<{ path: string }>('POST', `/v1/agents/${seg(agentId)}/files/mkdir`, { path }),
    move: (agentId: string, from: string, to: string) => this.request<{ from: string; to: string }>('POST', `/v1/agents/${seg(agentId)}/files/move`, { from, to }),
    /** A public link to one file that works until it expires. */
    share: (agentId: string, path: string, ttlSeconds?: number) =>
      this.request<{ id: string; url: string; path: string; createdAt: string; expiresAt: string; downloads: number }>('POST', `/v1/agents/${seg(agentId)}/shares`, {
        path,
        ...(ttlSeconds ? { ttlSeconds } : {}),
      }),
  };

  /** Skills: instructions an agent follows. On Hoppy's service Markdown put into its instructions; on a standalone agent host folders, often with scripts, in /data/skills. */
  readonly skills = {
    /** The built-in skills any agent can be given by name. */
    library: async () => (await this.request<{ skills: { name: string; description: string }[] }>('GET', '/v1/skills')).skills,
    list: async (agentId: string) => (await this.request<{ skills: Skill[] }>('GET', `/v1/agents/${seg(agentId)}/skills`)).skills,
    /**
     * Adds a skill; the same name again replaces it. On Hoppy's service give `{ name, text }`,
     * a file name ending in .md and the skill in Markdown: its text goes into the agent's
     * instructions at its next start, or at once with `apply: true` once the agent is idle. On a
     * standalone agent host give a built-in skill's name, your own as a ZIP of its folder, or a SKILL.md alone;
     * the agent restarts to see it once it is answering no message.
     */
    add: (agentId: string, skill: { name: string; text: string; apply?: boolean } | { name: string } | { zip: Uint8Array } | { text: string }) =>
      this.request<Skill & SkillApplied>('POST', `/v1/agents/${seg(agentId)}/skills`, typeof skill === 'object' && 'zip' in skill ? { zip: base64(skill.zip) } : skill),
    /**
     * Takes the skill off. On Hoppy's service it leaves the agent's instructions at its next
     * start, or at once with `apply: true` once the agent is idle, and the answer says which; a
     * standalone agent host answers nothing and restarts the agent once it is answering no message.
     */
    remove: (agentId: string, name: string, opts: { apply?: boolean } = {}) =>
      this.request<({ name: string; removed: true } & SkillApplied) | null>('DELETE', `/v1/agents/${seg(agentId)}/skills/${seg(name)}${opts.apply ? '?apply=true' : ''}`),
  };

  /** Remote MCP servers whose tools an agent gets, reached by the host so their keys stay there. */
  readonly toolServers = {
    list: async (agentId: string) => (await this.request<{ servers: ToolServer[] }>('GET', `/v1/agents/${seg(agentId)}/tool-servers`)).servers,
    /** The host asks the server for its tools before keeping it, so a wrong address or key is refused now. */
    add: (agentId: string, input: { name: string; url: string; headers?: Record<string, string> }) =>
      this.request<ToolServer>('POST', `/v1/agents/${seg(agentId)}/tool-servers`, input),
    remove: (agentId: string, serverId: string) => this.request<null>('DELETE', `/v1/agents/${seg(agentId)}/tool-servers/${seg(serverId)}`),
  };

  /** Turning an agent's tools off by name, whichever harness or server offers them. */
  readonly tools = {
    list: (agentId: string) => this.request<Tools>('GET', `/v1/agents/${seg(agentId)}/tools`),
    /** The whole list of tools to turn off (up to 200); every other tool is on. */
    setOff: (agentId: string, off: string[]) => this.request<Tools>('PUT', `/v1/agents/${seg(agentId)}/tools`, { off }),
  };

  /** Ways people reach an agent: Telegram, Slack, Discord, text messages. */
  readonly channels = {
    kinds: async () => (await this.request<{ channels: Record<string, unknown>[] }>('GET', '/v1/channels')).channels,
    list: async (agentId: string) => (await this.request<{ channels: ChannelState[] }>('GET', `/v1/agents/${seg(agentId)}/channels`)).channels,
    get: (agentId: string, kind: string) => this.request<ChannelState>('GET', `/v1/agents/${seg(agentId)}/channels/${seg(kind)}`),
    /** Connects a channel with the fields it needs (such as { token } for Telegram), or updates who is allowed. */
    connect: (agentId: string, kind: string, input: Record<string, unknown> & { allowed?: string[] }) =>
      this.request<ChannelState>('PUT', `/v1/agents/${seg(agentId)}/channels/${seg(kind)}`, input),
    disconnect: (agentId: string, kind: string) => this.request<ChannelState>('DELETE', `/v1/agents/${seg(agentId)}/channels/${seg(kind)}`),
  };

  /** Accounts an agent can use, such as Gmail: connected once by a person, then granted to agents. */
  readonly apps = {
    status: () => this.request<{ available: boolean; unavailable?: string; environment?: string }>('GET', '/v1/connectors'),
    search: (query = '', opts: { limit?: number; after?: string } = {}) =>
      this.request<{ apps: App[]; total: number; next: string | null }>('GET', `/v1/connectors/apps${q({ q: query, limit: opts.limit, after: opts.after })}`),
    accounts: async () => (await this.request<{ accounts: AppAccount[] }>('GET', '/v1/connectors/accounts')).accounts,
    /** A link a person opens to connect an account; given an agent, the account is granted to it. */
    connectLink: (app: string, agentId?: string) =>
      this.request<{ url: string; expiresAt: string }>('POST', agentId ? `/v1/agents/${seg(agentId)}/connectors` : '/v1/connectors/accounts', { app }),
    disconnect: (appAccountId: string) => this.request<null>('DELETE', `/v1/connectors/accounts/${seg(appAccountId)}`),
    of: async (agentId: string) => (await this.request<{ accounts: AppAccount[] }>('GET', `/v1/agents/${seg(agentId)}/connectors`)).accounts,
    grant: (agentId: string, appAccountId: string) => this.request<AppAccount>('PUT', `/v1/agents/${seg(agentId)}/connectors/${seg(appAccountId)}`),
    revoke: (agentId: string, appAccountId: string) => this.request<null>('DELETE', `/v1/agents/${seg(agentId)}/connectors/${seg(appAccountId)}`),
    /** An account's tools as the agent would see them, each labelled read, write or destructive, granted or not. */
    tools: async (agentId: string, appAccountId: string) =>
      (await this.request<{ tools: AppTool[] }>('GET', `/v1/agents/${seg(agentId)}/connectors/${seg(appAccountId)}/tools`)).tools,
  };

  /** Building agents from a repository or from a folder you send. */
  readonly builds = {
    /** Builds a public GitHub or GitLab repository into a new agent (create) or onto one (agentId). */
    fromRepo: (input: { repo: string; ref?: string; dir?: string } & ({ create: Partial<CreateAgent> & { name: string } } | { agentId: string })) =>
      this.request<Build>('POST', '/v1/builds', input),
    /** Sends a folder (a ZIP, tar or tar.gz with its Dockerfile at the top) and builds it. */
    fromFolder: async (
      archive: Uint8Array | ArrayBuffer | Blob,
      input: { name?: string } & ({ create: Partial<CreateAgent> & { name: string } } | { agentId: string })
    ) => {
      const { name, ...target } = input;
      const up = await this.request<{ uploadId: string }>('POST', `/v1/uploads${q({ name: name ?? 'upload.zip' })}`, archive);
      return this.request<Build>('POST', '/v1/builds', { upload: up.uploadId, ...target });
    },
    get: (id: string) => this.request<Build>('GET', `/v1/builds/${seg(id)}`),
    list: async (agentId?: string) => (await this.request<{ builds: Build[] }>('GET', `/v1/builds${q({ agentId })}`)).builds,
    /** Waits for a build to finish; onLog hears each new piece of its log. Throws when it failed. */
    wait: async (id: string, opts: { onLog?: (text: string) => void; pollMs?: number } = {}) => {
      let shown = 0;
      for (;;) {
        const b = await this.request<Build>('GET', `/v1/builds/${seg(id)}`);
        if (opts.onLog && b.log && b.log.length > shown) opts.onLog(b.log.slice(shown));
        shown = b.log?.length ?? shown;
        if (b.status === 'failed') throw new AgentHostError(200, 'build_failed', b.error ?? 'the build failed');
        if (b.status === 'succeeded') return b;
        await sleep(opts.pollMs ?? 1000);
      }
    },
  };

  /** Schedules and webhook triggers that send an agent a prompt. */
  readonly schedules = {
    list: async (agentId: string) => (await this.request<{ triggers: Trigger[] }>('GET', `/v1/agents/${seg(agentId)}/triggers`)).triggers,
    /**
     * A cron schedule ("0 9 * * 1-5"), or a webhook trigger whose url anything can POST to. A
     * webhook trigger's url is in this answer only: the host keeps only a hash of its secret.
     */
    create: (agentId: string, input: { type: 'cron'; cron: string; prompt: string } | { type: 'webhook'; prompt?: string }) =>
      this.request<Trigger & { url?: string }>('POST', `/v1/agents/${seg(agentId)}/triggers`, input),
    delete: (agentId: string, triggerId: string) => this.request<null>('DELETE', `/v1/agents/${seg(agentId)}/triggers/${seg(triggerId)}`),
    /** Gives a webhook trigger a new secret: its new url is in this answer only, and the old url stops working. */
    rotate: (agentId: string, triggerId: string) =>
      this.request<Trigger & { url: string }>('POST', `/v1/agents/${seg(agentId)}/triggers/${seg(triggerId)}/rotate`),
  };

  /** The account's playbooks (Hoppy's service only): recipes an agent wrote up, listed without waking any agent. The recipe's file stays on the agent's computer; these calls never read or write it. */
  readonly playbooks = {
    /** Newest first; with agentId, only that agent's. */
    list: async (agentId?: string) => (await this.request<{ playbooks: Playbook[] }>('GET', `/v1/playbooks${agentId === undefined ? '' : `?agent=${encodeURIComponent(agentId)}`}`)).playbooks,
    /** Lists a recipe file the agent holds under /data/. At most 200 in an account. */
    create: (input: { agentId: string; name: string; path: string; summary?: string; conversationId?: string; blanks?: string[] }) => this.request<Playbook>('POST', '/v1/playbooks', input),
    /** Changes any of name, summary, path and blanks, leaving the rest as they were. */
    update: (id: string, input: { name?: string; summary?: string; path?: string; blanks?: string[] }) => this.request<Playbook>('PATCH', `/v1/playbooks/${seg(id)}`, input),
    /** Takes it off the list; the recipe's file stays on the agent's computer. */
    delete: (id: string) => this.request<null>('DELETE', `/v1/playbooks/${seg(id)}`),
  };

  /** Your server told what happens on the host, signed; check deliveries with verifyWebhook. */
  readonly webhooks = {
    list: async () => (await this.request<{ webhooks: Webhook[] }>('GET', '/v1/webhooks')).webhooks,
    get: (id: string) => this.request<Webhook>('GET', `/v1/webhooks/${seg(id)}`),
    /** The answer carries the signing secret, shown this once. */
    create: (input: { url: string; events?: string[]; description?: string }) => this.request<Webhook & { secret: string }>('POST', '/v1/webhooks', input),
    delete: (id: string) => this.request<null>('DELETE', `/v1/webhooks/${seg(id)}`),
    test: (id: string) => this.request<{ eventId: string }>('POST', `/v1/webhooks/${seg(id)}/test`),
    deliveries: async (id: string) => (await this.request<{ deliveries: WebhookDelivery[] }>('GET', `/v1/webhooks/${seg(id)}/deliveries`)).deliveries,
  };

  /** API keys, each with only the scopes it needs. */
  readonly keys = {
    list: async () => (await this.request<{ keys: ApiKey[] }>('GET', '/v1/keys')).keys,
    /** The answer carries the key, shown this once. */
    create: (name: string, scopes: ('read' | 'agents' | 'secrets' | 'customers' | 'keys')[] = ['read']) =>
      this.request<ApiKey & { key: string }>('POST', '/v1/keys', { name, scopes }),
    revoke: (id: string) => this.request<null>('DELETE', `/v1/keys/${seg(id)}`),
  };

  /**
   * Your own customers, each named by your own id for them (1 to 128 of letters, digits and
   * _ @ . : + -), unique within your key's account.
   */
  readonly customers = {
    list: async () => (await this.request<{ endUsers: Customer[] }>('GET', '/v1/end-users')).endUsers,
    get: (externalId: string) => this.request<Customer>('GET', `/v1/end-users/${seg(externalId)}`),
    /** Creates the customer or changes it; a field left out keeps its value and null clears it. */
    set: (externalId: string, input: { displayName?: string | null; tokenCapMonthly?: number | null } = {}) =>
      this.request<Customer>('PUT', `/v1/end-users/${seg(externalId)}`, input),
    /** Their agents go with their files, and their tokens stop working. */
    delete: (externalId: string) => this.request<null>('DELETE', `/v1/end-users/${seg(externalId)}`),
    /** Stops every agent of theirs, refuses their messages and voids their tokens until resumed. */
    suspend: (externalId: string) => this.request<Customer>('POST', `/v1/end-users/${seg(externalId)}/suspend`),
    /** Their tokens work again if they have not expired. */
    resume: (externalId: string) => this.request<Customer>('POST', `/v1/end-users/${seg(externalId)}/resume`),
    /** A token for the customer's browser: chat when no scopes are given, for ttlSeconds (30 to 3600, 900 by default). */
    token: (externalId: string, input: { scopes?: CustomerScope[]; ttlSeconds?: number } = {}) =>
      this.request<CustomerToken>('POST', `/v1/end-users/${seg(externalId)}/tokens`, input),
  };

  /** A base agent serving your customers, each from a private copy of it made on their first message. */
  readonly frontDoor = {
    /**
     * Sends a customer's message to their own copy of the base agent (made, or taken from the warm
     * pool, when they have none) and waits for the reply. The host holds the first call up to
     * waitSeconds (default 30, at most 120), so that call's timeout is waitSeconds plus 30 when that
     * is above the client's. Then this asks every pollMs until timeoutMs (default ten minutes) has
     * passed. Throws AgentHostError("message_failed") when the agent failed, and
     * AgentHostError("message_timeout") naming the messageId when the reply has not come by then.
     * The same messageId again returns the first outcome rather than asking twice, so a retry is safe.
     */
    send: async (
      agentId: string,
      externalUserId: string,
      message: string,
      opts: { messageId?: string; waitSeconds?: number; pollMs?: number; timeoutMs?: number } = {}
    ): Promise<FrontDoorMessage> => {
      const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
      const wait = opts.waitSeconds ?? 30;
      // The host holds this call up to wait seconds, so its timeout must outlast the hold.
      let r = await this.request<FrontDoorMessage>(
        'POST',
        `/v1/agents/${seg(agentId)}/messages`,
        { externalUserId, message, wait, ...(opts.messageId ? { messageId: opts.messageId } : {}) },
        { timeout: Math.max(this.timeout, wait + 30) }
      );
      while (r.status === 'provisioning' || r.status === 'queued') {
        // A copy that failed to start leaves its message provisioning for good, so the wait needs an end.
        if (Date.now() >= deadline) throw new AgentHostError(202, 'message_timeout', `message ${r.messageId} is still ${r.status}; send it again with the same messageId, or get it, to keep waiting`);
        await sleep(Math.min(opts.pollMs ?? 2000, Math.max(deadline - Date.now(), 0)));
        r = await this.request<FrontDoorMessage>('GET', `/v1/agents/${seg(agentId)}/messages/${seg(r.messageId)}`);
      }
      if (r.status === 'failed') throw new AgentHostError(200, 'message_failed', r.error ?? 'the agent failed to answer');
      return r;
    },
    /** Where a front door message stands, without waiting. */
    get: (agentId: string, messageId: string) => this.request<FrontDoorMessage>('GET', `/v1/agents/${seg(agentId)}/messages/${seg(messageId)}`),
    serving: (agentId: string) => this.request<Serving>('GET', `/v1/agents/${seg(agentId)}/serving`),
    /** Sets the cap on customer copies (1 to 1000) and the warm pool kept ready; a field left out keeps its value. */
    setServing: (agentId: string, input: { maxInstances?: number; warmPool?: number }) => this.request<Serving>('PUT', `/v1/agents/${seg(agentId)}/serving`, input),
  };

  /** The harnesses this host runs agents on, such as Hermes, OpenCode and Codex. */
  harnesses = async () => (await this.request<{ harnesses: Record<string, unknown>[] }>('GET', '/v1/harnesses')).harnesses;
  /** The models agents can use. */
  models = async () => (await this.request<{ models: Record<string, unknown>[] }>('GET', '/v1/models')).models;
  /** The account's model calls per day and per agent over the last days (30 by default). */
  usage = (days?: number) => this.request<Usage>('GET', `/v1/usage${q({ days })}`);
  /** Who this client's credential is, its account, role and scopes. */
  me = () => this.request<Caller>('GET', '/v1/me');
  /** A live reader of one of the agent's messages, with this client's key, address and fetch. */
  private live(id: string, opts: Pick<LiveOptions, 'messageId' | 'send' | 'after' | 'snapshot' | 'signal'>): LiveReader {
    return new LiveReader({
      ...opts,
      baseUrl: this.url,
      agentId: id,
      fetch: this.doFetch,
      headers: { Authorization: `Bearer ${this.key}`, 'User-Agent': `agent-host-typescript/${VERSION}` },
    });
  }

  /** Awake time per agent over the last days. */
  computeUsage = (days = 30) => this.request<Record<string, unknown>>('GET', `/v1/usage/compute${q({ days })}`);
  /** Bytes each agent's machines sent in a UTC month (YYYY-MM, this one by default). */
  trafficUsage = (month?: string) => this.request<Record<string, unknown>>('GET', `/v1/usage/traffic${q({ month })}`);
}

/** Each JSON line of a streamed answer, as it arrives. */
async function* ndjson<T>(res: Response): AsyncIterable<T> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (rest + value).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) yield JSON.parse(l) as T;
    }
    if (rest.trim()) yield JSON.parse(rest) as T;
  } finally {
    // A caller that stops early must not leave the stream, and the host's follow, open.
    await reader.cancel().catch(() => {});
  }
}

/** Each Server-Sent Event of a streamed answer as it arrives: its data as JSON, with its id. Comments and keep-alives are passed over. */
async function* serverEvents<T>(res: Response): AsyncIterable<T> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  let id = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (rest + value).split('\n');
      rest = lines.pop() ?? '';
      for (const raw of lines) {
        const l = raw.replace(/\r$/, '');
        if (l === '') {
          // A blank line ends an event; one with no data (a comment alone) is no event.
          if (data.length) yield { id, ...JSON.parse(data.join('\n')) } as T;
          data = [];
        } else if (l.startsWith('id:')) id = l.slice(3).trim();
        else if (l.startsWith('data:')) data.push(l.slice(5).trimStart());
      }
    }
    if (data.length) yield { id, ...JSON.parse(data.join('\n')) } as T;
  } finally {
    // A caller that stops early must not leave the stream, and the brain's follow, open.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Checks a webhook delivery is from your host and recent, as Standard Webhooks sign them, and
 * returns its event. Give the secret the webhook was created with, the request's headers and its
 * body exactly as received. Throws when the signature does not match or the delivery is older than
 * toleranceSeconds, which stops a replay of an old one.
 */
export async function verifyWebhook(
  secret: string,
  headers: Headers | Record<string, string | string[] | undefined>,
  body: string,
  toleranceSeconds = 300
): Promise<WebhookEvent> {
  const get = (name: string) => {
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? '';
    const v = (headers as Record<string, string | string[] | undefined>)[name] ?? (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : (v ?? '');
  };
  const id = get('webhook-id');
  const ts = get('webhook-timestamp');
  const sigs = get('webhook-signature');
  if (!id || !ts || !sigs) throw new Error('not a signed webhook delivery: a webhook header is missing');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSeconds) throw new Error('the webhook delivery is too old or from the future');
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  // The header may carry several signatures while a secret is being rotated; any one matching is enough.
  const given = sigs.split(' ').map((s) => s.replace(/^v1,/, ''));
  const same = (a: string, b: string) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
  if (!given.some((g) => same(g, expected))) throw new Error('the webhook signature does not match');
  return JSON.parse(body) as WebhookEvent;
}
