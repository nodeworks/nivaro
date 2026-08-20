import type { Command } from '@nivaro/sdk'

// Minimal command builders. Avoids importing SDK-internal `cmd` directly
// while keeping the three files that need HTTP commands DRY.

export function get<T>(path: string, params?: Record<string, unknown>): Command<T> {
  return { _method: 'GET', _path: path, _params: params } as Command<T>
}

export function post<T>(path: string, body?: unknown): Command<T> {
  return { _method: 'POST', _path: path, _body: body } as Command<T>
}

export function put<T>(path: string, body?: unknown): Command<T> {
  return { _method: 'PUT', _path: path, _body: body } as Command<T>
}

export function patch<T>(path: string, body?: unknown): Command<T> {
  return { _method: 'PATCH', _path: path, _body: body } as Command<T>
}

export function del<T>(path: string): Command<T> {
  return { _method: 'DELETE', _path: path } as Command<T>
}
