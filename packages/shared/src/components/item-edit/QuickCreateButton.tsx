import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient, useParentDraft } from '../../context'
import { get, patch, post } from '../../lib/commands'
import { userErrorMessage } from '../../lib/safe-error'
import { cn, titleCase } from '../../lib/utils'
import { parseJson } from './helpers'

/** Config: `options.quick_create` on an M2O field. Renders a "＋ New" button next
 *  to the picker that creates a record in the TARGET collection inline and
 *  selects it. `from` values seed hidden fields from the parent form draft
 *  ('$parent.<field>') or a literal; fields without `from` render as inputs.
 *  Inline "create a new related record" pattern, fully generic. */
export interface QuickCreateConfig {
  label?: string
  title?: string
  fields: Array<{
    field: string
    label?: string
    required?: boolean
    /** '$parent.<field>' (parent draft value) or a literal — hidden seed, no input.
     *  When `field` is a many-to-many alias on the target, the seed becomes its
     *  links: a scalar ('$parent.funding_year') links one record, an array
     *  ('$parent.funding_years') links each (#799). With `required: true` a
     *  '$parent.' seed must be filled on the form before Create is offered —
     *  `label` names it ("Pick Zone on the form first"). Without it a record
     *  could be created outside its creator's own scope and vanish from the
     *  picker (army8 b01: a unit made before Zone/Region were picked). */
    from?: unknown
  }>
}

