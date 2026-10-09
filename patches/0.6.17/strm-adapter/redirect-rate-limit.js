'use strict';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function nonNegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(number)));
}

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  return Math.max(1, nonNegativeInt(value, fallback, max));
}

function normalizeOptions(options = {}) {
  const retryMaxMs = positiveInt(options.retryMaxMs, 60000, 60 * 1000);
  return {
    maxConcurrent: positiveInt(options.maxConcurrent, 1, 32),
    minIntervalMs: nonNegativeInt(options.minIntervalMs, 1000, 60 * 1000),
    maxQueue: positiveInt(options.maxQueue, 32, 10000),
    cacheTtlMs: nonNegativeInt(options.cacheTtlMs, 0, 60 * 1000),
    // These are starts, not responses. A queued request is not counted
    // until it is actually allowed to issue a Helper HEAD.
    perMinute: positiveInt(options.perMinute, 30, 100000),
    perHour: positiveInt(options.perHour, 1800, 1000000),
    cooldownMs: nonNegativeInt(options.cooldownMs, 1000, 60 * 1000),
    severeCooldownMs: positiveInt(options.severeCooldownMs, 60 * 1000, 60 * 1000),
    severeAfter429: positiveInt(options.severeAfter429, 3, 32),
    retryMaxMs,
  };
}

/**
 * Global, bounded resolver gate shared by stream and download routes.
 *
 * `startTimes` is a sliding-window budget. It is checked before a task is
 * removed from the queue, so a budget wait never emits another Helper HEAD.
 * Concurrent callers for the same pointer still share one promise, and an
 * optional short success cache can be enabled by deployment policy.
 */
class RedirectRateLimiter {
  constructor(options = {}, logger = console) {
    this.logger = logger;
    this.queue = [];
    this.inFlight = new Map();
    this.cache = new Map();
    this.startTimes = [];
    this.running = 0;
    this.lastStartedAt = 0;
    this.timer = null;
    this.closed = false;
    this.cooldownUntil = 0;
    this.consecutiveRateLimits = 0;
    this.metrics = {
      started: 0,
      completed: 0,
      rejected: 0,
      cacheHits: 0,
      budgetWaits: 0,
      rateLimited: 0,
      cooldowns: 0,
      cooldownWaits: 0,
    };
    this.configure(options);
  }

  configure(options = {}) {
    Object.assign(this, normalizeOptions(Object.assign({
      maxConcurrent: this.maxConcurrent,
      minIntervalMs: this.minIntervalMs,
      maxQueue: this.maxQueue,
      cacheTtlMs: this.cacheTtlMs,
      perMinute: this.perMinute,
      perHour: this.perHour,
      cooldownMs: this.cooldownMs,
      severeCooldownMs: this.severeCooldownMs,
      severeAfter429: this.severeAfter429,
    }, options)));
    this._pump();
    return this.options();
  }

  options() {
    return {
      maxConcurrent: this.maxConcurrent,
      minIntervalMs: this.minIntervalMs,
      maxQueue: this.maxQueue,
      cacheTtlMs: this.cacheTtlMs,
      perMinute: this.perMinute,
      perHour: this.perHour,
      cooldownMs: this.cooldownMs,
      severeCooldownMs: this.severeCooldownMs,
      severeAfter429: this.severeAfter429,
    };
  }

  _pruneStarts(now = Date.now()) {
    const cutoff = now - HOUR_MS;
    while (this.startTimes.length && this.startTimes[0] <= cutoff) this.startTimes.shift();
  }

  _budgetState(now = Date.now()) {
    this._pruneStarts(now);
    const minuteCutoff = now - MINUTE_MS;
    let minuteUsed = 0;
    for (let index = this.startTimes.length - 1; index >= 0; index -= 1) {
      if (this.startTimes[index] <= minuteCutoff) break;
      minuteUsed += 1;
    }
    const hourUsed = this.startTimes.length;
    let minuteDelay = 0;
    if (minuteUsed >= this.perMinute) {
      const oldestMinute = this.startTimes[this.startTimes.length - minuteUsed];
      minuteDelay = Math.max(0, oldestMinute + MINUTE_MS - now);
    }
    let hourDelay = 0;
    if (hourUsed >= this.perHour) {
      hourDelay = Math.max(0, this.startTimes[0] + HOUR_MS - now);
    }
    const cooldownDelay = Math.max(0, this.cooldownUntil - now);
    return {
      minuteUsed,
      hourUsed,
      minuteDelay,
      hourDelay,
      cooldownDelay,
      delay: Math.max(minuteDelay, hourDelay, cooldownDelay),
    };
  }

  _cached(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    this.metrics.cacheHits += 1;
    return item.value;
  }

