/**
 * One file up to POST /files/upload with progress and cancel. The chat composer
 * and the comment boxes share it (it was inline in the chat composer).
 */

export interface UploadConfig {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
}

export interface UploadHandlers {
  onProgress?: (fraction: number) => void
  onDone: (id: string) => void
  onError: (message: string) => void
}

/** What a person reads when the server refuses an upload. */
export function uploadFailureMessage(status: number, body: string): string {
  if (status === 413) return 'That file is too large to upload.'
  try {
    const msg = (JSON.parse(body) as { error?: unknown }).error
    if (typeof msg === 'string' && msg && !/^(\d{3}\b|[A-Z_]{4,}$)/.test(msg)) return msg
  } catch {
    /* keep the generic message */
  }
  return 'Upload failed'
}

/**
 * True in a "View as" tab: its person rides a window.fetch wrapper (window flag
 * `__nvrViewAsFetch`, admin lib/masquerade-core.ts) that adds the `nvm_` bearer. An
 * XMLHttpRequest never passes through that wrapper, so it would go out on the admin's own
 * cookie and the file would belong to the admin.
 */
export function viewAsFetchActive(): boolean {
  if (typeof window === 'undefined') return false
  return (window as unknown as { __nvrViewAsFetch?: boolean }).__nvrViewAsFetch === true
}

/** The upload as one fetch (no progress): the View-as tab's path, or where XHR is missing. */
function startFetchUpload(
  cfg: UploadConfig,
  file: File,
  handlers: UploadHandlers
): { xhr: { abort: () => void }; abort: () => void } {
  const ctrl = new AbortController()
  const fd = new FormData()
  fd.append('file', file)
  // `fetch` is read at call time, so a View-as tab gets its wrapped window.fetch.
  fetch(`${cfg.apiBase}/files/upload`, {
    method: 'POST',
    headers: cfg.authHeaders,
    credentials: cfg.credentials,
    body: fd,
    signal: ctrl.signal
  })
    .then(async (res) => {
      const text = await res.text().catch(() => '')
      if (!res.ok) return handlers.onError(uploadFailureMessage(res.status, text))
      try {
        handlers.onProgress?.(1)
        handlers.onDone((JSON.parse(text) as { data: { id: string } }).data.id)
      } catch {
        handlers.onError('Upload failed')
      }
    })
    .catch(() => {
      // A cancel is the caller's own doing (an aborted XHR reports nothing either).
      if (!ctrl.signal.aborted) handlers.onError('Upload failed')
    })
  const abort = () => ctrl.abort()
  return { xhr: { abort }, abort }
}

/**
 * Starts the upload; `abort` cancels it. With progress (XMLHttpRequest), except in a
 * "View as" tab, which uploads through fetch so the file belongs to the viewed person.
 */
export function startFileUpload(
  cfg: UploadConfig,
  file: File,
  handlers: UploadHandlers
): { xhr: { abort: () => void }; abort: () => void } {
  if (viewAsFetchActive() || typeof XMLHttpRequest === 'undefined')
    return startFetchUpload(cfg, file, handlers)
  const xhr = new XMLHttpRequest()
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) handlers.onProgress?.(e.loaded / e.total)
  }
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        handlers.onDone((JSON.parse(xhr.responseText) as { data: { id: string } }).data.id)
      } catch {
        handlers.onError('Upload failed')
      }
    } else {
      handlers.onError(uploadFailureMessage(xhr.status, xhr.responseText))
    }
  }
  xhr.onerror = () => handlers.onError('Upload failed')
  xhr.open('POST', `${cfg.apiBase}/files/upload`)
  for (const [k, v] of Object.entries(cfg.authHeaders)) xhr.setRequestHeader(k, v)
  xhr.withCredentials = cfg.credentials === 'include'
  const fd = new FormData()
  fd.append('file', file)
  xhr.send(fd)
  return { xhr, abort: () => xhr.abort() }
}
