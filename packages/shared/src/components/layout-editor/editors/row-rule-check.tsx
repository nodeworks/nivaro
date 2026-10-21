import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import type { CMSRelation } from '../../pipeline/types'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { tintCard } from '../panel-style'
import { useEditorApi } from './editor-api'
import { editorQueryKeys } from './editor-queries'
import type { RowRuleItem } from './row-rule-row'

/**
 * Static lint over the editor's CURRENT row rules — the causes behind what
 * the tester below shows as symptoms. Pure function of the rule list plus
 * the child's field names; runs on every edit, nothing is saved.
 */
export type RowRuleLintFinding = { tone: 'error' | 'warn' | 'info'; text: string }
export function lintRowRules(
  rules: RowRuleItem[],
  childFieldNames: Set<string>
): RowRuleLintFinding[] {
  const out: RowRuleLintFinding[] = []
  const sorted = rules
    .map((r, idx) => ({ r, idx, sort: r.sort ?? idx }))
    .sort((a, b) => a.sort - b.sort)
  const num = (i: number) => `rule ${i + 1}`
  const fieldExists = (f: string | null | undefined) =>
    !f || f.startsWith('$parent.') || childFieldNames.size === 0 || childFieldNames.has(f)
  for (const { r, idx } of sorted) {
    if (!r.target_field) out.push({ tone: 'error', text: `${num(idx)} has no target field.` })
    else if (!fieldExists(r.target_field))
      out.push({
        tone: 'error',
        text: `${num(idx)} targets "${r.target_field}", which is not a field on this collection.`
      })
    if (!r.trigger_field && !(r.trigger_fields ?? []).length)
      out.push({ tone: 'warn', text: `${num(idx)} has no trigger — it fires on every pass.` })
    for (const t of [r.trigger_field, ...(r.trigger_fields ?? [])])
      if (t && !fieldExists(t))
        out.push({
          tone: 'error',
          text: `${num(idx)} is triggered by "${t}", which is not a field on this collection.`
        })
    if (r.target_type === 'precedence' && !(r.sources ?? []).length)
      out.push({
        tone: 'warn',
        text: `${num(idx)} is a precedence rule with no sources — it always writes empty.`
      })
  }
  // Same target written by several rules: order decides; only-if-empty
  // silently loses to a later unconditional writer.
  const byTarget = new Map<string, Array<{ r: RowRuleItem; idx: number }>>()
  for (const e of sorted) {
    if (!e.r.target_field) continue
    const list = byTarget.get(e.r.target_field) ?? []
    list.push(e)
    byTarget.set(e.r.target_field, list)
  }
  for (const [target, list] of byTarget) {
    const writers = list.filter((e) => e.r.target_type !== 'lock')
    const locks = list.filter((e) => e.r.target_type === 'lock')
    if (writers.length > 1) {
      const sameTrigger = new Set(
        writers.map(
          (e) =>
            `${e.r.trigger_field ?? ''}|${e.r.trigger_op ?? ''}|${e.r.trigger_value ?? ''}|${e.r.trigger_related_field ?? ''}`
        )
      )
      if (sameTrigger.size < writers.length)
        out.push({
          tone: 'warn',
          text: `"${target}" is written by ${writers.map((e) => num(e.idx)).join(' and ')} on the SAME trigger — the later one wins every time; the earlier is dead.`
        })
      else
        out.push({
          tone: 'info',
          text: `"${target}" is written by ${writers.map((e) => num(e.idx)).join(', ')}; on one pass the later rule wins when both fire.`
        })
      for (let i = 0; i < writers.length; i++) {
        const a = writers[i]
        if (!a.r.only_if_empty) continue
        const later = writers.slice(i + 1).filter((b) => !b.r.only_if_empty)
        if (later.length)
          out.push({
            tone: 'warn',
            text: `${num(a.idx)} only fills "${target}" when empty, but ${later.map((b) => num(b.idx)).join(', ')} overwrite${later.length === 1 ? 's' : ''} it later in the same pass — the only-if-empty guard has no effect.`
          })
      }
    }
    if (locks.length && writers.length)
      out.push({
        tone: 'info',
        text: `"${target}" is locked by ${locks.map((e) => num(e.idx)).join(', ')} and set by ${writers.map((e) => num(e.idx)).join(', ')} — rules still write it; the lock only refuses the user's edits.`
      })
  }
  return out
}

