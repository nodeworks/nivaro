import { AlertTriangle, Ruler } from 'lucide-react'
import { useContext, useState } from 'react'
import { userErrorMessage } from '../../../lib/safe-error'
import { cn } from '../../../lib/utils'
import { columnOf, useColumnFacts, useValueLengths } from '../inspect/inspect-api'
import {
  capacityChars,
  fitWarnings,
  SPAN_WORDS,
  typeWords,
  widthCheckApplies,
  widthVerdict
} from '../inspect/width-fit'
import { effectText, labelText, tintCard } from '../panel-style'
import { useFieldCtx } from './field-context'
import { GlobalWriterContext } from './kit'
import { asObject } from './model'

// #2636 / #2634: the column behind the field (type and size), the placement
// settings that cannot fit it, and — on demand — whether the width shows the
// values people actually stored.

const fmt = (n: number) => n.toLocaleString()

export function ColumnFit() {
  const ctx = useFieldCtx()
  const { info, row, ov, env, globalOptions } = ctx
  const { data: facts } = useColumnFacts(env.collection)
  const column = columnOf(facts, row.field)
  const draftOptions = useContext(GlobalWriterContext)?.draft.options
  const mask = String(draftOptions?.input_mask ?? globalOptions.input_mask ?? '')
  const defaults = asObject(env.bundle.layout.default_values)
  const label = typeof ov.label === 'string' && ov.label ? ov.label : info.label
  const showWidth = env.layoutType !== 'table'
  const warnings = fitWarnings({
    column,
    mask: mask || null,
    defaultValue: row.field in defaults ? defaults[row.field] : undefined,
    label: ov.label === '' ? null : label,
    span: row.col_span,
    layoutType: env.layoutType
  })
  const canCheck = showWidth && !!column && widthCheckApplies(info)
  const [run, setRun] = useState(false)
  const lengths = useValueLengths(env.collection, row.field, run && canCheck)

  if (!column && !warnings.length) return null
  const span = row.col_span ?? 12
  const verdict = lengths.data ? widthVerdict(span, lengths.data.p95) : null
  const setSpan = (s: number) =>
    ctx.setPlacement(
      { col_span: s === 12 ? null : s },
      `Set the width of ${info.label} to ${SPAN_WORDS[s]}`
    )

  return (
    <div data-setting='field.column_fit' className='space-y-1.5'>
      <div className='flex min-h-5 items-center justify-between gap-3'>
        <span className={labelText}>Stored as</span>
        {column && (
          <span className='font-mono text-[12px] text-slate-700 dark:text-foreground'>
            {typeWords(column)}
          </span>
        )}
      </div>
      <p data-effect='' className={effectText}>
        {column?.max_length != null
          ? `The database keeps up to ${fmt(column.max_length)} characters.`
          : column
            ? 'What the database column holds.'
            : 'This field has no column of its own.'}
      </p>
      {warnings.map((w) => (
        <p
          key={w.key}
          data-fit-warning={w.key}
          className='flex items-start gap-1.5 text-[12px] leading-snug text-amber-700 dark:text-amber-300'
        >
          <AlertTriangle className='mt-[2px] h-3 w-3 shrink-0' />
          {w.text}
        </p>
      ))}
      {canCheck && !run && (
        <button
          type='button'
          data-width-check=''
          onClick={() => setRun(true)}
          className='inline-flex items-center gap-1.5 text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
        >
          <Ruler className='h-3.5 w-3.5' />
          Check the width against stored values
        </button>
      )}
      {canCheck && run && (
        <div data-width-result='' className={cn(tintCard, 'space-y-1.5 p-2.5')}>
          {lengths.isLoading ? (
            <p className={effectText}>Reading the newest stored values…</p>
          ) : lengths.isError ? (
            <p className='text-[12px] text-red-700 dark:text-red-300'>
              {userErrorMessage(lengths.error, 'The stored values could not be read.')}
            </p>
          ) : !lengths.data || lengths.data.filled === 0 ? (
            <p className={effectText}>No stored values to measure yet.</p>
          ) : (
            <>
              <p className='text-[12px] leading-snug text-slate-700 dark:text-foreground'>
                95% of {fmt(lengths.data.filled)}
                {lengths.data.capped ? ' recent' : ''} values are {fmt(lengths.data.p95)} characters
                or fewer (longest {fmt(lengths.data.max)}). {SPAN_WORDS[span] ?? span} width shows
                about {capacityChars(span)}.
              </p>
              {verdict?.cut ? (
                <p className='text-[12px] leading-snug text-amber-700 dark:text-amber-300'>
                  This width cuts them off.{' '}
                  <button
                    type='button'
                    data-width-apply={verdict.suggest}
                    onClick={() => setSpan(verdict.suggest)}
                    className='font-medium underline'
                  >
                    Use {SPAN_WORDS[verdict.suggest]}
                  </button>
                </p>
              ) : verdict?.roomy ? (
                <p className={effectText}>
                  {SPAN_WORDS[verdict.suggest]} would be enough.{' '}
                  <button
                    type='button'
                    data-width-apply={verdict.suggest}
                    onClick={() => setSpan(verdict.suggest)}
                    className='font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
                  >
                    Use {SPAN_WORDS[verdict.suggest]}
                  </button>
                </p>
              ) : (
                <p className={effectText}>The width fits them.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
