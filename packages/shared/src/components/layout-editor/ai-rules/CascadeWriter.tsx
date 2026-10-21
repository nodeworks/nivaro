import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import { resolveOptionFilterTokens } from '../../../lib/option-filter-tokens'
import { buildCascadeFilter, type CascadeRule } from '../../item-edit/helpers'
import { useLayoutEditorHost } from '../host'
import { RelationLabel } from '../pickers/relation-label'
import { RelationPicker } from '../pickers/relation-picker'
import {
  AiAskPopover,
  aiGhostBtn,
  aiPrimaryBtn,
  aiQuiet,
  aiWarn,
  DroppedList
} from './AiAskPopover'
import type { CascadeAnswer, CascadeRuleDraft } from './api'

/**
 * AI cascade writer (#2674): describe how a picker's options narrow; the AI
 * answers cascade filters and / or an option filter, checked against both
 * collections. Before saving, pick a real record and see its options with and
 * without the change — compiled by the SAME builders the form's pickers use
 * (buildCascadeFilter + resolveOptionFilterTokens) and read from the same
 * /items endpoint, so the preview cannot drift from the form.
 *
 * Saving goes through the field's global writer (every form that shows the
 * field), like the hand editor beside it. A new cascade rule replaces the
 * one following the same parent; the option filter replaces the old one.
 */

/** Current rules with the proposal merged in: one rule per parent, the AI's wins. */
export function mergeCascadeRules(
  current: CascadeRuleDraft[],
  next: CascadeRuleDraft[]
): CascadeRuleDraft[] {
  const parents = new Set(next.map((r) => r.parent_field))
  return [...current.filter((r) => !parents.has(r.parent_field)), ...next]
}

/** The picker's effective filter for a record: cascade ∧ option filter, as FieldRenderer builds it. */
export function previewFilter(
  rules: CascadeRuleDraft[],
  optionFilter: Record<string, unknown> | null,
  record: Record<string, unknown>,
  recordId: string
): Record<string, unknown> | undefined {
  const scalar = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? ((v as { id?: unknown }).id ?? null) : v
  const cascade = buildCascadeFilter({
    rules: rules as CascadeRule[],
    parentValue: (p) => {
      const v = record[p]
      return Array.isArray(v) ? v.map(scalar) : scalar(v)
    }
  }).filter
  const fixed = optionFilter ? resolveOptionFilterTokens(optionFilter, record, recordId) : undefined
  return fixed ? (cascade ? { _and: [fixed, cascade] } : fixed) : cascade
}

type Options = { total: number | null; ids: string[] }

function useOptions(
  related: string,
  filter: Record<string, unknown> | undefined,
  enabled: boolean
) {
  const client = useNivaroClient()
  return useQuery<Options>({
    queryKey: ['layout-editor', 'ai-cascade-preview', related, JSON.stringify(filter ?? null)],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: unknown }>; total?: number | null }>(
          get(`/items/${related}`, {
            fields: 'id',
            limit: 6,
            ...(filter ? { filter: JSON.stringify(filter) } : {})
          })
        )
        .then((r) => ({
          total: typeof r.total === 'number' ? r.total : null,
          ids: (r.data ?? []).map((x) => String(x.id))
        })),
    enabled,
    staleTime: 30_000
  })
}

function OptionsColumn({
  title,
  related,
  q
}: {
  title: string
  related: string
  q: ReturnType<typeof useOptions>
}) {
  return (
    <div className='min-w-0 flex-1 space-y-1'>
      <p className='text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
        {title}
        {q.data?.total != null && (
          <span className='ml-1 tabular-nums text-slate-700 dark:text-foreground'>
            {q.data.total.toLocaleString()}
          </span>
        )}
      </p>
      {q.isLoading ? (
        <p className={aiQuiet}>Loading…</p>
      ) : q.isError ? (
        <p className='text-[12px] text-red-700 dark:text-red-300'>Could not read the options</p>
      ) : q.data?.ids.length ? (
        <ul className='space-y-0.5 text-[12px] text-slate-700 dark:text-foreground'>
          {q.data.ids.map((id) => (
            <li key={id} className='truncate'>
              <RelationLabel relatedCollection={related} id={id} />
            </li>
          ))}
        </ul>
      ) : (
        <p className={aiQuiet}>No options</p>
      )}
    </div>
  )
}

