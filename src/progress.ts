import type { CloneEvent } from './src/types';
import type { WriteStream } from 'node:tty';

export function elapsedTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export class ProgressDisplay {
  private started = 0;
  private label = '';
  private current = 0;
  private total = 0;
  private waitUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  private errorCounts = new Map<string, number>();
  constructor(private output: WriteStream = process.stdout) {}
  reset() { this.stop(); this.errorCounts.clear(); }
  start(label: string) {
    this.stop(); this.started = Date.now(); this.label = label;
    this.current = 0; this.total = 0; this.waitUntil = 0;
    this.output.write(`\n▶ ${label}\n`);
    if (this.output.isTTY) {
      this.timer = setInterval(() => this.draw(), 1000);
      this.timer.unref(); this.draw();
    }
  }
  update(label: string, current?: number, total?: number) {
    this.label = label;
    if (current !== undefined) this.current = current;
    if (total !== undefined) this.total = total;
    this.draw();
  }
  event(event: CloneEvent) {
    if (event.kind === 'progress') {
      if (event.current === undefined) this.start(event.feature);
      else this.update(event.name ?? event.feature, event.current, event.total);
    } else if (event.kind === 'copied') {
      this.waitUntil = 0; this.draw();
    } else {
      this.waitUntil = 0;
      const key = `${event.feature}:${event.reason}`;
      const count = (this.errorCounts.get(key) ?? 0) + 1;
      this.errorCounts.set(key, count);
      if (count <= 2) this.log(`! ${event.feature}${event.name ? ` · ${event.name}` : ''}: ${event.reason ?? 'Omitido'}`);
      if (count === 3) this.log('! Más elementos con el mismo motivo: detalles en el informe.');
    }
  }
  rateLimit(data: { timeout: number }) {
    this.waitUntil = Date.now() + Math.max(0, data.timeout);
    if (!this.output.isTTY) this.log(`… Discord pide esperar ${Math.ceil(data.timeout / 1000)} s.`);
    this.draw();
  }
  log(text: string) {
    if (this.output.isTTY && this.timer) this.output.write('\r\u001b[2K');
    this.output.write(text + '\n'); this.draw();
  }
  private draw() {
    if (!this.output.isTTY || !this.timer) return;
    const waiting = Math.ceil(Math.max(0, this.waitUntil - Date.now()) / 1000);
    const detail = waiting ? `Discord espera ${waiting}s` : this.label;
    const counter = this.total ? `${this.current}/${this.total} · ` : '';
    const line = `◌ ${elapsedTime(Date.now() - this.started)} · ${counter}${detail}`;
    const width = Math.max(16, (this.output.columns || 40) - 1);
    const truncated = Array.from(line).slice(0, width).join('');
    this.output.write(`\r\u001b[2K${truncated}`);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer); this.timer = undefined;
      this.output.write('\r\u001b[2K');
    }
  }
}
