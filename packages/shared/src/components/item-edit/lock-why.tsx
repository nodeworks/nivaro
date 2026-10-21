import { useQuery } from '@tanstack/react-query'
import { EyeOff } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { currentViewport } from '../../lib/layout-resolve'
import type { DescribeField } from '../layout-editor/overview/describe-conditions'
import { describeShowWhen } from '../layout-editor/show-when'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * #2596 — "Why can't I edit this?". The form explains a locked field in
 * general words; GET /collection-layouts/why names the exact rule or role
 * behind it (as the viewer, for a record they can read), and for admins the
 * fields rules hide on this record's form.
 */

export interface LockWhy {
  layout: { id: number; name: string; why: string | null }
  role: string | null
  /** The viewer's role may read the record but not change it. */
  record_lock: string | null
  locks: Record<string, { kind: 'role' | 'state' | 'section' | 'permission'; text: string }>
  hidden?: Array<{
    field: string
    kind: 'step_rule' | 'section_roles' | 'off'
    section: string | null
    section_label: string | null
    rules?: Array<{ field?: string; op?: string; value?: unknown }>
    roles?: string[]
    text: string
  }>
}

/**
 * The explanation for one record. Non-admins fetch it the first time they
 * point at a locked field (`want()`); admins fetch it with the form (the
 * "hidden by rules" note needs it up front).
 */
export function useLockWhy(
  collection: string,
  itemId: string | number | null | undefined,
  opts: { enabled: boolean; eager: boolean }
) {
  const client = useNivaroClient()
  const [wanted, setWanted] = useState(false)
  const id = itemId == null || itemId === '' ? null : String(itemId)
  // The form the record page opened: a small screen gets the phone version (#2715).
  const [viewport] = useState(currentViewport)
  const q = useQuery({
    queryKey: ['layout-why', collection, id, viewport] as const,
    enabled: opts.enabled && !!id && (opts.eager || wanted),
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      client
        .request<{ data: LockWhy | null }>(
          get('/collection-layouts/why', {
            collection,
            item: id,
            ...(viewport ? { viewport } : {})
          })
        )
        .then((r) => r.data ?? null)
  })
  const want = useCallback(() => setWanted(true), [])
  return { data: q.data ?? null, want }
}

/** General reasons the exact rule may replace (never "someone else is editing" and the like). */
const REFINABLE =
  /^(Locked for your role|Locked while the record is in |Locked by the record’s current state|The ".*" section is locked for your role|Read-only field)/

/**
 * The form's lock reasons with the exact rule named where the server knows it.
 * Reasons that are about this moment (an edit lock, a role preview, an
 * addendum view, a calculated field) stay as they are.
 */
export function refineLockReasons(
  reasons: Record<string, string>,
  why: LockWhy | null
): Record<string, string> {
  if (!why) return reasons
  const out = { ...reasons }
  for (const [field, text] of Object.entries(reasons)) {
    if (!REFINABLE.test(text)) continue
    const exact = why.locks[field]?.text ?? (text === 'Read-only field' ? why.record_lock : null)
    if (exact) out[field] = exact
  }
  return out
}

/**
 * Admins: "3 fields hidden by rules" above the form, with each field's rule in
 * words. Step rules are judged against the record as it is now
 * (`stepVisible`, the form's own evaluator), so only fields hidden at this
 * moment count; sections hidden from other roles are listed for reference.
 */
export function HiddenByRulesNote({
  why,
  fields,
  stepVisible
}: {
  why: LockWhy
  fields: Array<DescribeField & { label?: string | null }>
  stepVisible: (g: { visible_when?: string | null }) => boolean
}) {
  const [open, setOpen] = useState(false)
  const label = useMemo(() => {
    const m = new Map(fields.map((f) => [f.field, f.label || f.field]))
    return (f: string) => m.get(f) ?? f
  }, [fields])
  const rows = useMemo(
    () =>
      (why.hidden ?? [])
        .filter(
          (h) =>
            h.kind !== 'step_rule' || !stepVisible({ visible_when: JSON.stringify(h.rules ?? []) })
        )
        .map((h) => {
          const rule = h.kind === 'step_rule' ? describeShowWhen(h.rules, fields) : null
          return {
            ...h,
            words:
              h.kind === 'step_rule'
                ? `“${h.section_label ?? h.section}” shows only when ${rule ?? 'its rule matches'}`
                : h.text
          }
        }),
    [why.hidden, stepVisible, fields]
  )
  if (!rows.length) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-hidden-by-rules={rows.length}
          className='inline-flex items-center gap-1.5 self-start rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-600 transition-colors hover:bg-muted dark:border-border dark:bg-card dark:text-muted-foreground'
        >
          <EyeOff aria-hidden className='h-3.5 w-3.5' />
          {rows.length} {rows.length === 1 ? 'field' : 'fields'} hidden by rules
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[360px] p-0'>
        <div className='border-b border-slate-200 px-3 py-2 text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          This record opens with the{' '}
          <b className='font-medium text-slate-800 dark:text-foreground'>{why.layout.name}</b> form
          {why.layout.why ? ` because ${why.layout.why}` : ''}. Only admins see this list.
        </div>
        <ul className='max-h-[320px] divide-y divide-slate-100 overflow-y-auto overscroll-contain dark:divide-border'>
          {rows.map((r) => (
            <li key={`${r.kind}:${r.field}`} className='px-3 py-2 text-[12.5px]'>
              <span className='font-medium text-slate-800 dark:text-foreground'>
                {label(r.field)}
              </span>
              <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>{r.words}</p>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