function OptionsPreview({
  collection,
  answer,
  rules,
  currentOptionFilter,
  parentFields
}: {
  collection: string
  answer: CascadeAnswer
  rules: CascadeRuleDraft[]
  currentOptionFilter: Record<string, unknown> | null
  parentFields: string[]
}) {
  const client = useNivaroClient()
  const [recordId, setRecordId] = useState<string | null>(null)
  const fields = [...new Set(['id', ...parentFields, ...tokenFields(answer.option_filter)])]
  const record = useQuery<Record<string, unknown> | null>({
    queryKey: ['layout-editor', 'ai-cascade-record', collection, recordId, fields.join(',')],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> | null }>(
          get(`/items/${collection}/${encodeURIComponent(recordId ?? '')}`, {
            fields: fields.join(',')
          })
        )
        .then((r) => r.data ?? null),
    enabled: !!recordId,
    staleTime: 30_000
  })
  const values = record.data ?? null
  const before = values
    ? previewFilter(rules, currentOptionFilter, values, recordId ?? '')
    : undefined
  const after = values
    ? previewFilter(
        mergeCascadeRules(rules, answer.cascade_filters),
        answer.option_filter ?? currentOptionFilter,
        values,
        recordId ?? ''
      )
    : undefined
  const ready = !!values
  const qBefore = useOptions(answer.related, before, ready)
  const qAfter = useOptions(answer.related, after, ready)
  return (
    <div
      className='space-y-2 rounded-md border border-slate-200 p-2.5 dark:border-border'
      data-ai-cascade-preview=''
    >
      <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
        Try it on a record
      </p>
      <RelationPicker
        relatedCollection={collection}
        value={recordId}
        onChange={(v) => setRecordId(v == null || v === '' ? null : String(v))}
        placeholder='Pick a record…'
      />
      {recordId && record.isError && (
        <p className='text-[12px] text-red-700 dark:text-red-300'>Could not read that record</p>
      )}
      {ready && (
        <div className='flex gap-3'>
          <OptionsColumn title='Today' related={answer.related} q={qBefore} />
          <OptionsColumn title='With this change' related={answer.related} q={qAfter} />
        </div>
      )}
    </div>
  )
}

function tokenFields(filter: Record<string, unknown> | null): string[] {
  if (!filter) return []
  return [...JSON.stringify(filter).matchAll(/"\$parent\.([A-Za-z_][A-Za-z0-9_]*)"/g)]
    .map((m) => m[1])
    .filter((f) => f !== 'id')
}

export function CascadeWriter({
  layoutId,
  collection,
  field,
  rules,
  currentOptionFilter,
  parentFields,
  onApply,
  disabled
}: {
  layoutId: number
  collection: string
  field: string
  rules: CascadeRuleDraft[]
  currentOptionFilter: Record<string, unknown> | null
  /** Scalar (M2O) parents read off the record for the preview. */
  parentFields: string[]
  onApply: (
    next: { rules: CascadeRuleDraft[]; optionFilter: Record<string, unknown> | null },
    label: string
  ) => void
  disabled?: boolean
}) {
  const client = useNivaroClient()
  const host = useLayoutEditorHost()
  if (!host.isAdmin) return null
  return (
    <AiAskPopover<CascadeAnswer>
      testId='cascade'
      label='Write with AI'
      title='Describe which options this picker offers'
      placeholder="only regions of the record's zone, active ones first"
      disabled={disabled}
      ask={async (text) => {
        const res = await client.request<{ data: CascadeAnswer }>(
          post(`/ai-design/layouts/${layoutId}/cascade`, { field, text })
        )
        return res.data
      }}
    >
      {(answer, done, back) => (
        <>
          <ul className='list-disc space-y-1 pl-4 text-[12.5px] leading-snug text-slate-800 dark:text-foreground'>
            {answer.sentences.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {answer.explanation && <p className={aiQuiet}>{answer.explanation}</p>}
          {answer.option_filter && currentOptionFilter && (
            <p className={aiWarn}>The option filter replaces the one this field has today.</p>
          )}
          <DroppedList items={answer.dropped} />
          <OptionsPreview
            collection={collection}
            answer={answer}
            rules={rules}
            currentOptionFilter={currentOptionFilter}
            parentFields={parentFields}
          />
          <p className={aiQuiet}>Saving changes this picker on every form that shows it.</p>
          <div className='flex items-center justify-end gap-1.5 pt-1'>
            <button type='button' className={aiGhostBtn} onClick={back}>
              Back
            </button>
            <button
              type='button'
              className={aiPrimaryBtn}
              data-ai-cascade-apply=''
              onClick={() => {
                onApply(
                  {
                    rules: mergeCascadeRules(rules, answer.cascade_filters),
                    optionFilter: answer.option_filter ?? currentOptionFilter
                  },
                  answer.sentences[0] ?? 'Narrow the options'
                )
                done()
              }}
            >
              Use this
            </button>
          </div>
        </>
      )}
    </AiAskPopover>
  )
}