export function RowRuleLint({
  rules,
  childFieldNames
}: {
  rules: RowRuleItem[]
  childFieldNames: Set<string>
}) {
  const findings = useMemo(() => lintRowRules(rules, childFieldNames), [rules, childFieldNames])
  if (findings.length === 0)
    return (
      <p className='text-[11px] text-emerald-700 dark:text-emerald-300'>
        No conflicts between these rules.
      </p>
    )
  const tone = (t: RowRuleLintFinding['tone']) =>
    t === 'error'
      ? 'text-red-700 bg-red-50 dark:bg-red-400/10 dark:text-red-300'
      : t === 'warn'
        ? 'text-amber-700 bg-amber-50 dark:bg-amber-400/10 dark:text-amber-300'
        : 'text-slate-600 bg-slate-100 dark:bg-white/5 dark:text-slate-300'
  return (
    <ul className='space-y-1' aria-label='Rule conflicts'>
      {findings.map((f, i) => (
        <li key={i} className={cn('rounded px-2 py-1 text-[11px] leading-snug', tone(f.tone))}>
          {f.text}
        </li>
      ))}
    </ul>
  )
}

/**
 * Dry-run the editor's CURRENT (unsaved) row rules against one real child
 * record and show what every rule did — resolved trigger value, fired or
 * skipped and why, the value it wrote, per-rule ms and the pass's query
 * count. Nothing is written. Mirrors the skip-criteria "Preview impact".
 */
