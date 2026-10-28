/** One vector update in flight, one replaceable pending frame, at most 30 fps. */
export class RecordingAnnotationPublisher {
  constructor(send, onError, schedule = (callback, delay) => setTimeout(callback, delay), cancel = id => clearTimeout(id)) {
    this.send = send; this.onError = onError; this.schedule = schedule; this.cancel = cancel;
    this.revision = 0; this.pending = null; this.timer = null;
    this.sending = false; this.disposed = false; this.last = "";
  }
  push(value) {
    if (this.disposed) return;
    const signature = JSON.stringify(value);
    if (signature === this.last) return;
    this.last = signature; this.pending = value; this.queue();
  }
  queue() {
    if (this.disposed || this.sending || this.timer !== null || !this.pending) return;
    this.timer = this.schedule(() => { this.timer = null; void this.flush(); }, 34);
  }
  async flush() {
    if (this.disposed || this.sending || !this.pending) return;
    const value = this.pending; this.pending = null; this.sending = true;
    try { await this.send(++this.revision, value); if (!this.disposed) this.onError(false); }
    catch { if (!this.disposed) { this.last = ""; this.onError(true); } }
    finally { this.sending = false; this.queue(); }
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
