import { useQueries } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { applyDisplayTemplate } from './helpers'

/**
 * Find in record (#82): search this form's fields by label or current value
 * and jump to the match — long multi-tab forms make "where is the vendor
 * field" a real question. Jumping uses the same scroll+flash the integrity
 * banner uses; a field on another tab that isn't mounted can't be flashed, so
 * the row says which section it lives in.
 *
 * Values are FRIENDLY: the host passes relation descriptors instead of raw
 * FKs, and this component resolves display-template labels lazily (only once
 * the popover opens) — one batched /items query per target collection for
 * M2O/M2M ids, one per O2M field. Searching "example" finds the vendor field
 * even though the draft only holds vendor id 802.
 */
export interface FindableRelation {
  kind: 'm2o' | 'm2m' | 'o2m'
  /** Collection whose rows label this field's value(s). */
  target: string
  /** m2o: the single FK; m2m: committed+staged junction ids. */
  ids?: Array<string | number>
  /** o2m only: the child column pointing back at this record. */
  fkField?: string
  /** o2m only: this record's id. */
  parentId?: string | number
}

export interface FindableField {
  field: string
  label: string
  group?: string | null
  /** Synchronous friendly value (booleans → Yes/No, choices → their text). */
  value: string
  relation?: FindableRelation
}

const O2M_LIMIT = 12

function rowLabel(tmpl: string | null | undefined, row: Record<string, unknown>): string {
  // Dotted template tokens resolve empty on a flat row — strip the dangling
  // separator they leave behind ("· Line 1" → "Line 1").
  const templated = tmpl
    ? applyDisplayTemplate(tmpl, row)
        .trim()
        .replace(/^[\s·|:—–-]+/, '')
        .replace(/[\s·|:—–-]+$/, '')
    : ''
  if (templated) return templated
  const fallback = row.name ?? row.title ?? row.label ?? row.subject
  return fallback != null && String(fallback).trim() !== '' ? String(fallback) : `#${row.id}`
}

/** Highlights the first occurrence of the needle inside friendly text. */
function Hi({ text, needle }: { text: string; needle: string }) {
  const i = needle ? text.toLowerCase().indexOf(needle) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <span className='rounded-[2px] bg-nvr-cyan/25 text-slate-800 dark:text-foreground'>
        {text.slice(i, i + needle.length)}
      </span>
      {text.slice(i + needle.length)}
    </>
  )
}

