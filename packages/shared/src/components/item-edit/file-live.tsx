import { FileX } from 'lucide-react'
import { type MutableRefObject, useEffect, useRef, useState } from 'react'

/**
 * A record's Files panel goes live (realtime program 2026-11-14, idea 3).
 *
 * When someone else links or removes a file, the panel re-reads (RecordLiveSync on `$files`).
 * This keeps the change calm: a file that arrives fades in where it lands, and a file that
 * disappears stays a few seconds as a quiet "Removed" row instead of vanishing from under the
 * pointer. The person's own adds and removals are theirs — no fade, no ghost.
 */

/** How long a removed file stays visible as "Removed", and when it starts fading. */
export const REMOVED_SHOW_MS = 6000
export const REMOVED_FADE_MS = 600
/** A local add/remove counts as the person's own for this long (the refetch that follows it). */
export const OWN_FILE_CHANGE_MS = 15_000

const norm = (id: string) => id.toLowerCase()

/** Files that came and went between two reads, minus the person's own changes. Pure. */
export function diffFileIds(
  prev: readonly string[] | null,
  next: readonly string[],
  own: ReadonlyMap<string, number>,
  now = Date.now()
): { arrived: string[]; gone: string[] } {
  if (prev == null) return { arrived: [], gone: [] }
  const mine = (id: string) => {
    const at = own.get(norm(id))
    return at != null && now - at < OWN_FILE_CHANGE_MS
  }
  const before = new Set(prev.map(norm))
  const after = new Set(next.map(norm))
  return {
    arrived: next.filter((id) => !before.has(norm(id)) && !mine(id)),
    gone: prev.filter((id) => !after.has(norm(id)) && !mine(id))
  }
}

/** Remember a file id this person just added or removed (no fade / ghost for it). */
export function noteOwnFileChange(own: MutableRefObject<Map<string, number>>, id: string): void {
  own.current.set(norm(id), Date.now())
}

export interface LiveFileList {
  /** Ids that just arrived from someone else: render with the fade-in. */
  fresh: ReadonlySet<string>
  /** Ids someone else just removed: render as a calm "Removed" row for a few seconds. */
  removed: readonly string[]
  /** Removed rows that are fading out now. */
  leaving: ReadonlySet<string>
}

/**
 * Watch a record's committed file ids (null = not loaded / not applicable). The first read sets
 * the baseline; later reads produce `fresh` and `removed`.
 */
export function useLiveFileList(
  ids: readonly string[] | null,
  own: MutableRefObject<Map<string, number>>
): LiveFileList {
  const prevRef = useRef<string[] | null>(null)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set())
  const [removed, setRemoved] = useState<string[]>([])
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t)
      fn()
    }, ms)
    timers.current.add(t)
  }
  const sig = ids == null ? null : [...ids].map(norm).sort().join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the id signature only
  useEffect(() => {
    if (ids == null) return
    const { arrived, gone } = diffFileIds(prevRef.current, ids, own.current)
    prevRef.current = [...ids]
    if (arrived.length > 0) {
      setFresh((cur) => new Set([...cur, ...arrived]))
      // A file that came back is no longer "Removed".
      setRemoved((cur) => cur.filter((id) => !arrived.some((a) => norm(a) === norm(id))))
      later(
        () =>
          setFresh((cur) => {
            const next = new Set(cur)
            for (const id of arrived) next.delete(id)
            return next
          }),
        2000
      )
    }
    if (gone.length > 0) {
      setRemoved((cur) => [...cur, ...gone.filter((g) => !cur.includes(g))])
      later(
        () => setLeaving((cur) => new Set([...cur, ...gone])),
        REMOVED_SHOW_MS - REMOVED_FADE_MS
      )
      later(() => {
        setRemoved((cur) => cur.filter((id) => !gone.includes(id)))
        setLeaving((cur) => {
          const next = new Set(cur)
          for (const id of gone) next.delete(id)
          return next
        })
      }, REMOVED_SHOW_MS)
    }
  }, [sig])

  useEffect(() => {
    const all = timers.current
    return () => {
      for (const t of all) clearTimeout(t)
      all.clear()
    }
  }, [])

  return { fresh, removed, leaving }
}

/** The quiet row a file leaves behind for a few seconds after someone else removed it. */
export function RemovedFileRow({ name, leaving }: { name: string; leaving?: boolean }) {
  return (
    <div
      data-file-removed
      aria-live='polite'
      className={`flex items-center gap-2 rounded-lg border border-dashed border-slate-200 p-2 transition-opacity duration-500 motion-reduce:transition-none dark:border-border ${
        leaving ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded bg-slate-100 dark:bg-muted'>
        <FileX className='h-4 w-4 text-slate-400 dark:text-muted-foreground' />
      </div>
      <p className='min-w-0 flex-1 truncate text-[12px] text-slate-500 line-through decoration-slate-300 dark:text-muted-foreground dark:decoration-border'>
        {name}
      </p>
      <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-muted dark:text-muted-foreground'>
        Removed
      </span>
    </div>
  )
}
