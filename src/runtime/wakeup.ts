export interface TimerClock {
  now(): number;
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

const clock: TimerClock = {
  now: Date.now,
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// 单个最近到期定时器；工作中收到唤醒保留一轮，不重复并发扫描队列。
export class Wakeup {
  private timer?: unknown;
  private dueAt = Infinity;
  private running?: Promise<void>;
  private dirty = false;
  private stopped = false;

  constructor(
    private readonly work: () => Promise<number | undefined>,
    private readonly onError: (error: unknown) => void,
    private readonly time: TimerClock = clock,
  ) {}

  at(at: number): void {
    if (this.stopped || !Number.isFinite(at)) return;
    if (this.running) {
      if (at <= this.time.now()) this.dirty = true;
      else this.arm(at);
      return;
    }
    this.arm(at);
  }

  wake(): void {
    this.at(this.time.now());
  }

  private arm(at: number): void {
    if (this.stopped || at >= this.dueAt) return;
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.dueAt = at;
    this.timer = this.time.set(
      () => {
        this.timer = undefined;
        this.dueAt = Infinity;
        if (this.running) {
          this.dirty = true;
          return;
        }
        this.running = this.run().finally(() => {
          this.running = undefined;
        });
      },
      Math.max(0, Math.min(2_147_483_647, at - this.time.now())),
    );
  }

  private async run(): Promise<void> {
    do {
      this.dirty = false;
      try {
        const next = await this.work();
        if (next !== undefined) this.arm(Math.max(this.time.now() + 1, next));
      } catch (error) {
        this.onError(error);
        this.arm(this.time.now() + 1000);
      }
    } while (this.dirty && !this.stopped);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    this.dueAt = Infinity;
    await this.running;
  }
}
