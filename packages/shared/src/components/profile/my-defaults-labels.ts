import type { Command } from '@nivaro/sdk'
import { get } from '../../lib/commands'
import { isEmptyValue } from '../../lib/personal-defaults'
import { loadUserCard } from '../../lib/user-cards'
import { choiceLabel } from '../../lib/utils'
import { formatDisplayValue } from '../item-edit/GroupSection'
import { parseJson } from '../item-edit/helpers'
import { pickedCollection } from '../item-edit/personal-default-checks'
import type { CMSField, CMSRelation } from '../item-edit/types'
import { renderDisplayTemplate, USER_SYSTEM_COLS, userDisplayLabel } from '../pipeline/relations'

// Labels for Profile → My defaults, read as the viewer. A saved default stores ids; the card
// must show what the picker shows (display template / a person's name / a choice's text) and
// never the key itself. Relation values are read in ONE request per related collection
// (`id _in`, `labels=1` so the server may answer from its label-row cache), people through the
// batched user cards.

type Requester = { request: <T>(cmd: Command<T>) => Promise<T> }

/** What one stored value needs before it can be shown. */
export type ValuePart =
  | { kind: 'text'; text: string }
  | { kind: 'records'; target: string; ids: string[] }
  | { kind: 'unknown' }

function plain(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'id' in (v as object))
    return (v as { id: unknown }).id
  return v
}

/** How a field's stored value turns into a label (no I/O). */
export function describeValue(
  fc: CMSField | undefined,
  relations: CMSRelation[],
  collection: string,
  value: unknown
): ValuePart {
  if (!fc) return { kind: 'unknown' }
  const rel = pickedCollection(relations, collection, fc.field)
  if (rel) {
    const list = Array.isArray(value) ? value : isEmptyValue(value) ? [] : [value]
    return { kind: 'records', target: rel.target, ids: list.map((x) => String(plain(x))) }
  }
  const raw = parseJson<{ choices?: unknown }>(fc.options)?.choices
  if (Array.isArray(raw) && raw.length > 0 && (fc.interface ?? '') !== 'tags') {
    const list = Array.isArray(value) ? value : [value]
    const text = list.map((v) => {
      const hit = raw.find(
        (c) =>
          String(c && typeof c === 'object' ? (c as { value?: unknown }).value : c) === String(v)
      )
      const t = hit && typeof hit === 'object' ? (hit as { text?: string }).text : hit
      return t != null && t !== '' ? choiceLabel(String(t)) : String(v)
    })
    return { kind: 'text', text: text.join(', ') }
  }
  if (typeof value === 'boolean') return { kind: 'text', text: value ? 'Yes' : 'No' }
  if ((fc.interface ?? '').startsWith('file')) return { kind: 'unknown' }
  return { kind: 'text', text: formatDisplayValue(value, fc) }
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } } | null
  return e?.status ?? e?.response?.status
}

export const labelKey = (target: string, id: string) => `${target}:${id}`

/**
 * Labels for every (target, id) asked for. A key is absent when the record did not read for
 * the viewer (removed, or no longer visible); null when it read but shows nothing but its id.
 */
export async function loadDefaultLabels(
  client: Requester,
  byTarget: Map<string, string[]>,
  templateOf: (target: string) => Promise<string | null>
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  await Promise.all(
    [...byTarget].map(async ([target, all]) => {
      const ids = [...new Set(all)]
      if (ids.length === 0) return
      if (USER_SYSTEM_COLS.has(target)) {
        const cards = await Promise.all(ids.map((id) => loadUserCard(client, id).catch(() => null)))
        ids.forEach((id, i) => {
          const card = cards[i]
          if (!card) return
          const name = userDisplayLabel(card).trim()
          out.set(labelKey(target, id), name && name !== id ? name : null)
        })
        return
      }
      // Other system tables have no /items route for most viewers: nothing to show.
      if (/^(nivaro|directus)_/i.test(target)) return
      const template = await templateOf(target).catch(() => null)
      const tokens = template
        ? [...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1].trim())
        : []
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200)
        const res = await client
          .request<{ data: Array<Record<string, unknown>> }>(
            get(`/items/${target}`, {
              filter: JSON.stringify({ id: { _in: chunk } }),
              limit: chunk.length,
              fields: tokens.length ? ['id', ...tokens].join(',') : '*',
              labels: 1
            })
          )
          .catch((err) => {
            // Refused / gone = the viewer cannot see these records; anything else is not an answer.
            if (statusOf(err) === 403 || statusOf(err) === 404) return null
            throw err
          })
        for (const row of res?.data ?? []) {
          const id = String(row.id)
          const shown = renderDisplayTemplate(template, row).trim()
          // renderDisplayTemplate falls back to the id: that is no label.
          const readable = /[\p{L}\p{N}]/u.test(shown) && shown !== id
          out.set(labelKey(target, id), readable ? shown : null)
        }
      }
    })
  )
  return out
}
