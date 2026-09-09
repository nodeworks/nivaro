import { titleCase } from '../../lib/utils'
import type { ReimportLineDiff } from './reimportDiff'

/**
 * Which columns the file controls and which an auto-fill rule overrides —
 * read before "Apply to form", so an importer knows that the sheet's Price
 * column, say, is not what the lines will carry.
 */
export function ImportColumnChips({
  diff,
  fields
}: {
  diff: ReimportLineDiff
  fields: Array<{ field: string; label?: string | null }>
}) {
  const labelFor = (k: string) => fields.find((f) => f.field === k)?.label || titleCase(k)
  const ruleFields = diff.ruleFields ?? {}
  const fromFile = new Set<string>()
  for (const row of diff.creates) {
    for (const k of Object.keys(row)) {
      if (k.startsWith('__') || k === 'id') continue
      if (ruleFields[k]) continue
      fromFile.add(k)
    }
  }
  for (const u of diff.updates)
    for (const k of Object.keys(u.changes)) if (!k.startsWith('__')) fromFile.add(k)
  const ruleKeys = Object.keys(ruleFields)
  if (fromFile.size === 0 && ruleKeys.length === 0) return null
  const chip =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4'
  return (
    <div className='space-y-1.5'>
      <div className='flex flex-wrap gap-1.5'>
        {[...fromFile].sort().map((k) => (
          <span
            key={k}
            className={`${chip} border-slate-200 bg-white text-slate-600 dark:border-border dark:bg-card dark:text-slate-300`}
          >
            {labelFor(k)}
            <span className='text-slate-400'>· from file</span>
          </span>
        ))}
        {ruleKeys.sort().map((k) => (
          <span
            key={k}
            className={`${chip} border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300`}
            data-tip={`An auto-fill rule sets ${labelFor(k)} on ${ruleFields[k]} new ${ruleFields[k] === 1 ? 'line' : 'lines'} — the file's value does not apply there`}
          >
            {labelFor(k)}
            <span className='opacity-70'>· set by rule ({ruleFields[k]})</span>
          </span>
        ))}
      </div>
      {ruleKeys.length > 0 && (
        <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
          Amber columns are written by this grid&apos;s auto-fill rules; the sheet won&apos;t
          control them.
        </p>
      )}
    </div>
  )
}
