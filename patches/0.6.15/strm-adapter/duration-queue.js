'use strict';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** A bounded, single-worker queue with a minimum delay between starts. */
class DurationProbeQueue {
  constructor(options = {}) {
    this.intervalMs = Math.max(0, Number(options.intervalMs == null ? 2000 : options.intervalMs));
    this.maxQueue = Math.max(1, Number(options.maxQueue == null ? 1000 : options.maxQueue));
    this.probe = options.probe;
    this.items = [];
    this.running = false;
    this.closed = false;
    this.lastStartedAt = 0;
    this.startedCount = 0;
    this.completedCount = 0;
    this.failedCount = 0;
  }

  get pending() {
    return this.items.length + (this.running ? 1 : 0);
  }

  enqueue(item, task = this.probe) {
    if (this.closed) return Promise.reject(new Error('duration probe queue is closed'));
    if (typeof task !== 'function') return Promise.reject(new Error('duration probe task is not a function'));
    if (this.items.length >= this.maxQueue) {
      const error = new Error('duration probe queue is full');
      error.code = 'PROBE_QUEUE_FULL';
      return Promise.reject(error);
    }
    const promise = new Promise((resolve, reject) => {
      this.items.push({ item, task, resolve, reject });
    });
    this._pump();
    return promise;
  }

  async _pump() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed && this.items.length) {
        const entry = this.items.shift();
        const delay = this.lastStartedAt + this.intervalMs - Date.now();
        if (delay > 0) await sleep(delay);
        this.lastStartedAt = Date.now();
        this.startedCount += 1;
        try {
          const value = await entry.task(entry.item);
          this.completedCount += 1;
          entry.resolve(value);
        } catch (error) {
          this.failedCount += 1;
          entry.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (!this.closed && this.items.length) this._pump();
    }
  }

  close(error = new Error('duration probe queue closed')) {
    this.closed = true;
    while (this.items.length) this.items.shift().reject(error);
  }
}

module.exports = { DurationProbeQueue, sleep };
