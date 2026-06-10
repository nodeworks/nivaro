// ─── Command descriptor ───────────────────────────────────────────────────────
//
// Every SDK command is a plain serializable descriptor consumed by
// `client.request(command)`. Commands never perform I/O themselves, which keeps
// them tree-shakeable and trivially testable.

export interface Command<TResult> {
  _method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  _path: string
  _params?: Record<string, unknown>
  _body?: unknown
  _result?: TResult
}

export function cmd<T>(
  method: Command<T>['_method'],
  path: string,
  params?: Record<string, unknown>,
  body?: unknown
): Command<T> {
  return { _method: method, _path: path, _params: params, _body: body }
}
