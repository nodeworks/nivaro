/**
 * #2223 Detector settings — an on/off switch and the thresholds of each detector (fan-out, N+1,
 * duplicate requests, retry storms, near timeout, correlated spikes) on one card, instead of
 * environment variables. Saved for THIS environment (the instance key), so a laptop and staging
 * sharing a database keep their own. Opened from the More menu. Two clicks to save.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { Empty } from '../../Inspector'
import { pagePanels } from '../../registry/pagePanels'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { createStore, inPage, useStore } from '../b1-shared'
import { apiError } from '../ops-common'
import { BTN, INPUT, ReadEmpty } from '../shared'

export interface DetectorKnob {
  key: string
  label: string
  unit: string
  min: number
  max: number
  def: number
  env?: string
}
export interface DetectorDef {
  id: string
  label: string
  description: string
  knobs: DetectorKnob[]
}
type Settings = Record<string, Record<string, number | boolean>>
interface DetectorsRead {
  instance_key: string
  detectors: DetectorDef[]
  settings: Settings
}

export const detectorSettingsOpen = createStore(false)

/** Draft values that differ from what is saved (pure; exported for tests). */
export function draftPatch(saved: Settings, draft: Settings): Settings {
  const out: Settings = {}
  for (const [id, v] of Object.entries(draft)) {
    const diff: Record<string, number | boolean> = {}
    for (const [k, x] of Object.entries(v)) if (saved[id]?.[k] !== x) diff[k] = x
    if (Object.keys(diff).length) out[id] = diff
  }
  return out
}

/** A knob value is in range (pure). */
export function knobValid(k: DetectorKnob, v: unknown): boolean {
  const n = Number(v)
  return Number.isFinite(n) && n >= k.min && n <= k.max
}

function MenuItem() {
  const open = useStore(detectorSettingsOpen)
  return (
    <button
      type='button'
      id='tm-detectors-toggle'
      aria-pressed={open}
      onClick={() => detectorSettingsOpen.set(!open)}
      title='Switch detectors on or off and set their thresholds for this environment'
      className={cn(
        BTN,
        open && 'border-[var(--tm-accent)] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
      )}
    >
      <SlidersHorizontal className='h-3.5 w-3.5' aria-hidden='true' />
      Detector settings
    </button>
  )
}

function Toggle({
  on,
  onChange,
  label
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        on
          ? 'border-[var(--tm-accent)] bg-[var(--tm-accent)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card-2)]'
      )}
    >
      <span
        className={cn(
          'inline-block h-3 w-3 rounded-full bg-[var(--tm-card)] shadow-sm transition-transform duration-150 ease-out',
          on ? 'translate-x-[15px]' : 'translate-x-[2px]'
        )}
      />
    </button>
  )
}

