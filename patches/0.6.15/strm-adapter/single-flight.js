'use strict';

/** Merge concurrent work for one STRM key into one promise. */
class SingleFlight {
  constructor() {
    this.inFlight = new Map();
  }

  has(key) {
    return this.inFlight.has(String(key));
  }

  size() {
    return this.inFlight.size;
  }

  run(key, task) {
    const normalizedKey = String(key);
    const existing = this.inFlight.get(normalizedKey);
    if (existing) return existing;
    const promise = Promise.resolve()
      .then(() => task())
      .finally(() => {
        if (this.inFlight.get(normalizedKey) === promise) this.inFlight.delete(normalizedKey);
      });
    this.inFlight.set(normalizedKey, promise);
    return promise;
  }
}

module.exports = { SingleFlight };
