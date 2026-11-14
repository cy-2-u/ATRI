import test from 'node:test';
import assert from 'node:assert/strict';
import { Wakeup, type TimerClock } from '../src/runtime/wakeup.js';

class Clock implements TimerClock {
  value = 0;
  sequence = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.value;
  set(callback: () => void, delay: number): number {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.value + delay, callback });
    return id;
  }
  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  async advance(to: number): Promise<void> {
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > to) break;
      this.value = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.value = to;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('只保留最近定时器，无任务时不持续轮询', async () => {
  const clock = new Clock();
  let calls = 0;
  const scheduler = new Wakeup(
    async () => {
      calls++;
      return undefined;
    },
    (error) => {
      throw error;
    },
    clock,
  );
  scheduler.at(100);
  scheduler.at(200);
  scheduler.at(50);
  assert.equal(clock.timers.size, 1);
  await clock.advance(49);
  assert.equal(calls, 0);
  await clock.advance(50);
  assert.equal(calls, 1);
  await clock.advance(86_400_000);
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
  await scheduler.stop();
});

test('工作中连续唤醒合并为一次补扫，不丢新消息且不并发', async () => {
  const clock = new Clock();
  let release!: () => void;
  let calls = 0,
    active = 0,
    maximum = 0;
  const scheduler = new Wakeup(
    async () => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      if (calls === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      active--;
      return undefined;
    },
    (error) => {
      throw error;
    },
    clock,
  );
  scheduler.wake();
  await clock.advance(0);
  scheduler.wake();
  scheduler.wake();
  scheduler.wake();
  release();
  await flush();
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  await scheduler.stop();
});

test('停止时正在执行的扫描不能重新挂定时器', async () => {
  const clock = new Clock();
  let release!: () => void;
  const scheduler = new Wakeup(
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 1000;
    },
    (error) => {
      throw error;
    },
    clock,
  );
  scheduler.wake();
  await clock.advance(0);
  const stopping = scheduler.stop();
  release();
  await stopping;
  assert.equal(clock.timers.size, 0);
});
