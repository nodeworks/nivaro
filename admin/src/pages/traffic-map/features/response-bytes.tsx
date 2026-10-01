import { useTrafficMap } from '../context'
import type { HotRow } from '../HotEntities'
import { Section } from '../Inspector'
import { hotColumns } from '../registry/hotColumns'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { fmtBytes, inPage, liveEntityExt } from './b1-shared'

/**
 * #1110 — response size per entity (p50 / p95 / max over the newest 120 responses) to find fat
 * responses. A Size p95 column in Hot entities, and the figures in the inspector.
 */
export const RESPONSE_BYTES_TAP = 'response-bytes'
/** A p95 at or above this reads as fat (amber). */
export const FAT_BYTES = 512 * 1024

type Live = number[] | { p50: number; p95: number; max?: number; n?: number }
export function sizeOf(v: Live | undefined): { p50: number; p95: number; max?: number } | null {
  if (!v) return null
  if (Array.isArray(v)) return { p50: v[0] ?? 0, p95: v[1] ?? 0 }
  return v
}

function SizeCell({ k }: { k: string }) {
  const { model } = useTrafficMap()
  const s = sizeOf(liveEntityExt<Live>(model, RESPONSE_BYTES_TAP, k))
  if (!s?.p95) return <span className='text-[var(--tm-muted)]'>—</span>
  const fat = s.p95 >= FAT_BYTES
  return (
    <span
      className={`whitespace-nowrap ${fat ? 'font-semibold text-[var(--tm-update)]' : ''}`}
      data-tm-size={s.p95}
      title={`p50 ${fmtBytes(s.p50)} · p95 ${fmtBytes(s.p95)}`}
    >
      {fmtBytes(s.p95)}
    </span>
  )
}

function SizePanel({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  const live = sizeOf(liveEntityExt<Live>(model, RESPONSE_BYTES_TAP, sel.id))
  const snap = sizeOf(model.entityMeta(sel.id)?.ext?.[RESPONSE_BYTES_TAP] as Live | undefined)
  const s = live ?? snap
  if (!s?.p95) return null
  const max = snap?.max ?? s.max
  return (
    <Section title='Response size'>
      <div className='flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums' id='tm-size'>
        <span>
          <span className='text-[var(--tm-muted)]'>p50</span> {fmtBytes(s.p50)}
        </span>
        <span className={s.p95 >= FAT_BYTES ? 'font-semibold text-[var(--tm-update)]' : ''}>
          <span className='font-normal text-[var(--tm-muted)]'>p95</span> {fmtBytes(s.p95)}
        </span>
        {max ? (
          <span>
            <span className='text-[var(--tm-muted)]'>largest</span> {fmtBytes(max)}
          </span>
        ) : null}
      </div>
      <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
        Body sizes of the newest 120 responses; streamed files are not measured.
      </p>
    </Section>
  )
}

const PageSizeCell = inPage(SizeCell)
register(hotColumns, {
  id: 'response-bytes',
  header: 'Size p95',
  align: 'right',
  cell: (row: HotRow) => <PageSizeCell k={row.key} />
})
register(inspectorPanels, {
  id: 'response-bytes',
  order: 30,
  applies: (sel) => sel.kind === 'entity',
  Component: inPage(SizePanel)
})
