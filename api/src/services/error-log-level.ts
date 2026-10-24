/**
 * How the web and realtime error handlers log a thrown error. A 5xx is a server fault: the
 * error with its stack. Anything below (401, 403, 404, 409…) is the caller's answer: one info
 * line without a stack, so error-level logs, log alerts and the log-rule suggestions count
 * only real failures (a deploy's unauthenticated stream probe logged a stack per call on the
 * realtime tier, 2026-10-24).
 */
interface LevelLogger {
  error(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
}

export function logRouteError(
  log: LevelLogger,
  err: Error & { code?: string },
  status: number,
  url: string
): void {
  if (status >= 500) log.error(err)
  else log.info({ statusCode: status, code: err.code, url }, err.message)
}
