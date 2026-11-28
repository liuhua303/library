import type { BookRecord } from '../shared/types';

type BookPatch = Partial<Pick<BookRecord, 'lastLocation' | 'progress' | 'fontSize' | 'theme' | 'language'>>;

/** Retains the newest desired book state until main confirms it was persisted. */
export class BookWriteBuffer {
  private revision = 0;
  private readonly unsaved = new Map<string, { revision: number; patch: BookPatch }>();
  private readonly pending = new Set<Promise<BookRecord>>();

  constructor(private readonly persist: (bookId: string, patch: BookPatch) => Promise<BookRecord>) {}

  save(bookId: string, patch: BookPatch): Promise<BookRecord> {
    const desired = { revision: ++this.revision, patch: { ...this.unsaved.get(bookId)?.patch, ...patch } };
    // Language changes take effect in the reader only after acknowledgement.
    // A failed one must not silently reappear in a later position/close retry,
    // where the renderer would still use the old language's text offsets.
    const retained = { ...desired, patch: { ...desired.patch } };
    delete retained.patch.language;
    if (Object.keys(retained.patch).length) this.unsaved.set(bookId, retained);
    else this.unsaved.delete(bookId);
    const request = Promise.resolve().then(() => this.persist(bookId, desired.patch));
    this.pending.add(request);
    request.then(() => {
      if (this.unsaved.get(bookId)?.revision === desired.revision) this.unsaved.delete(bookId);
      this.pending.delete(request);
    }, () => {
      // A failed normal save remains available for the close handshake to retry.
      this.pending.delete(request);
    });
    return request;
  }

  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    const retry = [...this.unsaved].map(([bookId, desired]) => this.save(bookId, desired.patch));
    // A persistent failure must prevent an automatic close, not be swallowed.
    await Promise.all(retry);
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