function DetectorSettingsPanel() {
  const open = useStore(detectorSettingsOpen)
  const { ready } = useTrafficMap()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['traffic-map', 'detectors'],
    queryFn: async () => (await api.get('/traffic-map/detectors')).data.data as DetectorsRead,
    enabled: open && ready,
    staleTime: 30_000
  })
  const [draft, setDraft] = useState<Settings>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.data) setDraft(structuredClone(q.data.settings))
  }, [q.data])
  if (!open) return null
  const d = q.data
  const patch = d ? draftPatch(d.settings, draft) : {}
  const dirty = Object.keys(patch).length > 0
  const valid =
    !!d && d.detectors.every((det) => det.knobs.every((k) => knobValid(k, draft[det.id]?.[k.key])))
  const set = (id: string, key: string, v: number | boolean) =>
    setDraft((cur) => ({ ...cur, [id]: { ...(cur[id] ?? {}), [key]: v } }))
  const save = async () => {
    setBusy(true)
    try {
      const res = (await api.put('/traffic-map/detectors', { settings: patch })).data
        .data as DetectorsRead & {
        changed: string[]
      }
      qc.setQueryData(['traffic-map', 'detectors'], res)
      toast.success(res.changed.length ? `Saved for ${res.instance_key}` : 'Nothing changed')
    } catch (e) {
      toast.error(apiError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Detector settings'
      id='tm-detectors'
    >
      <div className='flex flex-wrap items-start justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold'>Detector settings</h2>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            For this environment
            {d ? (
              <>
                {' '}
                (<span className='font-mono'>{d.instance_key}</span>)
              </>
            ) : null}
            . Every server of it picks a change up within a minute.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          {dirty ? (
            <button
              type='button'
              className={BTN}
              onClick={() => d && setDraft(structuredClone(d.settings))}
            >
              Undo changes
            </button>
          ) : null}
          <button
            type='button'
            id='tm-detectors-save'
            className={BTN}
            disabled={!dirty || !valid || busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type='button'
            className={BTN}
            aria-label='Close detector settings'
            onClick={() => detectorSettingsOpen.set(false)}
          >
            Close
          </button>
        </div>
      </div>
      {q.isLoading ? (
        <div className='px-3.5 py-3'>
          <Empty>Loading…</Empty>
        </div>
      ) : !d ? (
        <div className='px-3.5 py-3'>
          <ReadEmpty error errorText='The settings could not be read.' />
        </div>
      ) : (
        <ul className='grid gap-px bg-[var(--tm-line-2)] min-[900px]:grid-cols-2'>
          {d.detectors.map((det) => {
            const on = draft[det.id]?.enabled !== false
            return (
              <li
                key={det.id}
                className='grid gap-1.5 bg-[var(--tm-card)] px-3.5 py-2.5'
                data-tm-detector={det.id}
              >
                <div className='flex items-center justify-between gap-2'>
                  <span className='text-[12.5px] font-semibold'>{det.label}</span>
                  <Toggle
                    on={on}
                    label={`${det.label} on`}
                    onChange={(v) => set(det.id, 'enabled', v)}
                  />
                </div>
                <p className='text-[11.5px] text-[var(--tm-muted)]'>{det.description}</p>
                <div className={cn('flex flex-wrap gap-x-4 gap-y-1.5', !on && 'opacity-50')}>
                  {det.knobs.map((k) => {
                    const v = draft[det.id]?.[k.key]
                    const bad = !knobValid(k, v)
                    return (
                      <label
                        key={k.key}
                        className='grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'
                      >
                        <span>
                          {k.label}
                          {k.env ? (
                            <span
                              className='text-[var(--tm-muted)]'
                              data-tip={`Default from ${k.env}`}
                            >
                              {' '}
                              · default {k.def}
                            </span>
                          ) : (
                            <span className='text-[var(--tm-muted)]'> · default {k.def}</span>
                          )}
                        </span>
                        <span className='flex items-center gap-1.5'>
                          <input
                            type='number'
                            inputMode='numeric'
                            min={k.min}
                            max={k.max}
                            disabled={!on}
                            aria-invalid={bad}
                            value={typeof v === 'number' ? v : ''}
                            onChange={(e) =>
                              set(
                                det.id,
                                k.key,
                                e.target.value === '' ? Number.NaN : Number(e.target.value)
                              )
                            }
                            className={cn(
                              INPUT,
                              'w-24 tabular-nums',
                              bad && 'border-[var(--tm-error)]'
                            )}
                            data-tm-knob={`${det.id}.${k.key}`}
                          />
                          <span className='text-[var(--tm-muted)]'>{k.unit}</span>
                        </span>
                        {bad ? (
                          <span className='text-[var(--tm-error-ink)]'>
                            {k.min}–{k.max}
                          </span>
                        ) : null}
                      </label>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

register(toolbarItems, {
  id: 'detector-settings',
  order: 65,
  slot: 'menu',
  Component: inPage(MenuItem)
})
register(pagePanels, {
  id: 'detector-settings',
  order: 4,
  wide: true,
  Component: inPage(DetectorSettingsPanel)
})
