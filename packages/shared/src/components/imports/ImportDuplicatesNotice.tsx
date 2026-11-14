import { CopyCheck } from 'lucide-react'
import { cn, formatNumber } from '../../lib/utils'

/** `duplicates` of POST /api/imports/preview (api services/duplicate-check.ts importDuplicateScan). */
export interface ImportDuplicates {
  fields: string[]
  exact_rows: number
  close_rows: number
  in_file_rows: number
  close: boolean
  rows: Array<{
    row: number
    field: string
    value: string
    match: 'exact' | 'close'
    existing_id?: string
    existing_value?: string
    first_row?: number
  }>
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * New rows of an import that would create a copy of an existing record — the reference
 * list growing a second "MX480". Counts per kind, then the first rows with what they copy.
 * Nothing here stops the import: choose a match field to update instead, or fix the file.
 */
export function ImportDuplicatesNotice({ dup }: { dup: ImportDuplicates }) {
  const total = dup.exact_rows + dup.close_rows + dup.in_file_rows
  if (total === 0) return null
  const parts = [
    dup.exact_rows > 0 &&
      `${formatNumber(dup.exact_rows)} ${plural(dup.exact_rows, 'copies', 'copy')} an existing record`,
    dup.close_rows > 0 &&
      `${formatNumber(dup.close_rows)} ${plural(dup.close_rows, 'nearly copies', 'nearly copy')} one`,
    dup.in_file_rows > 0 &&
      `${formatNumber(dup.in_file_rows)} ${plural(dup.in_file_rows, 'repeats', 'repeat')} an earlier row`
  ].filter(Boolean) as string[]
  return (
    <div
      data-import-duplicates
      className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10'
    >
      <p className='flex items-start gap-1.5 text-[12px] font-medium text-amber-800 dark:text-amber-300'>
        <CopyCheck className='mt-[2px] h-3.5 w-3.5 shrink-0' aria-hidden />
        <span>
          {formatNumber(total)} new {plural(total, 'row', 'rows')} would create a duplicate
          {' — '}
          {parts.join(', ')}
        </span>
      </p>
      <p className='mt-0.5 pl-5 text-[11px] text-amber-700/90 dark:text-amber-300/80'>
        Compared on {dup.fields.join(', ')}. To update the existing records instead, choose a match
        field; otherwise remove these rows from the file.
      </p>
      <ul className='mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-5 text-[11.5px] text-amber-800 dark:text-amber-200'>
        {dup.rows.map((r) => (
          <li key={`${r.row}-${r.field}`} data-import-duplicate-row={r.row}>
            <span className='text-amber-600/80 dark:text-amber-400/70'>Row {r.row}:</span>{' '}
            <span className='font-medium'>{r.value}</span>{' '}
            <span
              className={cn(
                r.match === 'exact'
                  ? 'text-amber-800 dark:text-amber-200'
                  : 'text-amber-700/80 dark:text-amber-300/70'
              )}
            >
              {r.first_row != null
                ? `repeats row ${r.first_row}`
                : r.match === 'exact'
                  ? 'already exists'
                  : `looks like “${r.existing_value ?? ''}”`}
            </span>
          </li>
        ))}
      </ul>
      {dup.rows.length < dup.exact_rows + dup.close_rows + dup.in_file_rows && (
        <p className='mt-0.5 pl-5 text-[11px] text-amber-700/80 dark:text-amber-300/70'>
          First {formatNumber(dup.rows.length)} shown.
        </p>
      )}
    </div>
  )
}