export function RowRuleTester({
  childCollection,
  parentCollection,
  rowRules,
  parentContextFields
}: {
  childCollection: string
  parentCollection: string
  rowRules: RowRuleItem[]
  parentContextFields: string[]
}) {
  const api = useEditorApi()
  const [recordId, setRecordId] = useState('')
  const [changedField, setChangedField] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    record_id: string
    parent_id: string | null
    parent_context: Record<string, unknown>
    trace: Array<{
      index: number
      target_field: string
      target_type: string
      trigger_field: string | null
      trigger_value: unknown
      outcome: string
      value?: unknown
      ms: number
    }>
    locks: string[]
    changes: Record<string, { before: unknown; after: unknown }>
    queries: number
    ms: number
  } | null>(null)
  const { data: rels = [] } = useQuery<CMSRelation[]>({
    queryKey: editorQueryKeys.relationsFor(childCollection),
    queryFn: () =>
      api.get(`/data-model/relations/for/${childCollection}`).then((r) => r.data.data ?? r.data)
  })
  const fkField =
    rels.find((r) => r.many_collection === childCollection && r.one_collection === parentCollection)
      ?.many_field ?? null
  const run = async () => {
    if (!recordId.trim()) return
    setRunning(true)
    setError(null)
    try {
      const r = await api.post('/field-rules/explain', {
        collection: childCollection,
        record_id: recordId.trim(),
        parent_collection: parentCollection,
        fk_field: fkField,
        parent_context_fields: parentContextFields,
        row_rules: rowRules,
        ...(changedField ? { changed_field: changedField } : {})
      })
      setResult(r.data.data)
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Dry run failed'
      )
    } finally {
      setRunning(false)
    }
  }
  const fmt = (v: unknown) =>
    v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const outcomeTone = (o: string) =>
    o === 'wrote'
      ? 'text-emerald-700 bg-emerald-50 dark:bg-emerald-400/10 dark:text-emerald-300'
      : o === 'lock'
        ? 'text-violet-700 bg-violet-50 dark:bg-violet-400/10 dark:text-violet-300'
        : o === 'not-triggered'
          ? 'text-slate-500 bg-slate-100 dark:bg-white/5 dark:text-slate-400'
          : 'text-amber-700 bg-amber-50 dark:bg-amber-400/10 dark:text-amber-300'
  return (
    <div className={cn(tintCard, 'mt-2 space-y-2 p-3')}>
      <div className='space-y-0.5'>
        <Label className='text-[12px] font-medium text-slate-800 dark:text-foreground'>
          Test rules against a record
        </Label>
        <p className='text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
          Uses the rules as edited above. Nothing is saved.
        </p>
      </div>
      <div className='flex flex-wrap items-center gap-1.5'>
        <Input
          value={recordId}
          onChange={(e) => setRecordId(e.target.value)}
          placeholder='Row id'
          className='h-7 min-w-0 flex-1 basis-28 text-[12px]'
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
        />
        <Input
          value={changedField}
          onChange={(e) => setChangedField(e.target.value)}
          placeholder='Changed field (optional)'
          className='h-7 min-w-0 flex-1 basis-36 text-[12px]'
          title='Simulate a live edit of this field; blank = the create-time pass where every rule gets its chance'
        />
        <Button
          size='sm'
          variant='outline'
          className='h-7 text-[12px]'
          onClick={() => void run()}
          disabled={running || !recordId.trim()}
        >
          {running ? 'Running…' : 'Run'}
        </Button>
      </div>
      {error && <p className='mt-1.5 text-[11px] text-red-600 dark:text-red-400'>{error}</p>}
      {result && (
        <div className='mt-2 space-y-2'>
          <div className='flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500'>
            <span>
              record{' '}
              <span className='font-mono text-slate-700 dark:text-slate-300'>
                {result.record_id}
              </span>
            </span>
            <span>
              parent{' '}
              <span className='font-mono text-slate-700 dark:text-slate-300'>
                {result.parent_id ?? '—'}
              </span>
            </span>
            <span>
              {result.queries} {result.queries === 1 ? 'query' : 'queries'} · {result.ms} ms
            </span>
            {result.locks.length > 0 && <span>locked: {result.locks.join(', ')}</span>}
            {Object.keys(result.parent_context).length > 0 && (
              <span>
                parent context:{' '}
                {Object.entries(result.parent_context)
                  .map(([k, v]) => `${k}=${fmt(v)}`)
                  .join(', ')}
              </span>
            )}
          </div>
          <div className='overflow-x-auto rounded border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <table className='w-full text-[11px]'>
              <thead>
                <tr className='text-left text-[11px] text-slate-400'>
                  <th className='px-2 py-1'>#</th>
                  <th className='px-2 py-1'>Target</th>
                  <th className='px-2 py-1'>Trigger → value</th>
                  <th className='px-2 py-1'>Outcome</th>
                  <th className='px-2 py-1'>Wrote</th>
                  <th className='px-2 py-1 text-right'>ms</th>
                </tr>
              </thead>
              <tbody>
                {result.trace.map((t) => (
                  <tr key={t.index} className='border-t border-slate-100 dark:border-border'>
                    <td className='px-2 py-1 text-slate-400'>{t.index + 1}</td>
                    <td className='px-2 py-1 font-mono'>
                      {t.target_field}
                      <span className='ml-1 text-slate-400'>{t.target_type}</span>
                    </td>
                    <td className='px-2 py-1 font-mono text-slate-600 dark:text-slate-300'>
                      {t.trigger_field ?? '—'} → {fmt(t.trigger_value)}
                    </td>
                    <td className='px-2 py-1'>
                      <span
                        className={cn('rounded px-1 py-px font-medium', outcomeTone(t.outcome))}
                      >
                        {t.outcome}
                      </span>
                    </td>
                    <td className='px-2 py-1 font-mono'>
                      {t.outcome === 'wrote' ? fmt(t.value) : ''}
                    </td>
                    <td className='px-2 py-1 text-right tabular-nums text-slate-500'>{t.ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {Object.keys(result.changes).length > 0 ? (
            <div className='text-[11px] text-slate-600 dark:text-slate-300'>
              Would change:{' '}
              {Object.entries(result.changes)
                .map(([k, c]) => `${k}: ${fmt(c.before)} → ${fmt(c.after)}`)
                .join(' · ')}
            </div>
          ) : (
            <div className='text-[11px] text-slate-500'>No field would change on this record.</div>
          )}
        </div>
      )}
    </div>
  )
}
