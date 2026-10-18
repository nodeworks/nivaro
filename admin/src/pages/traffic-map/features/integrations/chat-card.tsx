/**
 * #2277 — Share a node card to chat. An inspector action: pick a channel, post the node's live
 * figure and sparkline there. The message keeps refreshing while the incident lasts, then
 * freezes with its last values (server side; this panel can also freeze it by hand).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import type { InspectorData } from '../../Inspector'
import { inspectorActions } from '../../registry/inspectorActions'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { BTN, ConfirmButton, errorOf, Note } from '../shared'

interface RoomSummary {
  room: string
  kind: string
  label: string | null
}
interface CardBrief {
  message: number
  room: string
  node: string
  status: 'live' | 'frozen'
  reason: string | null
}

const sharable = (sel: Selection) => sel.kind === 'entity' || sel.kind === 'down'

function ChatCard({ sel }: { sel: Selection; d: InspectorData }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [room, setRoom] = useState('')
  const selKey = `${sel.kind}:${sel.id}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new node starts with the form shut
  useEffect(() => setOpen(false), [selKey])

  const rooms = useQuery({
    queryKey: ['traffic-map', 'chat-card-rooms'],
    queryFn: async () => {
      const res = await api.get('/chat/rooms')
      const all = ((res?.data as { data?: RoomSummary[] })?.data ?? []) as RoomSummary[]
      return all.filter((r) => (r.kind === 'channel' || r.kind === 'global') && r.label)
    },
    enabled: open,
    staleTime: 60_000
  })
  const cards = useQuery({
    queryKey: ['traffic-map', 'chat-cards'],
    queryFn: async () =>
      ((await api.get('/traffic-map/chat-cards'))?.data?.data ?? []) as CardBrief[],
    refetchInterval: 20_000,
    staleTime: 10_000
  })
  const mine = (cards.data ?? []).find((c) => c.node === sel.id && c.status === 'live')

  const post = useMutation({
    mutationFn: async () =>
      (await api.post('/traffic-map/chat-card', { room, kind: sel.kind, id: sel.id }))?.data
        ?.data as CardBrief,
    onSuccess: () => {
      setOpen(false)
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'chat-cards'] })
    }
  })
  const freeze = useMutation({
    mutationFn: async (message: number) => api.post(`/traffic-map/chat-card/${message}/freeze`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['traffic-map', 'chat-cards'] })
  })

  return (
    <>
      <button
        type='button'
        className={BTN}
        id='tm-chat-card'
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Share to chat
      </button>
      {mine && (
        <ConfirmButton
          id='tm-chat-card-freeze'
          label='Freeze chat card'
          confirmLabel='Freeze it?'
          busy={freeze.isPending}
          onConfirm={() => freeze.mutate(mine.message)}
        />
      )}
      {open && (
        <div
          className='grid basis-full gap-2 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] px-2.5 py-2 text-[12px]'
          data-tm-chat-card-form=''
        >
          <p className='text-[var(--tm-fg-2)]'>
            Posts this node&apos;s figure and sparkline to a channel. The message refreshes about
            every 30 seconds while the incident lasts, then freezes with its last values.
          </p>
          <div className='flex flex-wrap items-center gap-1.5'>
            <SimpleSelect
              value={room}
              onChange={setRoom}
              options={[
                { value: '', label: rooms.isLoading ? 'Loading channels…' : 'Pick a channel' },
                ...(rooms.data ?? []).map((r) => ({ value: r.room, label: r.label ?? r.room }))
              ]}
              ariaLabel='Channel'
              triggerProps={{ id: 'tm-chat-card-room' }}
              className='h-7 w-auto min-w-[200px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
            />
            <ConfirmButton
              id='tm-chat-card-post'
              label='Post card'
              confirmLabel='Post to channel?'
              disabled={!room}
              busy={post.isPending}
              onConfirm={() => post.mutate()}
            />
          </div>
          {post.isError && <Note tone='error'>{errorOf(post.error)}</Note>}
        </div>
      )}
      {post.isSuccess && !open && <Note tone='ok'>Posted. It is updating in the channel.</Note>}
    </>
  )
}

register(inspectorActions, {
  id: 'chat-card',
  order: 90,
  applies: (sel) => sharable(sel),
  Component: ChatCard
})
