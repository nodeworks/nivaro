/**
 * "The client went away before its answer finished" — judged from the connection, not from
 * the error text.
 *
 * How it reaches an error handler: a browser that navigates or closes the tab after its whole
 * request body arrived gets no abort from Fastify (`request.raw.aborted` only turns true while
 * a body is still being read, which is why only POST routes showed this). When the handler
 * then answers with a payload that streams (anything the compression plugin does not answer
 * inline), Fastify finds the response already closed, destroys the payload stream, and that
 * stream's end-of-stream watcher reports ERR_STREAM_PREMATURE_CLOSE to the error handler as
 * if the route had failed.
 *
 * Both halves are required. The error must be an early close, and the response's own
 * connection must have closed before the response finished. A storage read that breaks while
 * the caller is still connected carries the same error code and stays a real failure; a
 * database fault on a request whose caller happened to leave stays a real failure too.
 */
interface ResponseState {
  /** Node sets this on the ServerResponse when its socket closes. */
  destroyed?: boolean
  writableFinished?: boolean
}

/** An early close as Node's stream.pipeline / finished name it, or the older end-of-stream package. */
export function isEarlyCloseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  return e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.message === 'premature close'
}

export function clientLeft(err: unknown, res: ResponseState | null | undefined): boolean {
  return isEarlyCloseError(err) && res?.destroyed === true && res.writableFinished !== true
}
