export interface ScheduledCheck {
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
}

export class CheckScheduler {
  private readonly pending = new Map<string, ScheduledCheck>();

  constructor(private readonly run: (uri: string, signal: AbortSignal) => void | Promise<void>, private readonly delayMs = 500) {}

  schedule(uri: string, immediate = false): void {
    this.cancel(uri);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const current = this.pending.get(uri);
      if (!current || current.controller !== controller) return;
      void Promise.resolve(this.run(uri, controller.signal)).catch(() => undefined).finally(() => {
        if (this.pending.get(uri)?.controller === controller) this.pending.delete(uri);
      });
    }, immediate ? 0 : this.delayMs);
    this.pending.set(uri, { timer, controller });
  }

  cancel(uri: string): void {
    const current = this.pending.get(uri);
    if (!current) return;
    clearTimeout(current.timer);
    current.controller.abort();
    this.pending.delete(uri);
  }

  cancelAll(): void {
    for (const uri of this.pending.keys()) this.cancel(uri);
  }

  get size(): number {
    return this.pending.size;
  }
}
