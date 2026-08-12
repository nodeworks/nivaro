import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient, useParentDraft } from '../../context'
import { post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { titleCase } from '../../lib/utils'

/** Config: `options.quick_create` on an M2O field. Renders a "＋ New" button next
 *  to the picker that creates a record in the TARGET collection inline and
 *  selects it. `from` values seed hidden fields from the parent form draft
 *  ('$parent.<field>') or a literal; fields without `from` render as inputs.
 *  EFP "Is New unit" parity, fully generic. */
export interface QuickCreateConfig {
  label?: string
  title?: string
  fields: Array<{
    field: string
    label?: string
    required?: boolean
    /** '$parent.<field>' (parent draft value) or a literal — hidden seed, no input. */
    from?: unknown
  }>
}

export function QuickCreateButton({
  targetCollection,
  config,
  onCreated
}: {
  targetCollection: string
  config: QuickCreateConfig
  onCreated: (id: unknown) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const parentDraft = useParentDraft()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputFields = (config.fields ?? []).filter((f) => f.from === undefined)
  const seedFields = (config.fields ?? []).filter((f) => f.from !== undefined)

  const resolveSeed = (from: unknown): unknown => {
    if (typeof from === 'string' && from.startsWith('$parent.')) {
      return parentDraft?.draft?.[from.slice('$parent.'.length)] ?? null
    }
    return from
  }

  async function create() {
    for (const f of inputFields) {
      if (f.required && !(values[f.field] ?? '').trim()) {
        setError(`${f.label ?? titleCase(f.field)} is required`)
        return
      }
    }
    setSaving(true)
    setError(null)
    const payload: Record<string, unknown> = {}
    for (const f of seedFields) {
      const v = resolveSeed(f.from)
      if (v !== null && v !== undefined && v !== '') payload[f.field] = v
    }
    for (const f of inputFields) {
      const v = (values[f.field] ?? '').trim()
      if (v !== '') payload[f.field] = v
    }
    try {
      const created = await client.request<{ data: { id: unknown } }>(
        post(`/items/${targetCollection}`, payload)
      )
      const id = created.data?.id
      if (id == null) throw new Error('Created record returned no id')
      qc.invalidateQueries({ queryKey: ['relation-opts', targetCollection] })
      onCreated(id)
      setOpen(false)
      setValues({})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='relative shrink-0'>
      <button
        type='button'
        title={config.title ?? `New ${titleCase(targetCollection)}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-9 items-center gap-1 rounded-md border px-2.5 text-[12px] transition-colors',
          open
            ? 'border-[#00ceff] bg-[#00ceff]/10 text-[#00ceff]'
            : 'border-input text-slate-600 hover:border-slate-400 hover:text-slate-800 dark:text-slate-300'
        )}
      >
        <Plus className='h-3.5 w-3.5' />
        {config.label ?? 'New'}
      </button>
      {open && (
        <div className='absolute right-0 z-50 mt-1 w-72 rounded-md border border-border bg-background p-3 shadow-md'>
          <p className='mb-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
            {config.title ?? `New ${titleCase(targetCollection)}`}
          </p>
          <div className='flex flex-col gap-2'>
            {inputFields.map((f) => (
              <label key={f.field} className='flex flex-col gap-1'>
                <span className='text-[11px] text-slate-500'>
                  {f.label ?? titleCase(f.field)}
                  {f.required && <span className='ml-0.5 text-red-500'>*</span>}
                </span>
                <input
                  value={values[f.field] ?? ''}
                  onChange={(e) => setValues((p) => ({ ...p, [f.field]: e.target.value }))}
                  className='h-8 rounded border border-input bg-background px-2 text-[13px] outline-none focus:border-nvr-cyan'
                />
              </label>
            ))}
          </div>
          {error && <p className='mt-2 text-[11px] text-red-600 dark:text-red-400'>{error}</p>}
          <div className='mt-3 flex justify-end gap-2'>
            <button
              type='button'
              onClick={() => {
                setOpen(false)
                setError(null)
              }}
              className='h-7 rounded px-2 text-[12px] text-slate-500 hover:text-slate-700'
            >
              Cancel
            </button>
            <button
              type='button'
              disabled={saving}
              onClick={() => void create()}
              className='inline-flex h-7 items-center gap-1 rounded bg-[#00ceff] px-2.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50'
            >
              {saving && <Loader2 className='h-3 w-3 animate-spin' />}
              Create &amp; select
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
