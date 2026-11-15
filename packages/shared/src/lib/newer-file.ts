import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'
import { LIVE_ASPECTS, useLiveRecord } from './live'

/**
 * "A newer version of this file exists" (realtime round 8, item 19).
 *
 * An open file preview reads the file's details once (GET /files/:id/meta — the same access
 * check as the file itself, services/file-access.ts) and keeps them as the version on screen.
 * When the record it was opened from hears that its files changed (`$files`: a file renamed,
 * replaced or removed), the preview reads the details again — once, coalesced — and, when the
 * file is not the one on screen any more, offers "Show newer". Nothing reloads by itself: the
 * person may be reading the page they opened.
 */

export interface FileMeta {
  id: string
  filename_download?: string | null
  title?: string | null
  type?: string | null
  filesize?: number | string | null
  modified_on?: string | null
  uploaded_on?: string | null
}

export type NewerFile =
  | { kind: 'none' }
  | { kind: 'newer'; renamed: string | null; replaced: boolean; meta: FileMeta }
  | { kind: 'gone' }

/** What differs between the version on screen and the latest details (pure; exported for tests). */
export function compareFileMeta(shown: FileMeta | null, latest: FileMeta | null): NewerFile {
  if (!shown) return { kind: 'none' }
  if (!latest) return { kind: 'gone' }
  const name = (m: FileMeta) => m.filename_download || m.title || ''
  const renamed = name(latest) !== name(shown) ? name(latest) || null : null
  const stamp = (m: FileMeta) => `${m.modified_on ?? ''}|${m.filesize ?? ''}|${m.type ?? ''}`
  const replaced = stamp(latest) !== stamp(shown) && !renamedOnly(shown, latest)
  if (!renamed && !replaced) return { kind: 'none' }
  return { kind: 'newer', renamed, replaced, meta: latest }
}

/** A rename touches modified_on too; the bytes are the same when size and type are. */
function renamedOnly(a: FileMeta, b: FileMeta): boolean {
  const name = (m: FileMeta) => m.filename_download || m.title || ''
  return (
    name(a) !== name(b) &&
    String(a.filesize ?? '') === String(b.filesize ?? '') &&
    a.type === b.type
  )
}

/** The file URL for one version (cache-busted so the browser fetches the new bytes). */
export function versionedUrl(url: string, meta: FileMeta | null): string {
  const v = meta?.modified_on || meta?.uploaded_on
  if (!v) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(v))}`
}

export function useNewerFile(
  fileId: string | null | undefined,
  record: { collection: string; itemId: string | number } | null | undefined
): {
  /** The newer version the person asked for (null = still the one opened). */
  current: FileMeta | null
  newer: NewerFile
  showNewer: () => void
} {
  // Optional: a host without a client (a static embed) just shows the file it was given.
  const client = useOptionalNivaroClient()
  const [shown, setShown] = useState<FileMeta | null>(null)
  const [current, setCurrent] = useState<FileMeta | null>(null)
  const [newer, setNewer] = useState<NewerFile>({ kind: 'none' })
  const shownRef = useRef<FileMeta | null>(null)
  shownRef.current = shown

  const read = useCallback(
    () =>
      fileId && client
        ? client
            .request<{ data: FileMeta }>(get(`/files/${encodeURIComponent(fileId)}/meta`))
            .then((r) => r.data ?? null)
            .catch((err: { status?: number; response?: { status?: number } }) => {
              const status = err?.status ?? err?.response?.status
              // Removed, or no longer readable for this person: say it is gone.
              return status === 404 || status === 403 ? null : undefined
            })
        : Promise.resolve(undefined),
    [client, fileId]
  )

  // The version on screen: read once when the preview opens.
  useEffect(() => {
    let stop = false
    setNewer({ kind: 'none' })
    setShown(null)
    setCurrent(null)
    void read().then((m) => {
      if (!stop && m) setShown(m)
    })
    return () => {
      stop = true
    }
  }, [read])

  useLiveRecord(
    record?.collection,
    record?.itemId ?? null,
    (batch) => {
      if (batch.changedFields && !batch.changedFields.includes(LIVE_ASPECTS.files)) return
      void read().then((latest) => {
        if (latest === undefined) return
        setNewer(compareFileMeta(shownRef.current, latest))
      })
    },
    { enabled: !!fileId && !!record && !!client, debounceMs: 1000 }
  )

  const showNewer = useCallback(() => {
    if (newer.kind !== 'newer') return
    setShown(newer.meta)
    setCurrent(newer.meta)
    setNewer({ kind: 'none' })
  }, [newer])

  return { current, newer, showNewer }
}
