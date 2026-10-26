// Sliding-window limiter used to pace *our* calls to the portal so we stay
// under its per-session budget instead of discovering it via 429s.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SlidingWindowLimiter {
  constructor({ limit, windowMs = 60_000, now = Date.now, wait = sleep }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.wait = wait;
    this.stamps = [];
    this.queue = Promise.resolve();
  }

  /** Resolves when a request may be sent. Callers are served in FIFO order. */
  acquire() {
    const turn = this.queue.then(() => this.#take());
    this.queue = turn.catch(() => {});
    return turn;
  }

  async #take() {
    for (;;) {
      const now = this.now();
      while (this.stamps.length && this.stamps[0] <= now - this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      await this.wait(this.stamps[0] + this.windowMs - now + 5);
    }
  }
}
