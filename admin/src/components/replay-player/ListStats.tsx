/**
 * The Session replays list's per-recording stats and sort (#1358): active
 * time (input / mutation time, idle gaps capped at 5 s — kept on the row as
 * chunks upload) and a "Most active" order next to "Newest".
 */
import { fmtSkip } from './inactivity'

export type RecordingSort = 'recent' | 'active'

const SORT_KEY = 'nvr.replays.sort'

export function readRecordingSort(): RecordingSort {
  try {
    return window.localStorage.getItem(SORT_KEY) === 'active' ? 'active' : 'recent'
  } catch {
    return 'recent'
  }
}

export function writeRecordingSort(v: RecordingSort): void {
  try {
    window.localStorage.setItem(SORT_KEY, v)
  } catch {
    /* private window — this visit only */
  }
}

/** "Newest | Most active" beside the person's name. */
export function RecordingSortToggle({
  value,
  onChange
}: {
  value: RecordingSort
  onChange: (v: RecordingSort) => void
}) {
  const opts: Array<[RecordingSort, string]> = [
    ['recent', 'Newest'],
    ['active', 'Most active']
  ]
  return (
    <span
      className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'
      title='Sort recordings'
    >
      {opts.map(([v, label]) => (
        <button
          key={v}
          type='button'
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={
            value === v
              ? 'rounded bg-accent px-1.5 py-0.5 text-[10.5px] font-medium text-nvr-navy dark:text-nvr-cyan'
              : 'rounded px-1.5 py-0.5 text-[10.5px] text-slate-400'
          }
          title={
            v === 'active'
              ? 'Most time spent actually doing something first — idle stretches over 5 s count as 5 s'
              : undefined
          }
        >
          {label}
        </button>
      ))}
    </span>
  )
}

/** "4m 12s active" on a row; nothing for recordings made before it was measured. */
export function ActiveTimeChip({ activeMs }: { activeMs?: number | null }) {
  if (activeMs == null) return null
  return (
    <span
      className='shrink-0 text-[11px] tabular-nums text-slate-400'
      title='Time with input or page changes — idle stretches over 5 s count as 5 s'
    >
      {fmtSkip(Number(activeMs))} active
    </span>
  )
}