export function QuickCreateButton({
  targetCollection,
  config,
  value,
  onCreated
}: {
  targetCollection: string
  config: QuickCreateConfig
  /** The field's current value — while it still holds the record made here,
   *  that record keeps following the form's seeds (see below). */
  value?: unknown
  onCreated: (id: unknown) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const parentDraft = useParentDraft()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Which seed targets are many-to-many aliases on the created record — the
  // server takes an id array there and writes the junction rows (#799).
  const { data: m2mAliases } = useQuery<Set<string>>({
    queryKey: ['quick-create-m2m', targetCollection],
    queryFn: () =>
      client
        .request<{
          data: {
            relations?: Array<{
              one_collection?: string | null
              one_field?: string | null
              junction_field?: string | null
            }>
          }
        }>(get(`/collections/${targetCollection}`))
        .then(
          (r) =>
            new Set(
              (r.data?.relations ?? [])
                .filter(
                  (rel) =>
                    rel.one_collection === targetCollection &&
                    !!rel.one_field &&
                    !!rel.junction_field
                )
                .map((rel) => String(rel.one_field))
            )
        ),
    enabled: open,
    staleTime: 5 * 60_000
  })
  // The target's own field rules — a typed name past its limit is flagged
  // here, before the record exists (army9 b02: a 36-character unit name went
  // through and MDSi refused the request later).
  const { data: targetFields } = useQuery<FieldLimitConfig[]>({
    queryKey: ['quick-create-fields', targetCollection],
    queryFn: () =>
      client
        .request<{ data: FieldLimitConfig[] }>(get(`/field-config/${targetCollection}`))
        .then((r) => (Array.isArray(r.data) ? r.data : []))
        .catch(() => []),
    enabled: open,
    staleTime: 5 * 60_000
  })
  const inputFields = (config.fields ?? []).filter((f) => f.from === undefined)
  const seedFields = (config.fields ?? []).filter((f) => f.from !== undefined)

  const resolveSeed = (from: unknown): unknown => {
    if (typeof from === 'string' && from.startsWith('$parent.')) {
      return parentDraft?.draft?.[from.slice('$parent.'.length)] ?? null
    }
    return from
  }
  const missingSeeds = missingRequiredSeeds(seedFields, resolveSeed)
  const laterSeeds = pendingOptionalSeeds(seedFields, resolveSeed, parentDraft?.fieldLabels)

  // ── The record made here follows the form ──────────────────────────────────
  // The picker sits on the FIRST step, before most of the fields it seeds
  // from (Project Type, Project, Unit Type…). A unit made there got only Zone
  // and Region, then failed the picker's own narrowing at Create ("Not an
  // available option", army9 b02 HIGH) and was left behind as an orphan.
  // While the field still holds the record made here, each seed the form
  // fills in later is written to that record too.
  const createdRef = useRef<{ id: unknown; written: Record<string, string> } | null>(null)
  const seedSig = JSON.stringify(seedFields.map((f) => resolveSeed(f.from) ?? null))
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the listed inputs only; the helpers it calls read refs
  useEffect(() => {
    const made = createdRef.current
    if (!made) return
    if (value == null || String(value) !== String(made.id)) {
      // Another record picked (or cleared): this one no longer follows.
      if (value != null && value !== '') createdRef.current = null
      return
    }
    const body = seedFollowPatch(seedFields, resolveSeed, made.written, m2mAliases)
    if (!body) return
    const t = setTimeout(() => {
      client
        .request(patch(`/items/${targetCollection}/${made.id}`, body.patch))
        .then(() => {
          if (createdRef.current?.id === made.id)
            createdRef.current = { id: made.id, written: { ...made.written, ...body.written } }
          // The picker re-judges the value against its narrowing.
          void qc.invalidateQueries({ queryKey: ['relation-avail', targetCollection] })
          void qc.invalidateQueries({ queryKey: ['relation-opts', targetCollection] })
          void qc.invalidateQueries({ queryKey: ['relation-single', targetCollection] })
        })
        .catch(() => {
          /* the picker's own "not available" flag still tells the person */
        })
    }, 500)
    return () => clearTimeout(t)
  }, [seedSig, value, m2mAliases, targetCollection])

  // ── Popover position: portaled, so a short step card never clips it ──────
  const [pos, setPos] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const update = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (!r) return
      const width = Math.min(288, window.innerWidth - 16)
      const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
      const below = window.innerHeight - r.bottom
      const panelH = panelRef.current?.offsetHeight ?? 260
      const flipUp = below < panelH + 12 && r.top > below
      setPos({
        position: 'fixed',
        left,
        width,
        zIndex: 120,
        ...(flipUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 })
      })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])
  // The first box takes focus; Escape anywhere in the popover closes it;
  // a click outside closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the listed inputs only; the helpers it calls read refs
  useEffect(() => {
    if (!open || !pos) return
    panelRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }, [open, !!pos])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return
      setOpen(false)
      setError(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const close = () => {
    setOpen(false)
    setError(null)
    buttonRef.current?.focus()
  }
  // Escape closes the popover, not a drill sheet around it: listened on
  // WINDOW in the capture phase so it runs before Radix's own (document,
  // capture) Escape handler — React's stopPropagation comes too late (army9
  // review L4; same pattern as RelationCombobox).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const a = document.activeElement
      const mine =
        a === document.body ||
        !!(a && (panelRef.current?.contains(a) || buttonRef.current?.contains(a)))
      if (!mine) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      setError(null)
      buttonRef.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  async function create() {
    if (missingSeeds.length > 0) return
    for (const f of inputFields) {
      if (f.required && !(values[f.field] ?? '').trim()) {
        setError(`${f.label ?? titleCase(f.field)} is required`)
        return
      }
      const hard = fieldLimit(targetFields?.find((t) => t.field === f.field))
      const len = (values[f.field] ?? '').trim().length
      if (hard && !hard.soft && len > hard.max) {
        setError(
          hard.message ?? `${f.label ?? titleCase(f.field)} takes at most ${hard.max} characters`
        )
        return
      }
    }
    setSaving(true)
    setError(null)
    const payload: Record<string, unknown> = {}
    const written: Record<string, string> = {}
    for (const f of seedFields) {
      const v = resolveSeed(f.from)
      if (m2mAliases?.has(f.field)) {
        const ids = linkIds(v)
        if (ids.length > 0) {
          payload[f.field] = ids
          written[f.field] = seedKey(ids)
        }
        continue
      }
      if (v !== null && v !== undefined && v !== '') {
        payload[f.field] = v
        written[f.field] = seedKey(v)
      }
    }
    for (const f of inputFields) {
      const v = (values[f.field] ?? '').trim()
      if (v !== '') payload[f.field] = v
    }
    try {
      const created = await client.request<{
        data: { id: unknown }
        meta?: { readable?: boolean }
      }>(post(`/items/${targetCollection}`, payload))
      const id = created.data?.id
      if (id == null) throw new Error('Created record returned no id')
      qc.invalidateQueries({ queryKey: ['relation-opts', targetCollection] })
      if (created.meta?.readable === false) {
        // Saved, but outside what this person may see: selecting it would
        // leave a blank picker and a raw number in the summary.
        setError(
          `Created, but it is outside what you can see, so it can't be selected here. Ask an administrator to check your access.`
        )
        setValues({})
        return
      }
      createdRef.current = { id, written }
      onCreated(id)
      setOpen(false)
      setValues({})
      buttonRef.current?.focus()
    } catch (err) {
      setError(userErrorMessage(err, 'Create failed'))
    } finally {
      setSaving(false)
    }
  }

  const noun = (config.label ?? titleCase(targetCollection)).replace(/^New\s+/i, '').toLowerCase()

  return (
    <div className='relative shrink-0'>
      <button
        ref={buttonRef}
        type='button'
        title={config.title ?? `New ${titleCase(targetCollection)}`}
        aria-expanded={open}
        aria-haspopup='dialog'
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-9 items-center gap-1 rounded-md border px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
          open
            ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
            : 'border-input text-slate-600 hover:border-slate-400 hover:text-slate-800 dark:text-slate-300'
        )}
      >
        <Plus className='h-3.5 w-3.5' />
        {config.label ?? 'New'}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role='dialog'
            aria-label={config.title ?? `New ${titleCase(targetCollection)}`}
            data-quick-create-panel=''
            // Rendered hidden for one frame while its height is measured.
            style={pos ?? { position: 'fixed', visibility: 'hidden', top: 0, left: 0 }}
            className='nvr-pop-in max-h-[80vh] overflow-y-auto rounded-md border border-border bg-background p-3 shadow-md'
          >
            <p className='mb-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
              {config.title ?? `New ${titleCase(targetCollection)}`}
            </p>
            {missingSeeds.length > 0 && (
              <p
                data-quick-create-missing
                className='mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11.5px] leading-snug text-amber-800 dark:border-amber-500/40 dark:bg-[#2a2113] dark:text-amber-300'
              >
                Pick {joinWords(missingSeeds)} on the form first — the new {noun} takes{' '}
                {missingSeeds.length === 1 ? 'it' : 'them'} from there.
              </p>
            )}
            {missingSeeds.length === 0 && laterSeeds.length > 0 && (
              <p
                data-quick-create-later
                className='mb-2 text-[11.5px] leading-snug text-muted-foreground'
              >
                {joinWords(laterSeeds)} {laterSeeds.length === 1 ? 'is' : 'are'} not filled in yet —
                the new {noun} picks {laterSeeds.length === 1 ? 'it' : 'them'} up from the form as
                you fill {laterSeeds.length === 1 ? 'it' : 'them'} in.
              </p>
            )}
            <div className='flex flex-col gap-2'>
              {inputFields.map((f) => {
                const label = f.label ?? titleCase(f.field)
                const limit = fieldLimit(targetFields?.find((t) => t.field === f.field))
                const len = (values[f.field] ?? '').length
                const over = !!limit && len > limit.max
                const hintId = `qc-${f.field}-limit`
                return (
                  <label key={f.field} className='flex flex-col gap-1'>
                    <span className='flex items-baseline justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400'>
                      <span>
                        {label}
                        {f.required && <span className='ml-0.5 text-red-500'>*</span>}
                      </span>
                      {limit && len >= limit.max * 0.6 && (
                        <span
                          data-quick-create-count
                          className={cn(
                            'tabular-nums',
                            over ? 'font-medium text-amber-700 dark:text-amber-300' : ''
                          )}
                        >
                          {len}/{limit.max}
                        </span>
                      )}
                    </span>
                    <input
                      value={values[f.field] ?? ''}
                      aria-invalid={over || undefined}
                      aria-describedby={over ? hintId : undefined}
                      onChange={(e) => setValues((p) => ({ ...p, [f.field]: e.target.value }))}
                      onKeyDown={(e) => {
                        // Enter creates; it never submits the record form around it.
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void create()
                        }
                      }}
                      className={cn(
                        'h-8 rounded border bg-background px-2 text-[13px] outline-none focus:border-nvr-cyan',
                        over ? 'border-amber-400 dark:border-amber-500' : 'border-input'
                      )}
                    />
                    {over && (
                      <span
                        id={hintId}
                        data-quick-create-limit
                        className='text-[11px] leading-snug text-amber-700 dark:text-amber-300'
                      >
                        {limit?.message ?? `${label} takes at most ${limit?.max} characters.`}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            {error && (
              <p role='alert' className='mt-2 text-[11px] text-red-600 dark:text-red-400'>
                {error}
              </p>
            )}
            <div className='mt-3 flex justify-end gap-2'>
              <button
                type='button'
                onClick={close}
                className='h-7 rounded px-2 text-[12px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              >
                Cancel
              </button>
              <button
                type='button'
                // Wait for the target's relations so a many-to-many seed is sent as links.
                disabled={
                  saving || missingSeeds.length > 0 || (seedFields.length > 0 && !m2mAliases)
                }
                onClick={() => void create()}
                className='inline-flex h-7 items-center gap-1 rounded bg-nvr-cyan px-2.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50'
              >
                {saving && <Loader2 className='h-3 w-3 animate-spin' />}
                Create &amp; select
              </button>
            </div>
          </div>,
          portalHost(buttonRef.current)
        )}
    </div>
  )
}

/** Inside a sheet the popover goes into the dialog (a body portal there sits
 *  under the modal's pointer lock), else body. */
function portalHost(anchor: HTMLElement | null): HTMLElement {
  return (anchor?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
}

type FieldLimitConfig = {
  field: string
  max_length?: number | null
  options?: unknown
  validation_rules?: unknown
}

/** A text field's length limit: a `max` validation rule (soft or not, with its
 *  own message), else options.max_length, else the column's limit. */
export function fieldLimit(
  f: FieldLimitConfig | undefined
): { max: number; soft: boolean; message?: string } | null {
  if (!f) return null
  const rules = parseJson<
    Array<{ type?: string; value?: unknown; soft?: boolean; message?: string }>
  >(f.validation_rules as never)
  const rule = Array.isArray(rules) ? rules.find((r) => r?.type === 'max') : null
  const rv = Number(rule?.value)
  if (rule && Number.isFinite(rv) && rv > 0)
    return { max: rv, soft: !!rule.soft, message: rule.message || undefined }
  const o = parseJson<{ max_length?: unknown }>(f.options as never)
  const ov = Number(o?.max_length)
  if (Number.isFinite(ov) && ov > 0) return { max: ov, soft: false }
  const col = Number(f.max_length)
  if (Number.isInteger(col) && col > 0) return { max: col, soft: false }
  return null
}

/** Labels of OPTIONAL '$parent.' seeds the form has not filled yet — they are
 *  written to the new record as the form fills them in. */
export function pendingOptionalSeeds(
  seeds: QuickCreateConfig['fields'],
  resolve: (from: unknown) => unknown,
  labels?: Record<string, string>
): string[] {
  return seeds
    .filter((f) => !f.required && typeof f.from === 'string' && f.from.startsWith('$parent.'))
    .filter((f) => isEmptySeed(resolve(f.from)))
    .map((f) => {
      const parentField = String(f.from).slice('$parent.'.length)
      return f.label ?? labels?.[parentField] ?? titleCase(parentField)
    })
}

/** The seeds that changed on the form since they were written to the record
 *  made here: the PATCH body plus what it records as written. Empty values
 *  are never written (clearing a form field never blanks the record). */
export function seedFollowPatch(
  seeds: QuickCreateConfig['fields'],
  resolve: (from: unknown) => unknown,
  written: Record<string, string>,
  m2mAliases: Set<string> | undefined
): { patch: Record<string, unknown>; written: Record<string, string> } | null {
  if (!m2mAliases) return null
  const out: Record<string, unknown> = {}
  const sig: Record<string, string> = {}
  for (const f of seeds) {
    if (typeof f.from !== 'string' || !f.from.startsWith('$parent.')) continue
    const v = resolve(f.from)
    if (isEmptySeed(v)) continue
    const val = m2mAliases.has(f.field) ? linkIds(v) : v
    if (Array.isArray(val) && val.length === 0) continue
    const s = seedKey(val)
    if (written[f.field] === s) continue
    out[f.field] = val
    sig[f.field] = s
  }
  return Object.keys(out).length ? { patch: out, written: sig } : null
}

/** One spelling per seed value: 8161 and "8161" (or [7] and ["7"]) are the
 *  same seed, so a type flip on the form never re-PATCHes the record. */
export function seedKey(v: unknown): string {
  return Array.isArray(v) ? v.map((x) => String(x)).join(',') : String(v ?? '')
}

function isEmptySeed(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

/** Labels of required '$parent.' seeds the form has not filled yet. */
export function missingRequiredSeeds(
  seeds: QuickCreateConfig['fields'],
  resolve: (from: unknown) => unknown
): string[] {
  return seeds
    .filter((f) => f.required && typeof f.from === 'string' && f.from.startsWith('$parent.'))
    .filter((f) => {
      const v = resolve(f.from)
      return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
    })
    .map((f) => f.label ?? titleCase(String(f.from).slice('$parent.'.length)))
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** A seed value as related ids: one id, an id array, or `{id}` objects. */
function linkIds(v: unknown): Array<string | number> {
  const list = Array.isArray(v) ? v : [v]
  const out: Array<string | number> = []
  for (const e of list) {
    const id = e != null && typeof e === 'object' ? (e as { id?: unknown }).id : e
    if ((typeof id === 'string' && id !== '') || typeof id === 'number') out.push(id)
  }
  return out
}