  resolve(key, task) {
    if (this.closed) {
      return Promise.reject(Object.assign(new Error('redirect resolver is closed'), {
        code: 'REDIRECT_RESOLVER_CLOSED', status: 503,
      }));
    }
    if (typeof task !== 'function') {
      return Promise.reject(Object.assign(new Error('redirect resolver task is invalid'), {
        code: 'REDIRECT_TASK_INVALID', status: 500,
      }));
    }
    const normalizedKey = String(key);
    const cached = this._cached(normalizedKey);
    if (cached) return Promise.resolve(cached);
    const existing = this.inFlight.get(normalizedKey);
    if (existing) return existing;
    if (this.queue.length >= this.maxQueue) {
      this.metrics.rejected += 1;
      return Promise.reject(Object.assign(new Error('redirect resolver queue is full'), {
        code: 'REDIRECT_QUEUE_FULL', status: 429,
      }));
    }
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.inFlight.set(normalizedKey, promise);
    this.queue.push({ key: normalizedKey, task, resolve: resolvePromise, reject: rejectPromise });
    this._pump();
    promise.finally(() => {
      if (this.inFlight.get(normalizedKey) === promise) this.inFlight.delete(normalizedKey);
    }).catch(() => undefined);
    return promise;
  }

  _schedule(delay) {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._pump();
    }, Math.max(1, delay));
    this.timer.unref?.();
  }

  _recordTaskError(error) {
    if (Number(error && error.status) === 429) {
      const rateLimitCount = Math.max(1, Math.min(32, Math.floor(Number(error && error.rateLimitCount) || 1)));
      this.metrics.rateLimited += rateLimitCount;
      this.consecutiveRateLimits += rateLimitCount;
      const retryAfter = nonNegativeInt(error && error.retryAfterMs, 0, this.severeCooldownMs);
      const severe = this.consecutiveRateLimits >= this.severeAfter429;
      const cooldown = severe
        ? this.severeCooldownMs
        : Math.min(this.severeCooldownMs, Math.max(this.cooldownMs, retryAfter));
      if (cooldown > 0) {
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldown);
        this.metrics.cooldowns += 1;
      }
      return;
    }
    // A non-429 response breaks the consecutive rate-limit streak. In
    // particular, an authorization/expiry 403 is never treated as throttling.
    this.consecutiveRateLimits = 0;
  }

  _pump() {
    if (this.closed || this.running >= this.maxConcurrent || !this.queue.length) return;
    const now = Date.now();
    const budget = this._budgetState(now);
    const intervalDelay = Math.max(0, this.lastStartedAt + this.minIntervalMs - now);
    if (budget.delay > 0 || intervalDelay > 0) {
      if (budget.minuteDelay > 0 || budget.hourDelay > 0) this.metrics.budgetWaits += 1;
      if (budget.cooldownDelay > 0) this.metrics.cooldownWaits += 1;
      this._schedule(Math.max(budget.delay, intervalDelay));
      return;
    }
    const item = this.queue.shift();
    const startedAt = Date.now();
    this.running += 1;
    this.lastStartedAt = startedAt;
    this.startTimes.push(startedAt);
    this.metrics.started += 1;
    Promise.resolve()
      .then(() => item.task())
      .then(value => {
        this.metrics.completed += 1;
        this.consecutiveRateLimits = 0;
        if (this.cacheTtlMs > 0) {
          this.cache.set(item.key, { value, expiresAt: Date.now() + this.cacheTtlMs });
        }
        item.resolve(value);
      }, error => {
        this._recordTaskError(error);
        item.reject(error);
      })
      .finally(() => {
        this.running -= 1;
        this._pump();
      });
    this._pump();
  }

  status() {
    const now = Date.now();
    const budget = this._budgetState(now);
    return {
      pending: this.queue.length,
      running: this.running,
      started: this.metrics.started,
      completed: this.metrics.completed,
      rejected: this.metrics.rejected,
      cacheHits: this.metrics.cacheHits,
      budgetWaits: this.metrics.budgetWaits,
      rateLimited: this.metrics.rateLimited,
      rateLimited429: this.metrics.rateLimited,
      cooldowns: this.metrics.cooldowns,
      cooldownWaits: this.metrics.cooldownWaits,
      consecutiveRateLimits: this.consecutiveRateLimits,
      cooldownRemainingMs: budget.cooldownDelay,
      budget: {
        minuteUsed: budget.minuteUsed,
        minuteRemaining: Math.max(0, this.perMinute - budget.minuteUsed),
        hourUsed: budget.hourUsed,
        hourRemaining: Math.max(0, this.perHour - budget.hourUsed),
      },
      ...this.options(),
    };
  }

  close(error = Object.assign(new Error('redirect resolver closed'), { code: 'REDIRECT_RESOLVER_CLOSED' })) {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.queue.length) this.queue.shift().reject(error);
    this.cache.clear();
  }
}

module.exports = { RedirectRateLimiter, normalizeOptions };
