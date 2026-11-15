import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Status page settings of a public submission form (realtime round 9, item 22) — stored in
 * `form_config.status_page`. Submitters get a link to a page that shows Received → In review →
 * Decided, live; only the values listed here become public, everything else reads "In review".
 */

export type PublicStage = 'received' | 'in_review' | 'decided'

export interface StatusPageSettings {
  enabled?: boolean
  source?: 'pipeline' | 'field'
  field?: string | null
  map?: Array<{ value: string; stage: PublicStage; label?: string | null }>
  email_field?: string | null
  ttl_days?: number
}

const STAGE_OPTIONS = [
  { value: 'received', label: 'Received' },
  { value: 'in_review', label: 'In review' },
  { value: 'decided', label: 'Decided' }
]

interface FieldMeta {
  field: string
  type?: string
  meta?: { hidden?: boolean; note?: string | null } | null
}

export function StatusPageCard({
  collection,
  formFields,
  value,
  onChange
}: {
  collection: string
  /** Paths of the fields this form asks for (the email field is one of them). */
  formFields: string[]
  value: StatusPageSettings
  onChange: (next: StatusPageSettings) => void
}) {
  const v: Required<Omit<StatusPageSettings, 'field' | 'email_field'>> &
    Pick<StatusPageSettings, 'field' | 'email_field'> = {
    enabled: value.enabled === true,
    source: value.source === 'field' ? 'field' : 'pipeline',
    field: value.field ?? null,
    map: value.map ?? [],
    email_field: value.email_field ?? null,
    ttl_days: value.ttl_days ?? 90
  }
  const set = (patch: Partial<StatusPageSettings>) => onChange({ ...v, ...patch })

  const { data: fields = [] } = useQuery<FieldMeta[]>({
    queryKey: ['submission-status-fields', collection],
    enabled: !!collection && v.enabled,
    queryFn: () =>
      api
        .get<{ data: { fields?: FieldMeta[] } }>(`/collections/${encodeURIComponent(collection)}`)
        .then((r) => r.data.data.fields ?? [])
  })
  // The collection's pipeline states, to pick from.
  const { data: states = [] } = useQuery<Array<{ key: string; label: string }>>({
    queryKey: ['submission-status-states', collection],
    enabled: !!collection && v.enabled && v.source === 'pipeline',
    queryFn: async () => {
      const b = await api.get<{ data: Array<{ collection: string; template: string }> }>(
        '/pipelines/bindings'
      )
      const bound = b.data.data.find((x) => x.collection === collection)
      if (!bound) return []
      const t = await api.get<{ data: { states?: Array<{ key: string; label: string }> } }>(
        `/pipelines/${bound.template}`
      )
      return (t.data.data.states ?? []).map((s) => ({ key: s.key, label: s.label }))
    }
  })

  const fieldOptions = fields
    .filter((f) => f.type !== 'alias' && !f.field.startsWith('$'))
    .map((f) => ({ value: f.field, label: f.field }))
  const valueOptions =
    v.source === 'pipeline'
      ? states.map((s) => ({ value: s.key, label: s.label }))
      : ([] as Array<{ value: string; label: string }>)

  return (
    <div className='space-y-4 rounded-lg border border-border bg-card p-5' data-status-page-card>
      <div className='flex items-start justify-between gap-3'>
        <div>
          <h2 className='text-sm font-semibold text-foreground'>Status page</h2>
          <p className='mt-0.5 text-[11px] text-muted-foreground'>
            After sending, people get a link that shows where their request stands and updates while
            it is open. Only the steps you list below are shown to them.
          </p>
        </div>
        <Switch
          checked={v.enabled}
          onCheckedChange={(on) => set({ enabled: on })}
          aria-label='Give submitters a status page'
        />
      </div>

      {v.enabled && (
        <>
          <div className='space-y-1.5'>
            <Label>Status comes from</Label>
            <div className='flex flex-wrap gap-1.5'>
              {(
                [
                  ['pipeline', 'The record’s pipeline step'],
                  ['field', 'A field on the record']
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type='button'
                  onClick={() => set({ source: k, map: [] })}
                  aria-pressed={v.source === k}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[11px] font-medium',
                    v.source === k
                      ? 'bg-[#00ceff1a] text-nvr-navy dark:text-[#00ceff]'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-muted dark:text-muted-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {v.source === 'field' && (
              <SimpleSelect
                value={v.field ?? ''}
                onChange={(f) => set({ field: f || null })}
                options={[{ value: '', label: 'Pick a field…' }, ...fieldOptions]}
                ariaLabel='Status field'
              />
            )}
            {v.source === 'pipeline' && states.length === 0 && (
              <p className='text-[11px] text-amber-700 dark:text-amber-300'>
                This collection has no pipeline. Pick “A field on the record” instead.
              </p>
            )}
          </div>

          <div className='space-y-1.5'>
            <Label>What submitters see</Label>
            <p className='text-[11px] text-muted-foreground'>
              Anything not listed reads “In review”. The label is optional — blank uses the step’s
              outside label, else the stage name.
            </p>
            <div className='space-y-1.5'>
              {v.map.map((m, i) => (
                <div
                  key={`${i}-${m.value}`}
                  className='space-y-1.5 rounded-md border border-border p-2'
                >
                  <div className='flex items-center gap-1.5'>
                    <div className='min-w-0 flex-1'>
                      {valueOptions.length > 0 ? (
                        <SimpleSelect
                          value={m.value}
                          onChange={(val) =>
                            set({ map: v.map.map((x, j) => (j === i ? { ...x, value: val } : x)) })
                          }
                          options={[{ value: '', label: 'Step…' }, ...valueOptions]}
                          ariaLabel='Pipeline step'
                        />
                      ) : (
                        <Input
                          value={m.value}
                          placeholder='Value'
                          aria-label='Field value'
                          onChange={(e) =>
                            set({
                              map: v.map.map((x, j) =>
                                j === i ? { ...x, value: e.target.value } : x
                              )
                            })
                          }
                        />
                      )}
                    </div>
                    <button
                      type='button'
                      aria-label='Remove this step'
                      onClick={() => set({ map: v.map.filter((_x, j) => j !== i) })}
                      className='rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>
                  <div className='grid grid-cols-2 gap-1.5'>
                    <SimpleSelect
                      value={m.stage}
                      onChange={(stage) =>
                        set({
                          map: v.map.map((x, j) =>
                            j === i ? { ...x, stage: stage as PublicStage } : x
                          )
                        })
                      }
                      options={STAGE_OPTIONS}
                      ariaLabel='Public stage'
                    />
                    <Input
                      value={m.label ?? ''}
                      placeholder='Label (e.g. Approved)'
                      aria-label='Public label'
                      maxLength={80}
                      onChange={(e) =>
                        set({
                          map: v.map.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                        })
                      }
                    />
                  </div>
                </div>
              ))}
              <button
                type='button'
                onClick={() =>
                  set({ map: [...v.map, { value: '', stage: 'in_review', label: '' }] })
                }
                className='inline-flex items-center gap-1 rounded px-1 text-[12px] font-medium text-nvr-navy hover:underline dark:text-[#00ceff]'
              >
                <Plus className='h-3.5 w-3.5' /> Add a step
              </button>
            </div>
          </div>

          <div className='space-y-1.5'>
            <Label>Email the link to</Label>
            <SimpleSelect
              value={v.email_field ?? ''}
              onChange={(f) => set({ email_field: f || null })}
              options={[
                { value: '', label: 'Don’t email it (shown after sending only)' },
                ...formFields.filter((f) => !f.includes('.')).map((f) => ({ value: f, label: f }))
              ]}
              ariaLabel='Email field'
            />
          </div>

          <div className='space-y-1.5'>
            <Label htmlFor='sf-status-ttl'>Link works for (days)</Label>
            <Input
              id='sf-status-ttl'
              type='number'
              min={1}
              max={365}
              value={v.ttl_days}
              onChange={(e) => set({ ttl_days: Number(e.target.value) || 90 })}
              className='max-w-[100px]'
            />
          </div>
        </>
      )}
    </div>
  )
}
