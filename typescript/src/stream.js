/**
 * The shared live reader: follows one message's agent events v1 from
 * GET /v1/agents/{id}/chat/{messageId}/events and folds them into one turn. Every client reads the
 * stream through this file: both SDKs (the Python one is a port of it) and the hoppy CLI and MCP
 * server. No dependencies and no imports.
 *
 *   const reader = new LiveReader({ baseUrl, agentId, messageId, headers: { Authorization: `Bearer ${key}` } });
 *   for await (const e of reader) render(reader.turn);
 *   const record = await reader.final();
 *
 * A cut, a brain deploy or 45 s without a heartbeat redials with Last-Event-ID; the reader drops
 * any seq it has already shown, so nothing is missed and nothing is shown twice. Only 401, 403 and
 * 404 stop the redials, and a refusal in EVENTS_NEVER_SERVED, which stops with EventsNotServed so the
 * caller reads GET /chat/{messageId} instead. The send and the record read are tried CALL_TRIES times through lost
 * connections and 5xx answers, then stop with the brain's code (503 no_capacity for a full worker),
 * so a caller can say why. At the end it reads GET /chat/{messageId} once: the record, not the
 * stream, is the truth, and its reply replaces the live text.
 */

/** No byte for this long, heartbeats included, and the connection is treated as dead. */
export const HEARTBEAT_DEAD_MS = 45_000;
/** The waits before each redial in a row; the last repeats. */
export const REDIAL_MS = [500, 1000, 2000, 5000];
/**
 * How many times the send (POST /chat) and the record read (GET /chat/{messageId}) are tried in all
 * after lost connections or 5xx answers, with the redial waits between them (about 13 s with the
 * default waits, long enough for a brain deploy) before the reader stops with the last answer's code.
 */
export const CALL_TRIES = 6;
/**
 * The most bytes one SSE line, and one event's data lines together, may hold before the reader drops
 * the connection and redials: the brain caps what it queues for a follower at 1 MiB, so anything
 * longer is a broken or hostile stream, and holding it would grow without end.
 */
export const MAX_LINE = 1024 * 1024;
export const MAX_BLOCK = 2 * 1024 * 1024;

/** One event as the brain sends it: the envelope, the kind's own fields, and its SSE id. */
                                                                                                                                  

/**
 * The message's job went stale and the brain started a new attempt: what was shown of the old job is
 * not part of the answer, so clear it (reader.turn already has). job is the new job, whose events
 * follow from seq 1; seq is 0 and id the cursor, which this does not move.
 */
                                                                                                

/**
 * The mark a reader puts on the restarts it made from the brain's checked control block. An ordinary
 * event whose kind happens to be restarted has no mark: it is an unknown kind, and taking it for a
 * restart would let any event's JSON tell a caller to clear the turn. A symbol, because no JSON can
 * carry one; an enumerable own property, so a copy made with spread or Object.assign (as UI state
 * often is) is still a restart; and from the global registry, so two copies of this file loaded
 * in one page know each other's restarts.
 */
const RESTART_MARK                = Symbol.for('agent-host.stream.restarted')         ;

/**
 * True for a restart a reader made, or a copy of one; never for an event that only says its kind is
 * restarted. A copy made with structuredClone or sent through postMessage drops symbol keys, so it is
 * not recognised.
 */
export const isRestarted = (e            )                      => (e                                      )?.[RESTART_MARK] === true;

                                                                                               
                        
                    
             
                
                
                 
                  
                                                                                     
                 
                  
                   
                 
                   
                
  
                                           

/** What a message's events add up to so far. text is the reply's text, items every block in order. */
                    
                    
                                        
                                                                                      
                       
                      
                         
               
                    
                                                  
                                                                               
                                                                       
                                        
                                                           
                                                                  
                         
                                                                                          
                        
                                                                                        
                 
  

/** GET /chat/{messageId}: where the message stands, with its scrubbed reply once done. */
                                                                                                                                                                                    

