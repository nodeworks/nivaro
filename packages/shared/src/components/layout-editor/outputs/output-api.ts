import type { HelpSheetRow, UploadedHelpRow } from './help-sheet'

// The client side of api/src/routes/layout-output.ts (#2721 #2724 #2729): files
// come back as bytes, so these use fetch with the host's auth, not the SDK client.

export interface FetchConfig {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
}

export interface DownloadedFile {
  blob: Blob
  filename: string
}

async function failure(resp: Response): Promise<Error> {
  let message = `Something went wrong (${resp.status})`
  try {
    const body = (await resp.json()) as { error?: string }
    if (body.error) message = body.error
  } catch {
    /* keep the status line */
  }
  return new Error(message)
}

function filenameOf(resp: Response, fallback: string): string {
  const m = /filename="([^"]+)"/.exec(resp.headers.get('Content-Disposition') ?? '')
  return m?.[1] ?? fallback
}

async function getFile(cfg: FetchConfig, path: string, fallback: string): Promise<DownloadedFile> {
  const resp = await fetch(`${cfg.apiBase}${path}`, {
    headers: cfg.authHeaders,
    credentials: cfg.credentials
  })
  if (!resp.ok) throw await failure(resp)
  return { blob: await resp.blob(), filename: filenameOf(resp, fallback) }
}

async function postFile(
  cfg: FetchConfig,
  path: string,
  body: unknown,
  fallback: string
): Promise<DownloadedFile> {
  const resp = await fetch(`${cfg.apiBase}${path}`, {
    method: 'POST',
    headers: { ...cfg.authHeaders, 'Content-Type': 'application/json' },
    credentials: cfg.credentials,
    body: JSON.stringify(body)
  })
  if (!resp.ok) throw await failure(resp)
  return { blob: await resp.blob(), filename: filenameOf(resp, fallback) }
}

export const downloadTemplate = (cfg: FetchConfig, layoutId: number) =>
  getFile(cfg, `/collection-layouts/${layoutId}/spreadsheet-template`, 'template.xlsx')

export const downloadRecords = (cfg: FetchConfig, layoutId: number, limit = 5000) =>
  postFile(cfg, `/collection-layouts/${layoutId}/spreadsheet-export`, { limit }, 'records.xlsx')

export const downloadBlankForm = (cfg: FetchConfig, layoutId: number) =>
  getFile(cfg, `/collection-layouts/${layoutId}/blank-form`, 'blank-form.pdf')

export const downloadHelpSheet = (cfg: FetchConfig, rows: HelpSheetRow[], name: string) =>
  postFile(cfg, '/collection-layouts/help-sheet/xlsx', { rows, name }, 'help-text.xlsx')

/** base64 of the file's bytes, in chunks so a big sheet does not blow the argument limit. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export async function parseHelpSheetFile(cfg: FetchConfig, file: File): Promise<UploadedHelpRow[]> {
  const resp = await fetch(`${cfg.apiBase}/collection-layouts/help-sheet/parse`, {
    method: 'POST',
    headers: { ...cfg.authHeaders, 'Content-Type': 'application/json' },
    credentials: cfg.credentials,
    body: JSON.stringify({ file: await toBase64(file) })
  })
  if (!resp.ok) throw await failure(resp)
  return ((await resp.json()) as { data: { rows: UploadedHelpRow[] } }).data.rows
}

/** Hand a downloaded file to the browser. */
export function saveFile({ blob, filename }: DownloadedFile): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
