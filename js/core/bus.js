// bus.js — a tiny event emitter, and the app-wide one.
//
// Modules talk through events instead of importing each other's internals:
// the store says 'store:change' after every committed write, settings say
// 'settings:change', and so on (docs/SPEC.md lists them).

export class Emitter {
  constructor() { this._h = new Map(); }

  /** Listen; returns the function that stops listening. */
  on(type, fn) {
    if (!this._h.has(type)) this._h.set(type, new Set());
    this._h.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...a) => { off(); fn(...a); });
    return off;
  }

  off(type, fn) { this._h.get(type)?.delete(fn); }

  emit(type, ...args) {
    const set = this._h.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (err) { console.error(`[bus] ${type} listener failed`, err); }
    }
  }
}

export const bus = new Emitter();
