// Minimal synchronous event bus shared by every module.
// Usage: bus.on('toast', fn) → returns an unsubscribe function; bus.emit('toast', { text: 'Hi' }).
// The canonical list of event names & payloads lives in ARCHITECTURE.md §Events.

class EventBus {
  constructor() { this.handlers = new Map(); }

  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }

  off(name, fn) { this.handlers.get(name)?.delete(fn); }

  emit(name, payload) {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (e) { console.error(`[bus] handler for "${name}" threw`, e); }
    }
  }
}

export const bus = new EventBus();

/** Convenience: show a toast message (rendered by src/ui/toast.js). kind: info|warn|success|milestone|error */
export function toast(text, kind = 'info', duration = 3500) {
  bus.emit('toast', { text, kind, duration });
}
