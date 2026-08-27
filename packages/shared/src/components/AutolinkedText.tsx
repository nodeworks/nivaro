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
// Internal record paths ("workflows/283819") — record-link change reasons
// store the canonical collection/id; the renderer upgrades it to the record's
// display-template label + link.
const PATH_RE = String.raw`\b([a-z][a-z0-9_]{2,})\/(\d{1,12})\b`

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

function RecordToken({ token, plain }: { token: string; plain?: boolean }) {
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
  if (plain) return <span className='font-medium'>{token}</span>
  const target = { collection: card.collection, itemId: String(card.id) }
  const open = () => {
    if (nav.openItem?.(target)) return
    nav.navigate((nav.itemUrl ?? defaultItemUrl)(target))
  }
  return (
    <button
      type='button'
      onClick={open}
      className='inline-flex max-w-full items-center gap-1 align-baseline font-medium text-nvr-navy underline decoration-nvr-cyan/50 decoration-[1.5px] underline-offset-2 hover:decoration-nvr-cyan dark:text-nvr-cyan'
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

/** Dotted-path walk over an expanded row for display-template tokens. */
function renderTemplateLabel(template: string | null, row: Record<string, unknown>): string {
  if (!template) return ''
  return template
    .replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, path: string) => {
      let cur: unknown = row
      for (const seg of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
        if (cur == null || typeof cur !== 'object') return ''
        cur = (cur as Record<string, unknown>)[seg]
      }
      return cur == null ? '' : String(cur)
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** "collection/id" → the record's display-template label, linked. Falls back
 *  to the raw text when the record can't be read or doesn't resolve. */
function RecordPathToken({
  collection,
  id,
  raw,
  plain
}: {
  collection: string
  id: string
  raw: string
  plain?: boolean
}) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const { data } = useQuery({
    queryKey: ['nvr-record-path', collection, id],
    queryFn: async () => {
      try {
        const meta = (await client.request(
          get<{ data: { display_template?: string | null } }>(`/collections/${collection}`)
        )) as { data: { display_template?: string | null } }
        const template = meta.data?.display_template ?? null
        const tokens = [...(template ?? '').matchAll(/\{\{\s*([\w.[\]]+)/g)].map((m) => m[1])
        const fields = template ? ['id', ...tokens.map((t) => t.replace(/\[\d+\]/g, ''))].join(',') : undefined
        const res = (await client.request(
          get<{ data: Record<string, unknown> }>(`/items/${collection}/${id}`, fields ? { fields } : {})
        )) as { data: Record<string, unknown> }
        if (!res.data) return null
        const label = renderTemplateLabel(template, res.data)
        return { label: label || `#${id}` }
      } catch {
        return null
      }
    },
    staleTime: 10 * 60_000
  })
  if (!data) return <>{raw}</>
  if (plain) return <span className='font-medium'>{data.label}</span>
  const target = { collection, itemId: id }
  const open = () => {
    if (nav.openItem?.(target)) return
    nav.navigate((nav.itemUrl ?? defaultItemUrl)(target))
  }
  return (
    <button
      type='button'
      onClick={open}
      className='inline-flex max-w-full items-center align-baseline font-medium text-nvr-navy underline decoration-nvr-cyan/50 decoration-[1.5px] underline-offset-2 hover:decoration-nvr-cyan dark:text-nvr-cyan'
      data-record-path={raw}
      data-tip={raw}
    >
      {data.label}
    </button>
  )
}

export function AutolinkedText({ text, plain }: { text: string; plain?: boolean }) {
  const parts = useMemo(() => {
    const re = new RegExp(`${ENTITY_RE}|${PATH_RE}`, 'g')
    const out: Array<
      | { kind: 'text'; text: string }
      | { kind: 'entity'; text: string }
      | { kind: 'path'; text: string; collection: string; id: string }
    > = []
    let last = 0
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0
      if (i > last) out.push({ kind: 'text', text: text.slice(last, i) })
      if (m[1] !== undefined) out.push({ kind: 'entity', text: m[0] })
      else out.push({ kind: 'path', text: m[0], collection: m[2], id: m[3] })
      last = i + m[0].length
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
    return out
  }, [text])

  if (parts.length === 1 && parts[0]?.kind === 'text') return <>{text}</>
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'entity' ? (
          <RecordToken key={`${p.text}-${i}`} token={p.text} plain={plain} />
        ) : p.kind === 'path' ? (
          <RecordPathToken
            key={`${p.text}-${i}`}
            collection={p.collection}
            id={p.id}
            raw={p.text}
            plain={plain}
          />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static segment list
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}
