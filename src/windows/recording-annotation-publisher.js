/** One vector update in flight, one replaceable pending frame, at most 30 fps. */
export class RecordingAnnotationPublisher {
  constructor(send, onError, schedule = (callback, delay) => setTimeout(callback, delay), cancel = id => clearTimeout(id)) {
    this.send = send; this.onError = onError; this.schedule = schedule; this.cancel = cancel;
    this.revision = 0; this.pending = null; this.timer = null;
    this.sending = false; this.disposed = false; this.last = "";
    this.inFlight = null; this.draining = false; this.failed = false;
  }
  push(value) {
    if (this.disposed) return;
    const signature = JSON.stringify(value);
    if (signature === this.last) return;
    this.last = signature; this.pending = value; this.queue();
  }
  queue() {
    if (this.disposed || this.draining || this.sending || this.timer !== null || !this.pending) return;
    this.timer = this.schedule(() => { this.timer = null; void this.flush(); }, 34);
  }
  async flush() {
    if (this.disposed || this.sending || !this.pending) return;
    const value = this.pending; this.pending = null; this.sending = true;
    try {
      this.inFlight = Promise.resolve().then(() => this.send(++this.revision, value));
      await this.inFlight; this.failed = false;
      if (!this.disposed) this.onError(false);
    }
    catch { this.failed = true; if (!this.disposed) { this.last = ""; this.onError(true); } }
    finally { this.inFlight = null; this.sending = false; this.queue(); }
  }
  /** Stop bypasses the frame timer and waits for the latest serial IPC update. */
  async drain() {
    if (this.disposed) throw new Error("The annotation surface is closed.");
    this.draining = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    try {
      while (!this.disposed && (this.sending || this.pending)) {
        if (this.sending) await this.inFlight?.catch(() => {});
        else await this.flush();
        if (this.failed && !this.pending) throw new Error("Could not publish the final annotation frame.");
      }
      if (this.disposed) throw new Error("The annotation surface is closed.");
      if (this.failed) throw new Error("Could not publish the final annotation frame.");
      return this.revision;
    } finally { this.draining = false; this.queue(); }
  }
  dispose() {
    this.disposed = true; this.pending = null;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}

/** Draft identities never collide with the positive clock-based saved marks. */
export function recordingInkMarks(marks, draft) {
  const supported = new Set(["pen", "arrow", "rectangle", "text"]);
  return [...marks, ...(draft ? [draft] : [])]
    .filter(mark => supported.has(mark.kind) && (mark.kind !== "text" || mark.text.trim()))
    .map(mark => mark.id < 0 ? {...mark, id: Number.MAX_SAFE_INTEGER + mark.id} : mark);
}
