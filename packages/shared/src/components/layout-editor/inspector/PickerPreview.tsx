import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import { userErrorMessage } from '../../../lib/safe-error'
import { cn } from '../../../lib/utils'
import type { CascadeRule } from '../../item-edit/helpers'
import { extractTemplateFields, renderDisplayTemplate } from '../../pipeline/relations'
import { useCollectionBody } from '../collection-meta'
import { m2mParents, previewNarrowing } from '../inspect/picker-preview'
import { effectText, labelText, tintCard } from '../panel-style'
import { RelationPicker } from '../pickers/relation-picker'
import { useFieldCtx } from './field-context'
import { asObject, describeField } from './model'

// #2637: pick a saved record and see the exact options this picker offers it —
// cascades and option filter compiled as the form compiles them, counted step
// by step on the server, picker exclusions applied, with the first 50 options.

interface PreviewAnswer {
  total: number
  steps: Array<{ key: string; label: string; count: number; applies: boolean }>
  excluded: number
  offered: number
  picker_filter: Record<string, unknown> | null
  with_picker_filter: number | null
  rows: Array<Record<string, unknown>>
}

const fmt = (n: number) => n.toLocaleString()

export function PickerPreview({ rules }: { rules: CascadeRule[] }) {
  const ctx = useFieldCtx()
  const { info, env, opts, globalOptions } = ctx
  const client = useNivaroClient()
  const target = info.relatedCollection
  const [itemId, setItemId] = useState<string | null>(null)
  const { data: targetMeta } = useCollectionBody(target)
  const template =
    target === 'nivaro_users'
      ? '{{first_name}} {{last_name}}'
      : ((targetMeta?.display_template as string | null | undefined) ?? null)
  const optionFilter = asObject(opts.option_filter ?? globalOptions.option_filter)
  const optionSort =
    typeof opts.option_sort === 'string' && opts.option_sort && !/^-?label$/.test(opts.option_sort)
      ? opts.option_sort
      : undefined
  const ruleKey = JSON.stringify([rules, optionFilter, optionSort, template])

  const preview = useQuery({
    queryKey: ['layout-editor', 'picker-preview', env.collection, info.field, itemId, ruleKey],
    enabled: !!itemId && !!target,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const record =
        (
          await client.request<{ data: Record<string, unknown> | null }>(
            get(`/items/${env.collection}/${itemId}`, { fields: '*' })
          )
        ).data ?? {}
      // Many-to-many parents: the ids the record links, read from the junction
      // as the form reads its committed links.
      const linked: Record<string, Array<string | number>> = {}
      for (const j of m2mParents(rules, env.collection, ctx.relations)) {
        const rows =
          (
            await client.request<{ data: Array<Record<string, unknown>> }>(
              get(`/items/${j.junction}`, {
                filter: JSON.stringify({ [j.parentFk]: { _eq: itemId } }),
                fields: j.targetFk,
                limit: 200
              })
            )
          ).data ?? []
        linked[j.parent] = rows
          .map((r) => r[j.targetFk])
          .filter((v): v is string | number => v != null && typeof v !== 'object')
      }
      const narrowing = previewNarrowing({
        target: target as string,
        rules,
        optionFilter,
        record,
        itemId: String(itemId),
        linked,
        labelOf: (f) =>
          describeField(
            f,
            ctx.globals,
            ctx.relations,
            env.bundle.placements.find((p) => p.field === f) ?? null
          ).label
      })
      const tmplFields = extractTemplateFields(template).filter((f) => f !== '*' && f !== 'id')
      const answer = await client.request<{ data: PreviewAnswer }>(
        post('/layout-inspect/picker-preview', {
          collection: target,
          steps: narrowing.steps,
          fields: tmplFields,
          sort: optionSort
        })
      )
      return { narrowing, answer: answer.data }
    }
  })

  if (!target) return null
  const data = preview.data
  const err = preview.error as Error | null
  const steps = data?.answer.steps ?? []
  const labelOfRow = (r: Record<string, unknown>) =>
    (template ? renderDisplayTemplate(template, r) : '') || String(r.id ?? '')

  return (
    <div data-setting='field.picker_preview' className='space-y-2'>
      <div className='flex min-h-5 items-center justify-between gap-3'>
        <span className={labelText}>Options for a record</span>
      </div>
      <RelationPicker
        relatedCollection={env.collection}
        value={itemId}
        onChange={(v) => setItemId(v == null || v === '' ? null : String(v))}
        placeholder='Pick a saved record'
      />
      <p data-effect='' className={effectText}>
        What this picker offers on the record you pick, after its cascade filters, option filter and
        picker exclusions.
      </p>
      {itemId && (
        <div data-picker-preview='' className={cn(tintCard, 'space-y-2 p-2.5')}>
          {preview.isLoading ? (
            <p className={effectText}>Working out the options…</p>
          ) : err ? (
            <p className='text-[12px] text-red-700 dark:text-red-300'>
              {userErrorMessage(err, 'The options could not be worked out.')}
            </p>
          ) : data ? (
            <>
              <p
                data-picker-offered={data.answer.offered}
                className='text-[13px] font-semibold text-slate-900 dark:text-foreground'
              >
                {data.answer.offered === 1 ? '1 option' : `${fmt(data.answer.offered)} options`}
              </p>
              {data.narrowing.waitsFor && (
                <p className='flex items-start gap-1.5 text-[12px] leading-snug text-amber-700 dark:text-amber-300'>
                  <AlertTriangle className='mt-[2px] h-3 w-3 shrink-0' />
                  The picker stays disabled on this record until{' '}
                  {describeField(data.narrowing.waitsFor, ctx.globals, ctx.relations, null).label}{' '}
                  has a value.
                </p>
              )}
              <ol className='space-y-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                <li className='flex justify-between gap-2'>
                  <span>Every record</span>
                  <span className='font-mono'>{fmt(data.answer.total)}</span>
                </li>
                {steps.map((s) => (
                  <li key={s.key} className='flex justify-between gap-2'>
                    <span className='min-w-0 truncate'>{s.label}</span>
                    <span className='shrink-0 font-mono'>
                      {s.applies ? fmt(s.count) : 'no effect'}
                    </span>
                  </li>
                ))}
                {data.answer.excluded > 0 && (
                  <li className='flex justify-between gap-2'>
                    <span>Picker exclusions</span>
                    <span className='font-mono'>−{fmt(data.answer.excluded)}</span>
                  </li>
                )}
              </ol>
              {data.answer.picker_filter && data.answer.with_picker_filter != null && (
                <p className={effectText}>
                  The picker filter of this collection would leave{' '}
                  {fmt(data.answer.with_picker_filter)}. The record form's picker does not apply it;
                  enforced API writes do.
                </p>
              )}
              {data.answer.rows.length > 0 && (
                <ul
                  data-picker-options=''
                  className='max-h-48 space-y-0.5 overflow-y-auto border-t border-slate-200/70 pt-1.5 text-[12px] text-slate-800 dark:border-white/[0.07] dark:text-foreground'
                >
                  {data.answer.rows.map((r) => (
                    <li key={String(r.id)} className='truncate'>
                      {labelOfRow(r)}
                    </li>
                  ))}
                  {data.answer.offered > data.answer.rows.length && (
                    <li className={effectText}>
                      and {fmt(data.answer.offered - data.answer.rows.length)} more
                    </li>
                  )}
                </ul>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}
