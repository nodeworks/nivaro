import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { put } from '../../../lib/commands'
import { toastError } from '../../../lib/error-toast'
import { cn } from '../../../lib/utils'
import { useCcQuery } from '../api'
import { BUTTON, FAINT, FOCUS, MUTED } from '../theme'
import type { CcConfigCandidates, CcRegionSourceConfig } from '../types'
import { CcSidePanel } from './map-shared'

/**
 * CC-3 — administrators pick the map collections, where regions come from and when a record
 * counts as stuck. Nothing here is required: an unset choice means "work it out from the data
 * model" (the suggestion is shown in plain words).
 */

type RegionChoice = { mode: 'auto' } | { mode: 'none' } | { mode: 'source'; index: number }

const sameSource = (a: CcRegionSourceConfig, b: CcRegionSourceConfig) =>
  JSON.stringify(a) === JSON.stringify(b)

export function BoardSettings({ onClose }: { onClose: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const q = useCcQuery<CcConfigCandidates>('/config/candidates', undefined, {
    lenses: false,
    staleTime: 0
  })
  const data = q.data
  const [geo, setGeo] = useState<string[] | null>(null)
  const [region, setRegion] = useState<RegionChoice | null>(null)
  const [stuck, setStuck] = useState<string>('')

  useEffect(() => {
    if (!data) return
    setGeo((g) => g ?? data.config.geo_collections)
    setStuck((s) => s || String(data.config.stuck_days))
    setRegion((r) => {
      if (r) return r
      const cur = data.config.region
      if (cur === false) return { mode: 'none' }
      if (!cur) return { mode: 'auto' }
      const i = data.regions.findIndex((c) => sameSource(c.source, cur))
      return i >= 0 ? { mode: 'source', index: i } : { mode: 'auto' }
    })
  }, [data])

  const save = useMutation({
    mutationFn: () => {
      const stuckDays = Math.round(Number(stuck))
      return client.request(
        put('/command-center/config', {
          geo_collections: geo ?? [],
          region:
            region?.mode === 'none'
              ? false
              : region?.mode === 'source' && data
                ? (data.regions[region.index]?.source ?? null)
                : null,
          stuck_days: Number.isFinite(stuckDays) ? stuckDays : 7
        })
      )
    },
    onSuccess: () => {
      toast.success('Board settings saved')
      void qc.invalidateQueries({ queryKey: ['command-center'] })
      onClose()
    },
    onError: (err: unknown) => {
      // NivaroError: status + code; message is the API's own text.
      const e = err as { status?: number; code?: string | null; message?: string }
      if (e.code === 'MIGRATION_PENDING' || e.status === 409)
        toast.error('These settings can be saved once this instance finishes its update.')
      else toastError(err, 'Could not save the board settings', { action: 'Save board settings' })
    }
  })

  const suggested = data?.regions.find((r) => r.suggested)
  const geoAuto = (geo ?? []).length === 0
  const toggleGeo = (key: string) =>
    setGeo((cur) => {
      const list = cur ?? []
      return list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
    })
  const makeDefault = (key: string) =>
    setGeo((cur) => [key, ...(cur ?? []).filter((k) => k !== key)])
  const stuckNum = Number(stuck)
  const stuckOk = Number.isFinite(stuckNum) && stuckNum >= 1 && stuckNum <= 365

  const radio = (on: boolean) =>
    cn(
      'flex w-full cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-left',
      on ? 'border-nvr-cyan bg-nvr-cyan/10' : 'border-[var(--cc-border)] hover:bg-[var(--cc-chip)]'
    )

  return (
    <CcSidePanel
      open
      label='Board settings'
      title='Board settings'
      subtitle='For everyone who opens the Command Center'
      onClose={onClose}
      width={460}
      footer={
        <div className='flex items-center justify-end gap-2'>
          <button type='button' onClick={onClose} className={cn(BUTTON, FOCUS)}>
            Cancel
          </button>
          <button
            type='button'
            disabled={!data || !stuckOk || save.isPending}
            onClick={() => save.mutate()}
            className={cn(
              'rounded-md bg-nvr-cyan px-3 py-1 text-[11.5px] font-medium text-white disabled:opacity-50',
              FOCUS
            )}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      {q.isLoading && <p className={`text-[12px] ${MUTED}`}>Looking at the data model…</p>}
      {q.isError && (
        <p className='text-[12px] text-[var(--cc-bad-text)]'>Could not load the choices.</p>
      )}
      {data && (
        <div className='space-y-5 text-[12px]'>
          <section aria-labelledby='cc-set-map'>
            <h3 id='cc-set-map' className='mb-1 font-semibold text-[var(--cc-strong)]'>
              Map collections
            </h3>
            <p className={`mb-2 ${FAINT}`}>
              Collections with a latitude and longitude field. Pick the ones to offer on the map;
              the first is shown by default. Pick none to offer every one found.
            </p>
            {data.geo.length === 0 && (
              <p className={MUTED}>No collection has latitude and longitude fields yet.</p>
            )}
            <ul className='space-y-1'>
              {data.geo.map((g) => {
                const i = (geo ?? []).indexOf(g.key)
                return (
                  <li key={g.key} className='flex items-center gap-2'>
                    <label className='flex flex-1 cursor-pointer items-center gap-2'>
                      <input
                        type='checkbox'
                        checked={i >= 0}
                        onChange={() => toggleGeo(g.key)}
                        className={cn('h-3.5 w-3.5 accent-[#00a5cc]', FOCUS)}
                      />
                      <span>{g.label}</span>
                    </label>
                    {i === 0 && <span className={`text-[11px] ${FAINT}`}>Default</span>}
                    {i > 0 && (
                      <button
                        type='button'
                        onClick={() => makeDefault(g.key)}
                        className={cn(
                          'text-[11px] underline-offset-2 hover:underline',
                          MUTED,
                          FOCUS
                        )}
                      >
                        Make default
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
            {geoAuto && data.geo.length > 0 && (
              <p className={`mt-1.5 text-[11px] ${FAINT}`}>Offering all {data.geo.length} found.</p>
            )}
          </section>

          <section aria-labelledby='cc-set-region'>
            <h3 id='cc-set-region' className='mb-1 font-semibold text-[var(--cc-strong)]'>
              Regions
            </h3>
            <p className={`mb-2 ${FAINT}`}>
              Regions group the map and the people on it, and let the board focus on one place.
            </p>
            <div className='space-y-1.5' role='radiogroup' aria-labelledby='cc-set-region'>
              <label className={radio(region?.mode === 'auto')}>
                <input
                  type='radio'
                  name='cc-region'
                  checked={region?.mode === 'auto'}
                  onChange={() => setRegion({ mode: 'auto' })}
                  className={cn('mt-0.5', FOCUS)}
                />
                <span>
                  <span className='font-medium text-[var(--cc-strong)]'>Work it out for me</span>
                  <span className={`block ${FAINT}`}>
                    {suggested
                      ? `Uses ${suggested.label}: ${suggested.description}`
                      : 'Nothing in the data model looks like a region yet.'}
                  </span>
                </span>
              </label>
              {data.regions.map((r, i) => (
                <label
                  key={JSON.stringify(r.source)}
                  className={radio(region?.mode === 'source' && region.index === i)}
                >
                  <input
                    type='radio'
                    name='cc-region'
                    checked={region?.mode === 'source' && region.index === i}
                    onChange={() => setRegion({ mode: 'source', index: i })}
                    className={cn('mt-0.5', FOCUS)}
                  />
                  <span>
                    <span className='font-medium text-[var(--cc-strong)]'>
                      {r.label}
                      {r.suggested && (
                        <span className={`ml-1.5 font-normal ${FAINT}`}>(suggested)</span>
                      )}
                    </span>
                    <span className={`block ${FAINT}`}>{r.description}</span>
                  </span>
                </label>
              ))}
              <label className={radio(region?.mode === 'none')}>
                <input
                  type='radio'
                  name='cc-region'
                  checked={region?.mode === 'none'}
                  onChange={() => setRegion({ mode: 'none' })}
                  className={cn('mt-0.5', FOCUS)}
                />
                <span>
                  <span className='font-medium text-[var(--cc-strong)]'>No regions</span>
                  <span className={`block ${FAINT}`}>
                    Show records and people without grouping them.
                  </span>
                </span>
              </label>
            </div>
          </section>

          <section aria-labelledby='cc-set-stuck'>
            <h3 id='cc-set-stuck' className='mb-1 font-semibold text-[var(--cc-strong)]'>
              Stuck after
            </h3>
            <label className='flex items-center gap-2'>
              <input
                type='number'
                min={1}
                max={365}
                value={stuck}
                onChange={(e) => setStuck(e.target.value)}
                aria-describedby='cc-set-stuck-help'
                className={cn(
                  'w-20 rounded-md border border-[var(--cc-border)] bg-[var(--cc-panel)] px-2 py-1 text-[12px] text-[var(--cc-text)]',
                  FOCUS
                )}
              />
              <span>days in one step</span>
            </label>
            <p
              id='cc-set-stuck-help'
              className={`mt-1 ${stuckOk ? FAINT : 'text-[var(--cc-bad-text)]'}`}
            >
              {stuckOk
                ? 'A record waiting this long in one step counts as stuck.'
                : 'Use a number from 1 to 365.'}
            </p>
          </section>
        </div>
      )}
    </CcSidePanel>
  )
}
