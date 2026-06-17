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
