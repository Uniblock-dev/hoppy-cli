/**
 * A small Markdown renderer for a reply that arrives in pieces, for a colour terminal: **bold**,
 * `inline code`, fenced code blocks, headings, bullet and numbered lists and quotes, with words
 * wrapped to the terminal's width. It is given text that hide() has already checked. Taking a mark
 * out of a word can join its two halves into a key hide() could not see (ak_**<hex>**), so each word
 * is checked again as the screen shows it, and printed hidden and unstyled when that finds one. A
 * code block's own lines are printed exactly as written, so a copy from the screen is the code.
 */

const BOLD = '\x1b[1m';
const BOLD_OFF = '\x1b[22m';
const DIM = '\x1b[2m';
const CODE = '\x1b[36m';
const CODE_OFF = '\x1b[39m';
const RESET = '\x1b[0m';

const FENCE = /^\s*(`{3,}|~{3,})/;

export class Markdown {
           #width        ;
  /** Text not looked at yet: the start of a line not yet known to be a heading, list or fence. */
  #buf = '';
  /** An open code block's lines, its opening line first; shown whole when it closes or the reply ends. */
  #fence                  = null;
  #fenceMark = '';
  #lineStart = true;
  #col = 0;
  /** Where a wrapped line of the current block starts, such as after a list's bullet. */
  #indent = 0;
  #heading = false;
  #bold = false;
  /** The length of the backtick run that opened the code span, or 0 outside one. */
  #code = 0;
  #word = '';
  /** The pending word as the screen shows it, without colour codes. */
  #plain = '';
  #wordLen = 0;
  #spaces = '';
  /** flush() printed a word that may go on in the next piece: its rest is never wrapped away from it. */
  #cont = false;
           #hide                          ;

  /** width: the terminal's columns; a word that would pass it starts a new line. hide: what takes a key out of text. */
  constructor(width        , hide                           = (text) => text) {
    this.#width = Math.max(20, width);
    this.#hide = hide;
  }

  /** The screen went to a new line for something else, such as a tool step's line. */
  newLine() {
    this.#col = 0;
  }

  /** Takes the next piece of the reply; returns what can be shown now. */
  push(text        )         {
    this.#buf += text;
    return this.#drain(false);
  }

  /**
   * Shows the word being written now, without waiting for the space after it: the caller knows the
   * piece ended at the end of a word. A line start or code block not yet known stays held.
   */
  flush()         {
    if (this.#fence || this.#lineStart) return '';
    const s = this.#flushWord();
    if (s) this.#cont = true;
    return s;
  }

  /** The reply has ended: returns everything still held, an open code block included, styles closed. */
  end()         {
    let s = this.#drain(true);
    if (this.#fence) s += this.#showFence(null);
    s += this.#flushWord() + this.#closeStyles();
    this.#lineStart = true;
    this.#indent = 0;
    this.#spaces = '';
    return s;
  }

  #drain(final         )         {
    let out = '';
    while (this.#buf) {
      if (this.#fence) {
        const nl = this.#buf.indexOf('\n');
        if (nl < 0 && !final) break;
        const line = nl < 0 ? this.#buf : this.#buf.slice(0, nl);
        this.#buf = nl < 0 ? '' : this.#buf.slice(nl + 1);
        const close = line.trim();
        if (close.length >= this.#fenceMark.length && close === close[0].repeat(close.length) && close.startsWith(this.#fenceMark)) out += this.#showFence(line);
        else this.#fence.push(line);
        continue;
      }
      if (this.#lineStart) {
        const nl = this.#buf.indexOf('\n');
        const head = nl < 0 ? this.#buf : this.#buf.slice(0, nl);
        if (nl < 0 && !final && !decided(head)) break;
        const fence = FENCE.exec(head);
        if (fence) {
          this.#fence = [head];
          this.#fenceMark = fence[1];
          this.#buf = nl < 0 ? '' : this.#buf.slice(nl + 1);
          continue;
        }
        out += this.#startLine(head, nl >= 0);
        continue;
      }
      const c = this.#buf[0];
      if (c === '\n') {
        out += this.#flushWord() + this.#closeStyles() + '\n';
        this.#buf = this.#buf.slice(1);
        this.#lineStart = true;
        this.#col = 0;
        this.#indent = 0;
        this.#spaces = '';
        this.#cont = false;
        continue;
      }
      if (c === '`') {
        const run = /^`+/.exec(this.#buf) [0];
        // A run at the end of the piece may go on in the next one.
        if (run.length === this.#buf.length && !final) break;
        this.#buf = this.#buf.slice(run.length);
        if (!this.#code) {
          this.#code = run.length;
          this.#word += CODE;
        } else if (run.length === this.#code) {
          this.#code = 0;
          this.#word += CODE_OFF;
        } else this.#add(run);
        continue;
      }
      if (c === '*' && !this.#code) {
        if (this.#buf === '*' && !final) break;
        if (this.#buf.startsWith('**')) {
          this.#buf = this.#buf.slice(2);
          this.#bold = !this.#bold;
          this.#word += this.#bold ? BOLD : BOLD_OFF + (this.#heading ? BOLD : '');
          continue;
        }
      }
      if ((c === ' ' || c === '\t') && !this.#code) {
        out += this.#flushWord();
        this.#spaces += c;
        this.#buf = this.#buf.slice(1);
        continue;
      }
      this.#add(c);
      this.#buf = this.#buf.slice(1);
    }
    if (final) out += this.#flushWord();
    return out;
  }

  #add(text        ) {
    this.#word += text;
    this.#plain += text;
    this.#wordLen += text.length;
  }

  /** Reads what kind of line this is and shows its mark: a heading, a list item, a quote or a rule. */
  #startLine(head        , whole         )         {
    this.#lineStart = false;
    this.#col = 0;
    let m                        ;
    if (whole && /^\s*([-*_])(\s*\1){2,}\s*$/.test(head)) {
      this.#buf = this.#buf.slice(head.length);
      this.#lineStart = true;
      this.#buf = this.#buf.startsWith('\n') ? this.#buf.slice(1) : this.#buf;
      return `${DIM}${'─'.repeat(Math.min(this.#width, 40))}${RESET}\n`;
    }
    if ((m = /^#{1,6}[ \t]+/.exec(head))) {
      this.#buf = this.#buf.slice(m[0].length);
      this.#heading = true;
      this.#indent = 0;
      return BOLD;
    }
    if ((m = /^([ \t]*)[-*+][ \t]+/.exec(head))) {
      this.#buf = this.#buf.slice(m[0].length);
      const mark = `${m[1]}• `;
      this.#indent = this.#col = mark.length;
      return `${m[1]}${DIM}•${RESET} `;
    }
    if ((m = /^([ \t]*)(\d+[.)])[ \t]+/.exec(head))) {
      this.#buf = this.#buf.slice(m[0].length);
      this.#indent = this.#col = m[0].length;
      return m[0];
    }
    if ((m = /^>[ \t]?/.exec(head))) {
      this.#buf = this.#buf.slice(m[0].length);
      this.#indent = this.#col = 2;
      return `${DIM}│${RESET} `;
    }
    const lead = /^[ \t]*/.exec(head) [0];
    this.#indent = lead.length;
    return '';
  }

  /** Shows the pending word, on a new line when it would pass the width. */
  #flushWord()         {
    if (!this.#word) return '';
    let s = '';
    const glued = this.#cont && !this.#spaces;
    this.#cont = false;
    if (this.#wordLen && !glued && this.#col > this.#indent && this.#col + this.#spaces.length + this.#wordLen > this.#width) {
      s = `\n${' '.repeat(this.#indent)}`;
      this.#col = this.#indent;
    } else {
      s = this.#spaces;
      this.#col += this.#spaces.length;
    }
    const hidden = this.#hide(this.#plain);
    // Shown unstyled, then the styles still open after the word are put back.
    if (hidden !== this.#plain) s += `${CODE_OFF}${BOLD_OFF}${hidden}${this.#code ? CODE : ''}${this.#bold || this.#heading ? BOLD : ''}`;
    else s += this.#word;
    this.#col += this.#wordLen;
    this.#word = '';
    this.#plain = '';
    this.#wordLen = 0;
    this.#spaces = '';
    return s;
  }

  /** A line's styles end with it: a ** or ` left open does not colour the next line. */
  #closeStyles()         {
    let s = '';
    if (this.#code) s += CODE_OFF;
    if (this.#bold || this.#heading) s += BOLD_OFF;
    this.#code = 0;
    this.#bold = false;
    this.#heading = false;
    return s;
  }

  /** A whole code block: its fence lines dim, its own lines exactly as written. closing is null when the reply ended first. */
  #showFence(closing               )         {
    const [open, ...lines] = this.#fence ;
    this.#fence = null;
    this.#lineStart = true;
    this.#col = 0;
    let s = `${DIM}${open}${RESET}\n`;
    for (const l of lines) s += `${l}\n`;
    if (closing !== null) s += `${DIM}${closing}${RESET}\n`;
    return s;
  }
}

/** True once the start of a line says what kind of line it is, so it can be shown before its end comes. */
function decided(head        )          {
  const t = head.trimStart();
  if (!t) return false;
  // A fence needs its whole first line; one or two backticks may yet be the start of one.
  if (/^(```|~~~)/.test(t) || /^[`~]{1,2}$/.test(t)) return false;
  // Only dashes, stars, underscores and spaces may yet be a rule, which needs the whole line.
  if (/^[-*_\s]+$/.test(t)) return false;
  if (!/^[#\-*+>_0-9]/.test(t)) return true;
  return /\s/.test(t) || t.length >= 16;
}
