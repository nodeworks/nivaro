// ─── Command descriptor ───────────────────────────────────────────────────────
//
// Every SDK command is a plain serializable descriptor consumed by
// `client.request(command)`. Commands never perform I/O themselves, which keeps
// them tree-shakeable and trivially testable.
//
// `_phantom` carries the result type at the type level only — it is never
// populated at runtime (avoids leaking a property into serialized forms).

export interface Command<TResult> {
  readonly _method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly _path: string
  readonly _params?: Record<string, unknown>
  readonly _body?: unknown
  /** Cancels the request when it aborts (never serialized; see withSignal). */
  readonly _signal?: AbortSignal
  readonly _phantom?: TResult
}

export function cmd<T>(
  method: Command<T>['_method'],
  path: string,
  params?: Record<string, unknown>,
  body?: unknown
): Command<T> {
  return { _method: method, _path: path, _params: params, _body: body }
}

/**
 * The same command, cancelled when `signal` aborts — e.g. TanStack Query's queryFn signal, so a
 * report widget whose filters changed stops waiting for the answer to the old filters (the
 * server then drops it from its read queue). Without a signal the command is returned as is.
 */
export function withSignal<T>(
  command: Command<T>,
  signal: AbortSignal | null | undefined
): Command<T> {
  return signal ? { ...command, _signal: signal } : command
}
