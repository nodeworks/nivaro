import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { BTN, ConfirmButton, errorOf } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #2245 — what a node is, in a sentence, at the top of its inspector: a route's purpose, a
 * partner, a job, a queue. From what the product already says (a collection's note, a custom
 * query's or flow's description, a background job's description, a partner's description, an
 * extension's declared node), else a built-in line for the system nodes; an admin can write
 * their own over it or add one where there is none. Server: GET/PUT /traffic-map/node-info.
 */
interface Info {
  kind: string
  id: string
  text: string | null
  source: 'admin' | 'registry' | 'extension' | 'built-in' | null
  auto: string | null
  override: string | null
}

const SOURCE_WORD: Record<string, string> = {
  admin: 'written by an admin',
  registry: 'from the product',
  extension: 'declared by an extension',
  'built-in': 'built-in'
}

/** The node kind and id the server describes for a selection (pure). */
export function nodeRef(sel: Selection): { kind: string; id: string } {
  return { kind: sel.kind, id: sel.id }
}

export function NodeAbout({ sel }: { sel: Selection }) {
  const { kind, id } = nodeRef(sel)
  const frozen = useFrozenSnapshotId()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['traffic-map', 'node-info', kind, id],
    queryFn: async () =>
      (await api.get('/traffic-map/node-info', { params: { kind, id } })).data.data as Info,
    staleTime: 60_000,
    retry: false
  })
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  // A different node closes the editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on node change only
  useEffect(() => setEditing(false), [kind, id])
  if (q.isError || !q.data) return null
  const info = q.data

  const save = async (next: string | null) => {
    setBusy(true)
    try {
      const res = await api.put('/traffic-map/node-info', { kind, id, text: next })
      qc.setQueryData(['traffic-map', 'node-info', kind, id], res.data.data)
      setEditing(false)
    } catch (e) {
      toast.error(errorOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title='What this is'>
      <div data-tm-node-about={`${kind}:${id}`}>
        {editing ? (
          <div className='grid gap-1.5'>
            <label className='sr-only' htmlFor='tm-node-about-text'>
              Description
            </label>
            <textarea
              id='tm-node-about-text'
              className='min-h-[72px] w-full resize-y rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 py-1.5 text-[12.5px] text-[var(--tm-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
              value={text}
              maxLength={500}
              placeholder='What this is for, in a sentence or two'
              onChange={(e) => setText(e.target.value)}
            />
            <div className='flex flex-wrap items-center gap-1.5'>
              <button
                type='button'
                className={BTN}
                disabled={busy || !text.trim()}
                onClick={() => void save(text.trim())}
              >
                Save
              </button>
              <button type='button' className={BTN} onClick={() => setEditing(false)}>
                Cancel
              </button>
              {info.override && (
                <ConfirmButton
                  label='Use the automatic text'
                  confirmLabel='Remove mine?'
                  busy={busy}
                  onConfirm={() => void save(null)}
                />
              )}
            </div>
          </div>
        ) : (
          <>
            {info.text ? (
              <p className='text-[12.5px] leading-snug text-[var(--tm-fg)]'>{info.text}</p>
            ) : (
              <p className='text-[12px] text-[var(--tm-muted)]'>Nothing written about this yet.</p>
            )}
            <div className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--tm-muted)]'>
              {info.source && <span>{SOURCE_WORD[info.source]}</span>}
              {!frozen && (
                <button
                  type='button'
                  className='rounded-sm text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                  onClick={() => {
                    setText(info.override ?? info.text ?? '')
                    setEditing(true)
                  }}
                  data-tm-node-about-edit=''
                >
                  {info.text ? 'Edit' : 'Add a description'}
                </button>
              )}
            </div>
            {info.override && info.auto && info.auto !== info.override && (
              <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>Automatic: {info.auto}</p>
            )}
          </>
        )}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'node-about',
  order: 1,
  applies: () => true,
  history: true,
  Component: ({ sel }) => <NodeAbout sel={sel} />
})
