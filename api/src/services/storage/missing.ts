/**
 * A stored object that is really not there (a driver's 404 / NoSuchKey / BlobNotFound, a local
 * ENOENT). Hub phase 6 (R6-I-1): the move's file route answers 404 ("missing") only for this;
 * any other read error (throttling, a timeout, a refused credential, the network) is a 5xx the
 * target counts as failed. `status` and `code` are what isMissingObject (traffic taps) reads.
 */
export class StoredObjectMissing extends Error {
  readonly status = 404
  readonly code = 'NoSuchKey'
  constructor(message = 'The stored object is not there.') {
    super(message)
    this.name = 'StoredObjectMissing'
  }
}

/** A read error that means "not there": this class, or a local file that does not exist. */
export function isStoredObjectMissing(err: unknown): boolean {
  if (err instanceof StoredObjectMissing) return true
  return (err as { code?: unknown } | null)?.code === 'ENOENT'
}
