/**
 * The one rule hoppy and hoppy mcp use to decide that a message's events route is not served to
 * them, so they check the message instead of following its events. The shared reader redials every
 * answer it does not stop on, so without this a refusal it cannot tell from a cut would show
 * nothing until the caller's own time ran out, although the record may already hold the reply.
 */

import { EVENTS_NEVER_SERVED } from '../typescript/src/stream.js';

/** How many events dials in a row may meet an outage (a 5xx or 429 that is not a plain refusal) before the message is checked instead. */
export const OUTAGE_DIALS = 3;

/**
 * Whether an answer to GET .../events means the route is not served to this caller. 404, 405 and
 * 501 are no route, and so is a 5xx whose code is in EVENTS_NEVER_SERVED (an API key may get 503
 * key_chat_events_unavailable): redialing those would never show
 * anything. Any other 5xx or 429 is an outage, and gets 'outage': the brain marks busy,
 * desk_unavailable and worker_unreachable as try again. Any other coded refusal is not served.
 * 401 and 403 give null and are left to the reader, which stops with them, because the record
 * would refuse the same credential.
 */
export async function eventsRefusal(res          )                                          {
  if (res.ok || res.status === 401 || res.status === 403) return null;
  if ([404, 405, 501].includes(res.status)) return 'not served';
  const body = (await res.clone().json().catch(() => null))                                         ;
  const code = typeof body?.error?.code === 'string' && body.error.code ? body.error.code : null;
  if (code && EVENTS_NEVER_SERVED.has(code)) return 'not served';
  if (res.status >= 500 || res.status === 429) return 'outage';
  return 'not served';
}

/**
 * Wraps fetch for a LiveReader: once an events answer says the route is not served to this caller,
 * or OUTAGE_DIALS events dials in a row meet an outage, it calls stop (which should abort the
 * reader) and notServed() turns true; wentDown() is true when it stopped on an outage rather than a
 * refusal. Every other request goes through untouched.
 */
export function watchEventsRoute(base              , stop            )                                                                             {
  let notServed = false;
  let wentDown = false;
  let outages = 0;
  const fetchLive               = async (input, init) => {
    const res = await base(input, init);
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
    if (!path.endsWith('/events')) return res;
    const refusal = await eventsRefusal(res);
    outages = refusal === 'outage' ? outages + 1 : 0;
    if (refusal === 'not served' || outages >= OUTAGE_DIALS) {
      notServed = true;
      wentDown = refusal === 'outage';
      stop();
    }
    return res;
  };
  return { fetch: fetchLive, notServed: () => notServed, wentDown: () => wentDown };
}