/** A refusal from the brain, with its status and its own error code. */
export class StreamError extends Error {
           status        ;
           code        ;
  constructor(status        , code        , message        ) {
    super(message);
    this.name = 'StreamError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The events route refused this caller for good, though the message itself may finish: the caller
 * reads GET /chat/{messageId} (its status and reply) instead of the stream.
 */
export class EventsNotServed extends StreamError {
  constructor(status        , code        , message        ) {
    super(status, code, message);
    this.name = 'EventsNotServed';
  }
}

/**
 * The codes with which the brain refuses the events route to a caller for good. An API key may get 503
 * key_chat_events_unavailable: a 503 that no redial will change, so it stops the reader rather than looping. hoppy keeps the same set.
 */
export const EVENTS_NEVER_SERVED                      = new Set(['key_chat_events_unavailable']);

export function newTurn(messageId        )       {
  return { messageId, status: 'running', state: null, note: null, attempt: null, text: '', items: [], plan: null, files: [], usage: null, notices: [], error: null, seconds: null, unknown: [], final: false };
}

const ENVELOPE = new Set(['v', 'kind', 'job', 'seq', 'at', 'id']);
const str = (v         ) => (typeof v === 'string' ? v : '');
const has = (o                         , k        ) => o[k] !== undefined && o[k] !== null;

function part(turn      , type                  , id        )           {
  let p = turn.items.find((i)                => i.type === type && i.id === id);
  if (!p) turn.items.push((p = { type, id, text: '', done: false }));
  return p;
}

function step(turn      , id        )           {
  let s = turn.items.find((i)                => i.type === 'tool_call' && i.id === id);
  if (!s) turn.items.push((s = { type: 'tool_call', id, output: '', done: false }));
  return s;
}

function addText(turn      , type                  , id        , delta        , done         ) {
  const p = part(turn, type, id);
  p.text += delta;
  if (done) p.done = true;
  if (type === 'text') turn.text += delta;
}

/** Starts the turn again for a new attempt, keeping only the unknown events it has seen. */
function restart(turn      , attempt         ) {
  // A new attempt starts from nothing: what the old one showed is not part of the answer.
  Object.assign(turn, { ...newTurn(turn.messageId), unknown: turn.unknown, attempt: typeof attempt === 'number' ? attempt : turn.attempt });
}

/** Folds one event into the turn, in place, and returns it. Any kind it does not know is kept in unknown. */
export function fold(turn      , e            )       {
  const item = (e.item ?? {})                           ;
  switch (e.kind) {
    case 'response.created':
      turn.status = 'running';
      if (typeof e.attempt === 'number') turn.attempt = e.attempt;
      break;
    case 'agent.status':
      turn.state = str(e.state) || turn.state;
      turn.note = typeof e.note === 'string' ? e.note : null;
      break;
    case 'response.output_text.delta':
    case 'response.output_text.done':
      addText(turn, 'text', str(e.item_id), str(e.delta), e.kind.endsWith('.done'));
      break;
    case 'response.reasoning_text.delta':
    case 'response.reasoning_text.done':
      addText(turn, 'reasoning', str(e.item_id), str(e.delta), e.kind.endsWith('.done'));
      break;
    case 'response.output_item.added': {
      const s = step(turn, str(item.id));
      for (const k of ['name', 'kind', 'title', 'input']         ) if (has(item, k)) (s                           )[k] = item[k];
      break;
    }
    case 'agent.tool_output.delta':
      step(turn, str(e.item_id)).output += str(e.delta);
      break;
    case 'response.output_item.done': {
      const s = step(turn, str(item.id));
      s.output += str(e.delta);
      if (has(item, 'status')) s.status = str(item.status);
      if (has(item, 'output')) s.preview = str(item.output);
      if (has(item, 'diff')) s.diff = item.diff;
      if (typeof item.seconds === 'number') s.seconds = item.seconds;
      s.done = true;
      break;
    }
    case 'agent.plan':
      turn.plan = Array.isArray(e.items) ? (e.items                ) : [];
      break;
    case 'agent.file':
      turn.files.push({ fileId: str(e.fileId), name: str(e.name), size: Number(e.size) || 0, contentType: str(e.contentType) });
      break;
    case 'agent.usage':
      turn.usage = Object.fromEntries(Object.entries(e).filter(([k]) => !ENVELOPE.has(k)));
      break;
    case 'agent.notice':
      turn.notices.push({ level: str(e.level), code: str(e.code), text: str(e.text) });
      break;
    case 'agent.snapshot': {
      turn.items = Array.isArray(e.items) ? (JSON.parse(JSON.stringify(e.items))              ) : [];
      if (Array.isArray(e.plan)) turn.plan = e.plan                ;
      if (e.status === 'failed') {
        // A failed turn's final is why it failed, not a reply: it goes in error, never in text.
        const err = (e.error ?? {})                           ;
        turn.status = 'failed';
        turn.text = str(e.text);
        turn.error = { status: Number(err.status) || 502, code: str(err.code) || str(e.reason) || 'agent_error', message: str(err.message) || str(e.final) };
      } else if (e.status === 'done') {
        turn.status = 'done';
        // A reply too large to send is left out of the snapshot: final() reads it from the record.
        turn.text = e.final_omitted === true ? '' : typeof e.final === 'string' ? e.final : str(e.text);
      } else {
        turn.text = str(e.text);
        if (typeof e.status === 'string') turn.state = e.status;
      }
      break;
    }
    case 'response.completed':
      turn.status = 'done';
      if (typeof e.seconds === 'number') turn.seconds = e.seconds;
      break;
    case 'response.failed': {
      const err = (e.error ?? {})                           ;
      turn.status = 'failed';
      turn.error = { status: Number(err.status) || 502, code: str(err.code) || 'agent_error', message: str(err.message) };
      break;
    }
    default:
      turn.unknown.push(e);
  }
  return turn;
}

/**
 * The fields of one Server-Sent Event; data is its data lines joined, event its type ('' for none).
 * id is the last id seen on the connection, as SSE carries it on; hasId says whether this block had
 * an id line of its own, empty or not.
 */
                                                                            

/** Splits a stream of bytes into Server-Sent Events, whatever chunks it comes in. Comments are passed over. */
class SseParser {
  /** The bytes of a line whose end has not come yet, and how many there are. */
  #rest               = [];
  #restBytes = 0;
  #decoder = new TextDecoder();
  #id = '';
  #event = '';
  #hasId = false;
  #data           = [];
  #size = 0;
  /**
   * The events this chunk completes. An event cut off before its blank line is held, never given.
   * Throws once a line passes MAX_LINE bytes or an event's data MAX_BLOCK bytes, so the caller drops
   * the connection. Lines are split as bytes and decoded whole, so a character cut between chunks
   * is never broken and the caps count what the brain sent, not UTF-16 units.
   */
  push(chunk            )             {
    const out             = [];
    let start = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, nl);
      const bytes = this.#restBytes + piece.length;
      if (bytes > MAX_LINE) throw new Error(`an event line passed ${MAX_LINE} bytes`);
      const line = this.#rest.length ? join([...this.#rest, piece], bytes) : piece;
      [this.#rest, this.#restBytes] = [[], 0];
      this.#line(this.#decoder.decode(line), bytes, out);
      start = nl + 1;
    }
    if (start < chunk.length) {
      // A copy: the stream may reuse its chunk's memory once this returns.
      this.#rest.push(chunk.slice(start));
      this.#restBytes += chunk.length - start;
      if (this.#restBytes > MAX_LINE) throw new Error(`an event line passed ${MAX_LINE} bytes`);
    }
    return out;
  }
  #line(raw        , bytes        , out            ) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (l === '') {
      if (this.#data.length) out.push({ id: this.#id, hasId: this.#hasId, event: this.#event, data: this.#data.join('\n') });
      this.#data = [];
      this.#size = 0;
      // Unlike the id, an event's type lasts for its own block only.
      this.#event = '';
      this.#hasId = false;
    } else if (l === 'id' || l.startsWith('id:')) {
      // A bare id line is the id field with an empty value under the SSE rules, so the block has an id.
      // Only the one space after the colon goes, as the SSE rules say: trim() and Python's strip()
      // remove different characters, so trimming more would let the readers take different frames.
      this.#id = l.slice(3).replace(/^ /, '');
      this.#hasId = true;
    } else if (l.startsWith('event:')) this.#event = l.slice(6).replace(/^ /, '');
    else if (l.startsWith('data:')) {
      this.#size += bytes + 1;
      if (this.#size > MAX_BLOCK) throw new Error(`an event passed ${MAX_BLOCK} bytes`);
      this.#data.push(l.slice(5).replace(/^ /, ''));
    }
  }
  /** True while part of an event has come and its end has not. */
  get pending()          {
    return this.#restBytes > 0 || this.#data.length > 0;
  }
}

function join(parts              , bytes        )             {
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A job id as the brain's line protocol makes one; the SDK builds on its own, so it keeps its own copy
 * of the pattern.
 */
const JOB_ID = /^[A-Za-z0-9_-]{1,64}:[1-9][0-9]{0,5}$/;

/**
 * The parts of a job id, <prefix>:<attempt>, or null for any other form. The prefix is the brain's
 * digest of the message id, which a reader has no need to work out: a restart
 * only has to keep the prefix of the job already followed.
 */
function jobParts(job         )                                             {
  if (typeof job !== 'string' || !JOB_ID.test(job)) return null;
  const at = job.indexOf(':');
  return { prefix: job.slice(0, at), attempt: Number(job.slice(at + 1)) };
}

/**
 * The largest seq a cursor may hold: the brain reads Last-Event-ID only when its seq
 * is 1 to 15 digits, and a redial with any other cursor would start the job over, which this reader
 * would then drop as already shown. 15 digits is also well inside 2**53 - 1, so JSON.parse and
 * Python's json read every seq up to it exactly.
 */
const SEQ_MAX = 999_999_999_999_999;
/** A seq in an SSE id or a cursor as the reader writes one: no sign, no space, no leading zero. */
const SEQ_TEXT = /^(0|[1-9][0-9]{0,14})$/;

/** A seq or upto_seq read from an event: a whole number from 0 to SEQ_MAX, or null. */
const seqOf = (v         )                => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= SEQ_MAX ? v : null);

/** A snapshot of a turn that has ended: nothing follows it, so the reader reads the record. */
const isTerminal = (e            ) => e.kind === 'agent.snapshot' && (e.status === 'done' || e.status === 'failed');

                           
                                                                                                
                  
                  
                                                                                                  
                     
                                                                                                                              
                                 
                                                         
                                   
                                                                                                   
                     
                       
                                                                                                                  
                 
                                                                                           
                     
                       
                       
                      
                                                                                               
                 
  

const STOPS = new Set([401, 403, 404]);

async function refusal(res          , what        )                       {
  const body = (await res.json().catch(() => null))                                                          ;
  return new StreamError(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? `${what} answered ${res.status}`);
}

/**
 * Follows one message. Iterate it once for its events as they arrive (turn holds the fold so far),
 * or call final() alone for the record. A caller that stops iterating early can call final() to
 * read on from where it stopped.
 */
export class LiveReader                                      {
           messageId        ;
           turn      ;
  #opts             ;
  #fetch              ;
  /** The job whose events are shown: set by after, the first event of all, or a restarted block. */
  #job                = null;
  /** The last seq of #job shown, -1 for none yet. */
  #seq = -1;
  /** The Last-Event-ID to redial with, which a restarted block leaves where it was. */
  #cursor                = null;
  /** True once the current connection has given any block: a restarted block is taken only before. */
  #begun = false;
  #sent = false;
  #running = false;
  #record                       = null;
  #end                                = null;

  constructor(opts             ) {
    this.#opts = opts;
    this.messageId = opts.messageId || crypto.randomUUID();
    this.turn = newTurn(this.messageId);
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    if (opts.after) {
      // A cursor the brain cannot read would start the job over, and the reader would drop it all as
      // already shown, so a bad one is refused here rather than dialed.
      const at = opts.after.lastIndexOf('@');
      const [job, seq] = [opts.after.slice(0, at), opts.after.slice(at + 1)];
      if (!JOB_ID.test(job) || !SEQ_TEXT.test(seq)) throw new TypeError(`after is an event id, <job>@<seq> with a job id and a seq of 0 to ${SEQ_MAX}`);
      [this.#job, this.#seq, this.#cursor] = [job, Number(seq), opts.after];
    }
  }

  /** The last event shown, as <job>@<seq>, to resume after; null before the first. */
  get cursor()                {
    return this.#cursor;
  }

  [Symbol.asyncIterator]()                            {
    return this.events();
  }

  /** The record, once the stream has ended: reads the rest of the stream first when nobody is. */
  final()                         {
    if (this.#record) return Promise.resolve(this.#record);
    if (!this.#end) {
      const it = this.events();
      this.#end = (async () => {
        while (!(await it.next()).done);
        return this.#record                            ;
      })();
      // A caller that never asks for final() must not see an unhandled rejection.
      this.#end.catch(() => {});
    }
    return this.#end;
  }

  async *events()                             {
    // A finished message has nothing more to show; its record is in final().
    if (this.#record) return;
    if (this.#running) throw new Error('this reader is already being read');
    this.#running = true;
    try {
      if (this.#opts.send && !this.#sent) await this.#send();
      let failures = 0;
      for (;;) {
        let shown = false;
        let ended = false;
        try {
          for await (const e of this.#dial()) {
            shown = true;
            yield e;
          }
          ended = true;
        } catch (err) {
          if (err instanceof StreamError || this.#opts.signal?.aborted) throw err;
        }
        if (shown) failures = 0;
        if (ended) {
          // The brain closes a follower once the record holds the outcome, but a deploy closes it
          // too, so only the record says whether to stop.
          const record = await this.#read();
          if (record.status !== 'running') {
            this.#settle(record);
            return;
          }
        }
        await this.#pause(failures++);
      }
    } finally {
      this.#running = false;
      if (!this.#record) this.#end = null;
    }
  }

  #url(path = '') {
    return `${this.#opts.baseUrl.replace(/\/+$/, '')}/v1/agents/${encodeURIComponent(this.#opts.agentId)}/chat${path}`;
  }

  #pause(n        )                {
    const waits = this.#opts.redialMs ?? REDIAL_MS;
    const ms = waits[Math.min(n, waits.length - 1)] ?? 0;
    const signal = this.#opts.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener('abort', stop);
        resolve();
      }
      function stop() {
        clearTimeout(t);
        reject(signal?.reason);
      }
      signal?.addEventListener('abort', stop, { once: true });
    });
  }

  /**
   * One request, tried again after a lost connection or a 5xx up to tries times in all (a send
   * carries its messageId, so it runs once however often it is sent). Past that it throws the last
   * 5xx as a StreamError with the brain's code, or the last network error.
   */
  async #call(method        , url        , body          )                    {
    const tries = Math.max(1, this.#opts.tries ?? CALL_TRIES);
    for (let n = 1; ; n++) {
      let res                  = null;
      try {
        res = await this.#fetch(url, {
          ...this.#opts.init,
          method,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...this.#opts.headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(this.#opts.signal ? { signal: this.#opts.signal } : {}),
        });
      } catch (err) {
        if (this.#opts.signal?.aborted || n >= tries) throw err;
      }
      if (res && res.status < 500) return res;
      if (res && n >= tries) throw await refusal(res, `${method} chat`);
      await res?.body?.cancel().catch(() => {});
      await this.#pause(n - 1);
    }
  }

  async #send() {
    const res = await this.#call('POST', this.#url(), { ...this.#opts.send, messageId: this.messageId, wait: 0 });
    if (!res.ok) {
      const err = await refusal(res, 'POST chat');
      // An earlier send of this id was taken and is running: follow that one.
      if (!(err.status === 409 && err.code === 'message_in_progress')) throw err;
    } else await res.body?.cancel().catch(() => {});
    this.#sent = true;
  }

