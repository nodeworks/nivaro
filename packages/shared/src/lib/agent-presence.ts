import { useEffect, useMemo, useState } from 'react'
import { useLiveEvent } from './live'
import { useLivePreference } from './live-preference'

/**
 * Agents working on a record right now (rt8 #21): "Claude (for Rob) is updating this record".
 *
 * The server marks a record whenever an AI agent's tool call (hosted MCP) reads or writes it
 * and tells the record room `record:agents` with the whole current list; a socket that joins the
 * room later is told once on join (api services/agent-presence.ts). The room admits only people
 * who may open the record, so this hook never learns about an agent on a record its viewer
 * cannot see. Names only: the name the agent's connection goes by (its owner or an administrator
 * sets it) and the person it acts for.
 *
 * A presence indicator: quiet in Calm and Off (the live preference seam drops the event, and
 * anything already shown clears).
 */

export type AgentMode = 'reading' | 'updating'

export interface RecordAgent {
  key: string
  name: string
  for: { id: string; name: string }
  mode: AgentMode
  /** Local clock (ms) the mark lapses at. */
  until: number
}

interface WireAgent {
  key?: unknown
  name?: unknown
  for?: { id?: unknown; name?: unknown } | null
  mode?: unknown
  ttl_ms?: unknown
}

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')

/** A `record:agents` payload as the agents to show, on this tab's clock (pure). */
export function agentsFromPayload(list: unknown, now: number): RecordAgent[] {
  if (!Array.isArray(list)) return []
  const out: RecordAgent[] = []
  for (const raw of list as WireAgent[]) {
    const key = str(raw?.key, 40)
    const name = str(raw?.name, 60)
    const ttl = Number(raw?.ttl_ms)
    if (!key || !name || !Number.isFinite(ttl) || ttl <= 0) continue
    out.push({
      key,
      name,
      for: { id: str(raw?.for?.id, 64), name: str(raw?.for?.name, 80) },
      mode: raw?.mode === 'updating' ? 'updating' : 'reading',
      until: now + Math.min(ttl, 60_000)
    })
  }
  // Writers first, then by name — a stable order, so nothing hops about on a refresh.
  return out.sort(
    (a, b) =>
      (a.mode === b.mode ? 0 : a.mode === 'updating' ? -1 : 1) ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key)
  )
}

/** "Claude (for Rob) is updating this record" (pure). `meId` reads the viewer's own as "you". */
export function agentSentence(a: RecordAgent, meId?: string | null, short = false): string {
  const mine = !!meId && !!a.for.id && a.for.id.toUpperCase() === String(meId).toUpperCase()
  const who = mine ? 'you' : a.for.name || 'someone'
  const verb = a.mode === 'updating' ? 'is updating' : 'is reading'
  return short ? `${a.name} ${verb}` : `${a.name} (for ${who}) ${verb} this record`
}

/** Whose agent it is, for the short (phone) line: "Your" / "Rob’s" / null when unknown.
 *  The short line once dropped the owner entirely — and whose agent it is is the point. */
export function agentOwnerPrefix(a: RecordAgent, meId?: string | null): string | null {
  const mine = !!meId && !!a.for.id && a.for.id.toUpperCase() === String(meId).toUpperCase()
  if (mine) return 'Your'
  // First name only: the phone line has room for whose agent it is, not a full name.
  const first = (a.for.name ?? '').trim().split(/\s+/)[0]
  return first ? `${first}’s` : null
}

/** The agents on one record right now; [] when there are none or live presence is quiet. */
export function useRecordAgents(
  collection: string | null | undefined,
  item: string | number | null | undefined
): RecordAgent[] {
  const id = item == null ? '' : String(item)
  const { quiet } = useLivePreference()
  const enabled = !!collection && !!id && id !== 'new' && !quiet
  const [agents, setAgents] = useState<RecordAgent[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new record (or going quiet) starts empty
  useEffect(() => setAgents([]), [collection, id, enabled])
  useLiveEvent('record:agents', (p) => setAgents(agentsFromPayload(p?.agents, Date.now())), {
    enabled,
    includeOwn: true,
    match: (p) => p?.collection === collection && String(p?.item) === id
  })
  // Each mark lapses on its own: one timer for the soonest.
  useEffect(() => {
    if (agents.length === 0) return
    const next = Math.min(...agents.map((a) => a.until))
    const t = setTimeout(
      () => setAgents((cur) => cur.filter((a) => a.until > Date.now())),
      Math.max(250, next - Date.now() + 50)
    )
    return () => clearTimeout(t)
  }, [agents])
  return useMemo(() => (enabled ? agents : []), [agents, enabled])
}
