import type { ReadStream, WriteStream } from 'node:tty';

export interface QuestionInput {
  question(text: string, callback: (answer: string) => void): void;
  close(): void;
}

/** Edit only the current input line. Keys typed during a copy are discarded. */
export class TerminalInput implements QuestionInput {
  private pending?: (answer: string) => void;
  private text: string[] = [];
  private cursor = 0;
  private masked = false;
  private escape = '';
  private closed = false;
  private wasRaw: boolean;
  private ignoreLF = false;
  constructor(private input: ReadStream = process.stdin, private output: WriteStream = process.stdout,
    private interrupt: () => void = () => { process.emit('SIGINT'); }) {
    this.wasRaw = input.isRaw;
    if (input.isTTY) input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', this.receive);
    input.resume();
  }
  question(text: string, callback: (answer: string) => void) { this.begin(text, callback, false); }
  secretQuestion(text: string, callback: (answer: string) => void) { this.begin(text, callback, true); }
  private begin(text: string, callback: (answer: string) => void, masked: boolean) {
    if (this.closed) throw new Error('La terminal se cerró.');
    if (this.pending) throw new Error('Ya hay una pregunta pendiente.');
    this.text = []; this.cursor = 0; this.escape = ''; this.masked = masked; this.pending = callback;
    this.output.write(`${text}\n› `);
  }
  private redraw() {
    const width = Math.max(8, Math.min(72, (this.output.columns || 40) - 4));
    const start = Math.max(0, this.cursor - width);
    const visible = this.text.slice(start, start + width).map((character) => this.masked ? '*' : character).join('');
    if (this.output.isTTY) this.output.write(`\r\u001b[2K› ${visible}\r\u001b[${2 + this.cursor - start}C`);
  }
  private receive = (chunk: string | Buffer) => {
    for (const character of String(chunk)) {
      if (character === '\u0003') { this.interrupt(); return; }
      if (!this.pending) continue;
      if (this.ignoreLF && character === '\n') { this.ignoreLF = false; continue; }
      this.ignoreLF = false;
      if (character === '\u001b') { this.escape = character; continue; }
      if (this.escape) {
        this.escape += character;
        if (this.escape.length === 2 && !['[', 'O'].includes(character)) { this.escape = ''; continue; }
        if (this.escape.length >= 3 && /[A-Za-z~]/.test(character)) {
          if (this.escape === '\u001b[D') this.cursor = Math.max(0, this.cursor - 1);
          if (this.escape === '\u001b[C') this.cursor = Math.min(this.text.length, this.cursor + 1);
          if (['\u001b[H', '\u001bOH', '\u001b[1~'].includes(this.escape)) this.cursor = 0;
          if (['\u001b[F', '\u001bOF', '\u001b[4~'].includes(this.escape)) this.cursor = this.text.length;
          if (this.escape === '\u001b[3~') this.text.splice(this.cursor, 1);
          this.escape = ''; this.redraw();
        } else if (this.escape.length > 16) this.escape = '';
        continue;
      }
      if (character === '\r' || character === '\n') {
        this.ignoreLF = character === '\r';
        const answer = this.text.join('');
        const callback = this.pending;
        this.pending = undefined; this.text = []; this.cursor = 0;
        this.output.write('\n');
        callback(answer);
      } else if (character === '\u007f' || character === '\b') {
        if (this.cursor > 0) this.text.splice(--this.cursor, 1);
        this.redraw();
      } else if (character === '\u0015') {
        this.text = []; this.cursor = 0; this.redraw();
      } else if (character === '\u0017') {
        while (this.cursor && /\s/.test(this.text[this.cursor - 1])) this.text.splice(--this.cursor, 1);
        while (this.cursor && !/\s/.test(this.text[this.cursor - 1])) this.text.splice(--this.cursor, 1);
        this.redraw();
      } else if (character >= ' ' && this.text.length < 2048) {
        this.text.splice(this.cursor++, 0, character); this.redraw();
      }
    }
  };
  close() {
    this.closed = true; this.pending = undefined; this.text = [];
    this.input.off('data', this.receive);
    if (this.input.isTTY) this.input.setRawMode(Boolean(this.wasRaw));
    this.input.pause();
  }
}
