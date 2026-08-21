import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { defaultItemUrl, useNavigation, useNivaroClient } from '../context'
import { get } from '../lib/commands'

/**
 * Renders plain text with entity-registry-shaped record ids (CR26-76773,
 * HQ26INV-1234…) as live record chips — the token linked to the record plus
 * its current pipeline state as a colored pill, exactly like chat entity
 * tokens, resolved through the same nivaro_chat_room_types registry. A token
 * that resolves to nothing (unregistered prefix, no record) renders as plain
 * text, so false pattern matches cost nothing.
 */

// Same default shape chat uses for entity tokens.
const ENTITY_RE = String.raw`\b([A-Za-z]{2,4}\d{2}(?:INV)?-\d+)\b`

type RoomType = { prefix: string; collection: string; match_field: string; is_active: boolean }

function useRoomTypes(): RoomType[] {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-room-types'],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: RoomType[] }>('/chat/room-types')
      )) as { data: RoomType[] }
      return (res.data ?? []).filter((t) => t.is_active)
    },
    staleTime: 5 * 60_000
  })
  return data ?? []
}

function RecordToken({ token }: { token: string }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const types = useRoomTypes()

  const { data: card } = useQuery({
    queryKey: ['nvr-record-token', token],
    queryFn: async () => {
      for (const t of types) {
        try {
          const res = (await client.request(
            get<{ data: Array<{ id: string | number }> }>(`/items/${t.collection}`, {
              limit: 1,
              fields: 'id',
              filter: JSON.stringify({ [t.match_field]: { _eq: token } })
            })
          )) as { data: Array<{ id: string | number }> }
          const id = res.data?.[0]?.id
          if (id == null) continue
          let state: { label?: string; color?: string } | null = null
          try {
            const inst = (await client.request(
              get<{
                data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null
              }>(`/pipelines/instance/${t.collection}/${id}`)
            )) as {
              data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null
            }
            state = inst.data?.instance?.current_state_obj ?? null
          } catch {
            /* no pipeline — chip still links */
          }
          return { collection: t.collection, id, state: state?.label ?? null, color: state?.color ?? null }
        } catch {
          /* try the next registered type */
        }
      }
      return null
    },
    enabled: types.length > 0,
    staleTime: 10 * 60_000
  })

  if (!card) return <>{token}</>
  const target = { collection: card.collection, itemId: String(card.id) }
  const open = () => {
    if (nav.openItem?.(target)) return
    nav.navigate((nav.itemUrl ?? defaultItemUrl)(target))
  }
  return (
    <button
      type='button'
      onClick={open}
      className='inline-flex max-w-full items-center gap-1 align-baseline font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
      data-record-token={token}
    >
      {token}
      {card.state && (
        <span
          className='inline-flex items-center rounded-full px-1.5 py-px text-[9px] font-semibold leading-tight'
          style={{
            backgroundColor: card.color ? `${card.color}26` : 'rgba(100,116,139,.15)',
            color: card.color ?? undefined
          }}
        >
          {card.state}
        </span>
      )}
    </button>
  )
}

export function AutolinkedText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const re = new RegExp(ENTITY_RE, 'g')
    const out: Array<{ text: string; entity: boolean }> = []
    let last = 0
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0
      if (i > last) out.push({ text: text.slice(last, i), entity: false })
      out.push({ text: m[0], entity: true })
      last = i + m[0].length
    }
    if (last < text.length) out.push({ text: text.slice(last), entity: false })
    return out
  }, [text])

  if (parts.length === 1 && !parts[0]?.entity) return <>{text}</>
  return (
    <>
      {parts.map((p, i) =>
        p.entity ? <RecordToken key={`${p.text}-${i}`} token={p.text} /> : <span key={i}>{p.text}</span>
      )}
    </>
  )
}
