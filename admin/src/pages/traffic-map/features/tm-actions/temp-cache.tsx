/**
 * #2273 Temporary cache on a hot read route — from a collection's node: for N minutes (at most
 * 15) identical reads by the SAME caller are answered from server memory for a few seconds, with
 * the hit rate shown live. Writes to the collection (or one related to it) drop the answers; it
 * switches itself off. Two clicks; on and off are activity rows.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtCount, fmtPct } from '../../EventTicker'
import { Empty, type InspectorData, Section } from '../../Inspector'
import { nodeBadges } from '../../registry/canvasLayers'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { inPage } from '../b1-shared'
import { untilPhrase } from '../breaker'
import { apiError, TwoClickButton } from '../ops-common'
import { cacheTargetOf, Segmented, type TempCache, useTempCaches } from './shared'

const MINUTES: Array<[number, string]> = [
  [5, '5 min'],
  [10, '10 min'],
  [15, '15 min']
]
const ENTRY_S: Array<[number, string]> = [
  [10, '10 s'],
  [30, '30 s'],
  [60, '1 min'],
  [120, '2 min']
]

/** Targets with a cache on (the node badge reads it; kept fresh by the status chip's poll). */
let onTargets = new Set<string>()
export function setCachedTargets(list: TempCache[]): void {
  onTargets = new Set(list.map((c) => c.target))
}

function OpenCache({ c }: { c: TempCache }) {
  const qc = useQueryClient()
  const s = c.stats
  const stop = async () => {
    try {
      await api.delete(`/traffic-map/temp-caches/${c.id}`)
      toast.success('Temporary cache switched off')
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'temp-caches'] })
    } catch (e) {
      toast.error(apiError(e))
    }
  }
  return (
    <div
      className='grid gap-1.5 rounded-md border border-[var(--tm-accent)] bg-[var(--tm-accent-soft)] px-2.5 py-2 text-[12px]'
      data-tm-cache-open={c.target}
    >
      <div className='font-medium text-[var(--tm-accent-ink)]'>
        Caching reads {untilPhrase(c.until)}
      </div>
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[var(--tm-fg-2)]'>
        <span>
          Hit rate{' '}
          <span className='font-semibold tabular-nums text-[var(--tm-fg)]' id='tm-cache-rate'>
            {s.rate == null ? '—' : fmtPct(s.rate)}
          </span>
        </span>
        <span className='tabular-nums'>
          {fmtCount(s.hit)} hits · {fmtCount(s.miss)} misses
          {s.bypass ? ` · ${fmtCount(s.bypass)} asked for fresh` : ''}
        </span>
      </div>
      <p className='text-[11.5px] text-[var(--tm-fg-2)]'>
        Answers kept {c.entry_s} s per caller; {c.entries_here.toLocaleString()} held on this server
        {s.scope === 'process' ? '; counts are this server’s only' : ''}
        {c.by_name ? ` — switched on by ${c.by_name}` : ''}.
      </p>
      <div>
        <TwoClickButton
          id='tm-cache-stop'
          label='Switch off now'
          armedLabel='Click again to switch it off'
          onConfirm={() => void stop()}
        />
      </div>
    </div>
  )
}

function TempCachePanel({ sel }: { sel: Selection; d: InspectorData }) {
  const target = cacheTargetOf(sel)
  const qc = useQueryClient()
  const q = useTempCaches()
  const [minutes, setMinutes] = useState(10)
  const [entryS, setEntryS] = useState(30)
  const [busy, setBusy] = useState(false)
  if (!target) return null
  const open = q.data?.caches.find((c) => c.target === target)
  const start = async () => {
    setBusy(true)
    try {
      await api.post('/traffic-map/temp-caches', { target, minutes, entry_s: entryS })
      toast.success(`Caching reads for ${minutes} min`)
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'temp-caches'] })
    } catch (e) {
      toast.error(apiError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title='Temporary cache'>
      {q.isLoading ? (
        <Empty>Reading…</Empty>
      ) : open ? (
        <OpenCache c={open} />
      ) : q.data && !q.data.available ? (
        <Empty>A temporary cache needs Redis, which is not connected.</Empty>
      ) : (
        <div className='grid gap-2 text-[12px]' data-tm-cache-form={target}>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            While this collection is hot, answer the same read by the same caller from memory for a
            few seconds. Never shared between callers; a write to it or a related collection drops
            the answers. Changes made outside the app (procedures, recalculations) can show late by
            up to the seconds you pick.
          </p>
          <div className='flex flex-wrap items-center gap-2'>
            <Segmented
              label='For how long'
              value={minutes}
              options={MINUTES}
              onChange={setMinutes}
            />
            <Segmented
              label='Keep each answer'
              value={entryS}
              options={ENTRY_S}
              onChange={setEntryS}
            />
          </div>
          <div>
            <TwoClickButton
              id='tm-cache-start'
              label={`Cache reads for ${minutes} min`}
              armedLabel='Click again to switch it on'
              disabled={busy}
              onConfirm={() => void start()}
            />
          </div>
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'temp-cache',
  order: 28,
  applies: (sel) => cacheTargetOf(sel) !== null,
  Component: inPage(TempCachePanel)
})

register(nodeBadges, {
  id: 'temp-cache',
  order: 90,
  badge: (nodeId) => (onTargets.has(nodeId) ? { text: 'cached', tone: 'info' } : null)
})
