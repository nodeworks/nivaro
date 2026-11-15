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

/** Starts the upload; `abort` cancels it. */
export function startFileUpload(
  cfg: UploadConfig,
  file: File,
  handlers: UploadHandlers
): { xhr: XMLHttpRequest; abort: () => void } {
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
