/**
 * The one rule hoppy and hoppy mcp use to show agent events v1 without ever splitting a key: an
 * event whose text could be the start of a key is held until the key's word ends, and events are
 * only ever cut between events, so a cursor (<job>@<seq>) always names the last event shown in full.
 */

import { isRestarted, type AgentEvent } from '../typescript/src/stream.ts';

/**
 * Where a run of text pieces, one per event, can be shown up to: the end of the last piece after
 * which a key cannot go on (the text before ends in a space, or the next piece starts with one).
 * Returns how many pieces can go, 0 when none can yet; all lets every piece go.
 */
export function safePieces(pieces: string[], all: boolean): number {
  if (all) return pieces.length;
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let text = '';
  let n = 0;
  for (let i = 0; i < pieces.length; i++) {
    text += pieces[i];
    const next = pieces.slice(i + 1).join('');
    if (space(text.at(-1)) || space(next[0])) n = i + 1;
  }
  return n;
}

/**
 * Whether an event leaves a word of the reply held: a piece of text, a change of state, or a piece
 * of thinking or tool output can come between two pieces of one word. Any other event ends it.
 */
export const keepsWord = (e: AgentEvent) => (typeof e.kind === 'string' && e.kind.endsWith('.delta')) || e.kind === 'agent.status';

/**
 * Whether the message's reply starts again: only for a restart the reader made from the brain's
 * checked restarted block. An event that merely says restarted (an agent.status state, an event of
 * that kind) is not one, or any event's JSON could wipe what was shown. What the old attempt wrote
 * is not part of the answer.
 */
export const startsOver = (e: AgentEvent) => isRestarted(e);

/**
 * Takes the held events that are safe to show, in order, and returns them with the ones still held.
 * A key split across events is hidden as a whole: the group's text is hidden in one piece and
 * carried by the group's first event, the others' text left empty, so the deltas still add up.
 * The events shown are changed in place.
 */
export function releaseEvents(held: AgentEvent[], all: boolean, hide: (text: string) => string): { shown: AgentEvent[]; held: AgentEvent[] } {
  const texts = held.map((h) => (typeof h.delta === 'string' ? h.delta : ''));
  const n = safePieces(texts, all);
  if (!n) return { shown: [], held };
  const shown = held.slice(0, n);
  const whole = hide(texts.slice(0, n).join(''));
  const split = whole !== texts.slice(0, n).map(hide).join('');
  let carried = false;
  for (const g of shown) {
    if (split && typeof g.delta === 'string') {
      g.delta = carried ? '' : whole;
      carried = true;
    }
  }
  return { shown, held: held.slice(n) };
}
