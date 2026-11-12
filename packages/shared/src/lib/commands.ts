import type { Command } from '@nivaro/sdk'

export function get<T>(path: string, params?: Record<string, unknown>): Command<T> {
  return { _method: 'GET', _path: path, _params: params } as Command<T>
}

/**
 * "Which form does this record get?" (GET /collection-layouts/active), asked as optional: a
 * collection without a form then answers 200 with no data instead of a 404. Every screen
 * reads it through here so the request log is not filled with expected misses. An older
 * server ignores the flag and still answers 404, so callers keep their catch.
 */
export function getActiveLayout<T>(params: Record<string, unknown>): Command<T> {
  return get<T>('/collection-layouts/active', { ...params, optional: 1 })
}

export function post<T>(path: string, body?: unknown): Command<T> {
  return { _method: 'POST', _path: path, _body: body } as Command<T>
}

export function patch<T>(path: string, body?: unknown): Command<T> {
  return { _method: 'PATCH', _path: path, _body: body } as Command<T>
}

export function put<T>(path: string, body?: unknown): Command<T> {
  return { _method: 'PUT', _path: path, _body: body } as Command<T>
}

export function del<T>(path: string): Command<T> {
  return { _method: 'DELETE', _path: path } as Command<T>
}
