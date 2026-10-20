import { useMemo } from 'react'
import { useNivaroClient } from '../../../context'
import { get, patch, post } from '../../../lib/commands'

/**
 * The editors moved here from the admin Layouts tab were written against
 * admin's axios instance (`api.get(path, { params }).then((r) => r.data.data)`).
 * This keeps that call shape over the shared Nivaro client, so the moved code
 * reads as it did: `r.data` is the response body.
 */
export interface EditorApi {
  get<T = any>(path: string, config?: { params?: Record<string, unknown> }): Promise<{ data: T }>
  post<T = any>(path: string, body?: unknown): Promise<{ data: T }>
  patch<T = any>(path: string, body?: unknown): Promise<{ data: T }>
}

/**
 * The SDK throws `{ status, response: <body> }`; the moved catch sites read
 * axios's `err.response.data.error`. Rethrow in that shape (message and
 * status kept) so every one of them shows the server's words.
 */
function asAxiosError(e: unknown): never {
  const status = (e as { status?: number })?.status
  const body = (e as { response?: unknown })?.response
  if (!(e instanceof Error) || status == null) throw e
  throw Object.assign(new Error(e.message), { status, response: { status, data: body } })
}

export function useEditorApi(): EditorApi {
  const client = useNivaroClient()
  return useMemo(
    () => ({
      get: (path, config) =>
        client.request<any>(get(path, config?.params)).then((data) => ({ data }), asAxiosError),
      post: (path, body) =>
        client.request<any>(post(path, body)).then((data) => ({ data }), asAxiosError),
      patch: (path, body) =>
        client.request<any>(patch(path, body)).then((data) => ({ data }), asAxiosError)
    }),
    [client]
  )
}