export function FindInRecordButton({
  fields,
  onJump
}: {
  fields: FindableField[]
  onJump: (field: string) => boolean
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [miss, setMiss] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const relFields = useMemo(() => fields.filter((f) => f.relation), [fields])
  const targets = useMemo(
    () => [...new Set(relFields.map((f) => f.relation!.target))],
    [relFields]
  )

  // Display templates per target collection — cached long, cheap.
  const metaQs = useQueries({
    queries: targets.map((t) => ({
      queryKey: ['find-meta', t],
      queryFn: () =>
        client
          .request<{ data: { display_template?: string | null } }>(get(`/collections/${t}`))
          .then((r) => r.data?.display_template ?? null)
          .catch(() => null),
      enabled: open,
      staleTime: 300_000
    }))
  })
  const tmplByTarget = useMemo(() => {
    const m = new Map<string, string | null>()
    targets.forEach((t, i) => m.set(t, metaQs[i]?.data ?? null))
    return m
    // biome-ignore lint/correctness/useExhaustiveDependencies: metaQs identity churns per render; the joined signature captures its data with a STABLE deps-array size
  }, [targets, metaQs.map((mq) => mq.dataUpdatedAt ?? 0).join(',')])

  // One batched id → row lookup per target collection (M2O + M2M ids merged).
  const idBatches = useMemo(() => {
    const byTarget = new Map<string, Set<string>>()
    for (const f of relFields) {
      const r = f.relation!
      if (r.kind === 'o2m') continue
      for (const id of r.ids ?? []) {
        if (id == null || id === '') continue
        let set = byTarget.get(r.target)
        if (!set) byTarget.set(r.target, (set = new Set()))
        set.add(String(id))
      }
    }
    return [...byTarget.entries()].map(([target, ids]) => ({
      target,
      ids: [...ids].slice(0, 60)
    }))
  }, [relFields])

  const rowQs = useQueries({
    queries: idBatches.map((b) => ({
      queryKey: ['find-labels', b.target, b.ids.join(',')],
      queryFn: () =>
        client
          .request<{ data: Array<Record<string, unknown>> }>(
            get(`/items/${b.target}`, {
              filter: JSON.stringify({ id: { _in: b.ids } }),
              limit: b.ids.length
            })
          )
          .then((r) => r.data ?? [])
          .catch(() => [] as Array<Record<string, unknown>>),
      enabled: open,
      staleTime: 60_000
    }))
  })

  const o2mList = useMemo(() => relFields.filter((f) => f.relation!.kind === 'o2m'), [relFields])
  const o2mQs = useQueries({
    queries: o2mList.map((f) => ({
      queryKey: [
        'find-o2m',
        f.relation!.target,
        f.relation!.fkField,
        String(f.relation!.parentId)
      ],
      queryFn: () =>
        client
          .request<{ data: Array<Record<string, unknown>> }>(
            get(`/items/${f.relation!.target}`, {
              filter: JSON.stringify({
                [f.relation!.fkField as string]: { _eq: f.relation!.parentId }
              }),
              limit: O2M_LIMIT + 1
            })
          )
          .then((r) => r.data ?? [])
          .catch(() => [] as Array<Record<string, unknown>>),
      enabled: open,
      staleTime: 60_000
    }))
  })

  // field → resolved friendly text for relation fields.
  const resolved = useMemo(() => {
    const rowByKey = new Map<string, Record<string, unknown>>()
    idBatches.forEach((b, i) => {
      for (const row of rowQs[i]?.data ?? []) rowByKey.set(`${b.target}:${String(row.id)}`, row)
    })
    const out = new Map<string, { text: string; count: number; pending: boolean }>()
    for (const f of relFields) {
      const r = f.relation!
      if (r.kind === 'o2m') {
        const qi = o2mList.indexOf(f)
        const query = o2mQs[qi]
        if (!query?.isSuccess) {
          out.set(f.field, { text: '', count: 0, pending: true })
          continue
        }
        const rows = query.data ?? []
        const shown = rows.slice(0, O2M_LIMIT)
        const labels = shown.map((row) => rowLabel(tmplByTarget.get(r.target), row))
        out.set(f.field, {
          text: labels.join(', ') + (rows.length > O2M_LIMIT ? ' +more' : ''),
          count: rows.length > O2M_LIMIT ? O2M_LIMIT : rows.length,
          pending: false
        })
        continue
      }
      const ids = (r.ids ?? []).filter((id) => id != null && id !== '')
      if (ids.length === 0) {
        out.set(f.field, { text: '', count: 0, pending: false })
        continue
      }
      const bi = idBatches.findIndex((b) => b.target === r.target)
      const query = rowQs[bi]
      if (!query?.isSuccess) {
        out.set(f.field, { text: '', count: ids.length, pending: true })
        continue
      }
      const labels = ids
        .map((id) => rowByKey.get(`${r.target}:${String(id)}`))
        .filter((row): row is Record<string, unknown> => !!row)
        .map((row) => rowLabel(tmplByTarget.get(r.target), row))
      out.set(f.field, { text: labels.join(', '), count: ids.length, pending: false })
    }
    return out
    // biome-ignore lint/correctness/useExhaustiveDependencies: query arrays churn identity per render; joined signatures capture their data with a STABLE deps-array size
  }, [
    relFields,
    idBatches,
    o2mList,
    tmplByTarget,
    rowQs.map((rq) => rq.dataUpdatedAt ?? 0).join(','),
    o2mQs.map((oq) => oq.dataUpdatedAt ?? 0).join(',')
  ])

  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (needle.length < 2) return []
    const scored: Array<{ f: FindableField; value: string; pending: boolean; score: number }> = []
    for (const f of fields) {
      const res = f.relation ? resolved.get(f.field) : null
      const value = f.relation ? (res?.text ?? '') : f.value
      const inLabel =
        f.label.toLowerCase().includes(needle) || f.field.toLowerCase().includes(needle)
      const inValue = value.toLowerCase().includes(needle)
      if (!inLabel && !inValue) continue
      scored.push({ f, value, pending: res?.pending ?? false, score: inLabel ? 0 : 1 })
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 12)
  }, [fields, needle, resolved])

  const anyPending =
    open && needle.length >= 2 && (rowQs.some((rq) => rq.isFetching) || o2mQs.some((oq) => oq.isFetching))

  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        title='Find a field in this record'
        onClick={() => {
          setOpen((o) => !o)
          setMiss(null)
          setQ('')
        }}
        className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
      >
        <Search className='h-3.5 w-3.5' />
      </button>
      {open && (
        <div className='absolute right-0 top-full z-[110] mt-1 w-[368px] rounded-lg border border-slate-200 bg-white shadow-xl dark:border-border dark:bg-card'>
          <div className='border-b border-slate-100 p-2 dark:border-border'>
            <div className='relative'>
              <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
              <input
                // biome-ignore lint/a11y/noAutofocus: the popover only exists after an explicit click
                autoFocus
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setMiss(null)
                }}
                placeholder='Find a field or value…'
                className='h-8 w-full rounded-md border border-slate-200 bg-background pl-8 pr-2.5 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border'
              />
            </div>
            {miss && (
              <p className='mt-1.5 px-0.5 text-[11.5px] text-amber-600 dark:text-amber-400'>
                {miss}
              </p>
            )}
          </div>
          <div className='max-h-[300px] overflow-y-auto p-1.5'>
            {needle.length < 2 && (
              <p className='px-1.5 py-2 text-[11.5px] leading-relaxed text-slate-400'>
                Search by field name or current value — linked records count too, so a vendor's
                name finds the vendor field.
              </p>
            )}
            {needle.length >= 2 && matches.length === 0 && (
              <p className='px-1.5 py-2 text-[12px] text-slate-400'>
                {anyPending ? 'Searching linked records…' : `No fields or values match “${q.trim()}”.`}
              </p>
            )}
            {matches.map(({ f, value, pending }) => (
              <button
                key={f.field}
                type='button'
                onClick={() => {
                  const jumped = onJump(f.field)
                  if (jumped) {
                    setOpen(false)
                  } else {
                    setMiss(
                      f.group
                        ? `"${f.label}" is on the ${f.group} section — open it first, then search again.`
                        : `"${f.label}" is not visible right now (another tab or hidden by a rule).`
                    )
                  }
                }}
                className='block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted'
              >
                <span className='flex items-baseline gap-1.5 text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                  <span className='truncate'>
                    <Hi text={f.label} needle={needle} />
                  </span>
                  {f.relation && (resolved.get(f.field)?.count ?? 0) > 1 && (
                    <span className='shrink-0 text-[10px] font-normal text-slate-400'>
                      · {resolved.get(f.field)!.count} linked
                    </span>
                  )}
                  {f.group && (
                    <span className='ml-auto shrink-0 text-[10.5px] font-normal text-slate-400'>
                      {f.group}
                    </span>
                  )}
                </span>
                {pending ? (
                  <span className='mt-0.5 block h-3 w-32 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
                ) : (
                  value && (
                    <span className='block truncate text-[11px] text-slate-400'>
                      <Hi text={value} needle={needle} />
                    </span>
                  )
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
