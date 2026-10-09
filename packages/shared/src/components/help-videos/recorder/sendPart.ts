import { serverMessage } from './failure'

/** Uploads one part as raw octet-stream (the SDK has no command for it).
 *  A refusal throws an Error carrying the server's sentence, `status` and `code`. */
export function partSender(cfg: {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
}) {
  return async (uploadId: string, n: number, blob: Blob, signal?: AbortSignal): Promise<void> => {
    const res = await fetch(`${cfg.apiBase}/help-videos/uploads/${uploadId}/parts/${n}`, {
      method: 'PUT',
      credentials: cfg.credentials,
      headers: { 'Content-Type': 'application/octet-stream', ...cfg.authHeaders },
      body: blob,
      signal
    })
    if (res.ok) return
    const body = (await res.json().catch(() => ({}))) as {
      error?: string
      message?: string
      code?: string
    }
    throw Object.assign(
      new Error(serverMessage(body) ?? 'The server did not accept part of the recording'),
      { status: res.status, code: body.code }
    )
  }
}