  async #read()                         {
    const res = await this.#call('GET', this.#url(`/${encodeURIComponent(this.messageId)}`));
    if (!res.ok) throw await refusal(res, 'GET chat');
    return (await res.json())                 ;
  }

  #settle(record               ) {
    this.#record = record;
    this.turn.status = record.status;
    if (record.status === 'done' && typeof record.response === 'string') this.turn.text = record.response;
    if (record.status === 'failed' && !this.turn.error) this.turn.error = { status: 502, code: record.reason || 'agent_error', message: record.error ?? '' };
    this.turn.final = true;
  }

  /** One connection: its events in order, the ones already shown dropped. Ends when the brain closes it; throws when it is cut. */
  async *#dial()                             {
    const cursor = this.cursor;
    const conn = new AbortController();
    const signal = this.#opts.signal ? AbortSignal.any([this.#opts.signal, conn.signal]) : conn.signal;
    const deadMs = this.#opts.heartbeatMs ?? HEARTBEAT_DEAD_MS;
    let timer                                           ;
    const beat = () => {
      clearTimeout(timer);
      timer = setTimeout(() => conn.abort(new Error(`no heartbeat in ${deadMs} ms`)), deadMs);
    };
    const query = !cursor && this.#opts.snapshot ? '?from=snapshot' : '';
    beat();
    try {
      const res = await this.#fetch(this.#url(`/${encodeURIComponent(this.messageId)}/events${query}`), {
        ...this.#opts.init,
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...this.#opts.headers, ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
        signal,
      });
      if (STOPS.has(res.status)) throw await refusal(res, 'GET events');
      if (!res.ok) {
        const err = await refusal(res, 'GET events');
        if (EVENTS_NEVER_SERVED.has(err.code)) throw new EventsNotServed(err.status, err.code, err.message);
        throw new Error(`GET events answered ${res.status}`);
      }
      if (!res.body) throw new Error(`GET events answered ${res.status} with no body`);
      const reader = res.body.getReader();
      // Some fetch implementations leave a quiet body open after their signal aborts.
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const sse = new SseParser();
      this.#begun = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          // A connection that ends inside an event was cut, however cleanly it closed.
          if (done && sse.pending) throw new Error('the stream ended inside an event');
          if (done) return;
          beat();
          for (const raw of sse.push(value)) {
            const e = this.#take(raw);
            if (!e) continue;
            yield e;
            // The brain sends nothing after an ended turn's snapshot but heartbeats, so waiting on
            // would hold the reader open; the record says the rest.
            if (isTerminal(e)) return;
          }
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      conn.abort();
    }
  }

  /**
   * The event in raw, folded and with the cursor moved, or null when it is not one to show. Shown
   * are: a restarted block (no id line, event restarted, data {job, attempt}) that comes first on its
   * connection while a job is followed, whose job is a job id as the line protocol makes one,
   * <prefix>:<attempt>, with the prefix of the job followed and a later attempt than it, and whose
   * attempt is that same whole number; and an event of the followed job (or the first event of all,
   * which sets the job) whose SSE id is its own <job>@<seq>, whose seq is a whole number from 0 to
   * SEQ_MAX past the last shown, and, for a snapshot, whose upto_seq is that same seq.
   */
  #take(raw          )                    {
    const first = !this.#begun;
    this.#begun = true;
    let e            ;
    try {
      e = JSON.parse(raw.data);
    } catch {
      return null;
    }
    if (!e || typeof e !== 'object' || typeof e.job !== 'string' || !e.job) return null;
    if (raw.event === 'restarted') {
      // The brain sends a restart only as the answer to a redial, before anything else; one later in
      // a connection, or for an attempt no later than the one followed, is a stray or a stale repeat,
      // and taking it would clear the turn and follow the wrong job.
      // A block with an id line is an event, not the brain's control block, and a job whose prefix
      // differs from the followed one's belongs to another message, so following it would show
      // someone else's answer.
      // The route sends one only on a redial whose job is older, so with no job followed yet (a fresh
      // attach) there is nothing it can restart.
      // JSON.parse reads 2.0 and 2e0 as 2, so they are the same attempt here as in the Python reader.
      const named = jobParts(e.job);
      if (raw.hasId || !first || !named || named.attempt !== e.attempt) return null;
      const attempt = named.attempt;
      const followed = jobParts(this.#job);
      if (!followed || followed.prefix !== named.prefix || attempt <= followed.attempt) return null;
      // It has no id, so the cursor stays on the old job: a redial before the new job's first event
      // gets the restart again (dropped, as no later attempt) and then the new job from seq 1.
      restart(this.turn, attempt);
      [this.#job, this.#seq] = [e.job, -1];
      return { v: 1, kind: 'restarted', job: e.job, seq: 0, attempt, id: this.#cursor ?? '', [RESTART_MARK]: true }                  ;
    }
    // The id is compared as text, so only the seq's plain decimal form matches: 2.0 and 2e0 in the
    // data are 2, but an id of 02, +2 or 2e0 is not. The cursor is the id, and the first job taken
    // must be a job id, so the cursor is always one the brain reads.
    const seq = seqOf(e.seq);
    if (seq === null || raw.id !== `${e.job}@${seq}`) return null;
    e.seq = seq;
    // Any event of another job would fold into the wrong turn; only a restarted block moves the job.
    // The first job taken becomes the cursor, so one the brain could not read back is dropped.
    if (this.#job === null ? jobParts(e.job) === null : e.job !== this.#job) return null;
    if (e.seq <= this.#seq) return null;
    // A snapshot holds everything up to one cursor, its own seq: an upto_seq past it would skip
    // events the snapshot never folded in.
    if (e.kind === 'agent.snapshot' && seqOf(e.upto_seq) !== e.seq) return null;
    e.id = raw.id;
    fold(this.turn, e);
    [this.#job, this.#seq] = [e.job, e.seq];
    this.#cursor = `${this.#job}@${this.#seq}`;
    return e;
  }
}
