import { Dices, X } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { useCollectionMeta } from '../inspector/field-context'
import { buildSampleRecord, samplePickers } from './sample-record'

// Preview → Record: "Use a sample record" (#3196). Made-up values from the
// field types and choices; pickers get a record the viewer can already read.
// Nothing is saved: the values live in the preview state only.

/** Pickers looked up per sample, at most (one small read each). */
const PICKER_READS = 8

const newSeed = () => Math.floor(Math.random() * 2 ** 31)

/** Build one sample (async: picker ids are read first). */
export function useMakeSample(collection: string) {
  const client = useNivaroClient()
  const { data: meta } = useCollectionMeta(collection)
  const [busy, setBusy] = useState(false)
  const make = async (): Promise<Record<string, unknown> | null> => {
    if (!meta) return null
    setBusy(true)
    try {
      const pickers = samplePickers(meta.fields, meta.relations).slice(0, PICKER_READS)
      const relatedIds: Record<string, Array<string | number>> = {}
      await Promise.all(
        pickers.map(async (p) => {
          try {
            const r = await client.request<{ data: Array<{ id?: string | number }> }>(
              get(`/items/${encodeURIComponent(p.collection)}`, { fields: 'id', limit: 5 })
            )
            relatedIds[p.field] = (r.data ?? [])
              .map((x) => x?.id)
              .filter((id): id is string | number => id != null && id !== '')
          } catch {
            /* not readable here: the picker stays empty */
          }
        })
      )
      return buildSampleRecord({
        fields: meta.fields,
        relations: meta.relations,
        relatedIds,
        seed: newSeed()
      })
    } finally {
      setBusy(false)
    }
  }
  return { make, ready: !!meta, busy }
}

const linkBtn =
  'inline-flex items-center gap-1.5 text-[12px] font-medium text-sky-700 hover:underline disabled:pointer-events-none disabled:opacity-50 dark:text-nvr-cyan'

/** Under the record search: offer a sample (prominent when there is nothing to pick). */
export function SampleRecordOffer({
  collection,
  empty,
  onSample
}: {
  collection: string
  /** The collection has no records the viewer can pick. */
  empty: boolean
  onSample: (values: Record<string, unknown>) => void
}) {
  const { make, ready, busy } = useMakeSample(collection)
  const run = async () => {
    const s = await make()
    if (s) onSample(s)
  }
  return (
    <div data-sample-offer={empty ? 'empty' : ''} className={cn(empty ? 'mt-1 px-2' : 'mt-1.5')}>
      {empty && (
        <p className='pb-1 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
          No records yet. A sample fills the form with made-up values; nothing is saved.
        </p>
      )}
      <button
        type='button'
        data-sample-record=''
        disabled={!ready || busy}
        onClick={() => void run()}
        className={linkBtn}
      >
        <Dices className='h-3.5 w-3.5' />
        {busy ? 'Making a sample…' : 'Use a sample record'}
      </button>
    </div>
  )
}

/** The chip while a sample shows: New sample and ×. */
export function SampleRecordChip({
  collection,
  onSample,
  onClear
}: {
  collection: string
  onSample: (values: Record<string, unknown>) => void
  onClear: () => void
}) {
  const { make, busy } = useMakeSample(collection)
  return (
    <span className='inline-flex max-w-full flex-wrap items-center gap-2'>
      <span
        data-sample-chip=''
        className='inline-flex max-w-full items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-slate-800 dark:text-foreground'
      >
        <Dices className='h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-muted-foreground' />
        <span className='truncate'>Sample record</span>
        <button
          type='button'
          aria-label='Stop using the sample record'
          onClick={onClear}
          className='text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
        >
          <X className='h-3 w-3' />
        </button>
      </span>
      <button
        type='button'
        data-sample-reroll=''
        disabled={busy}
        onClick={() =>
          void make().then((s) => {
            if (s) onSample(s)
          })
        }
        className={linkBtn}
      >
        {busy ? 'Making…' : 'New sample'}
      </button>
    </span>
  )
}
