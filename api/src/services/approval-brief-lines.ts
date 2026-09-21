/**
 * Extension lines on the approval brief.
 *
 * The brief answers "what am I approving" from the record's own history. A
 * deployment often has one more fact an approver should see before the click —
 * a figure kept elsewhere, a check only the extension can run. An extension
 * registers a provider per collection; each returns one short line or null.
 * A provider that throws or is slow is dropped for that brief, never the brief.
 */
export interface BriefLine {
  label: string
  text: string
  tone?: 'ok' | 'warn' | 'danger' | 'neutral'
}
export type BriefLineProvider = (args: { collection: string; item: string }) => Promise<BriefLine | null>

const providers = new Map<string, Array<{ owner: string; fn: BriefLineProvider }>>()

export function registerBriefLine(owner: string, collection: string, fn: BriefLineProvider): void {
  const list = providers.get(collection) ?? []
  list.push({ owner, fn })
  providers.set(collection, list)
}

export function describeBriefLines(): Array<{ owner: string; collection: string }> {
  return [...providers.entries()].flatMap(([collection, list]) => list.map((p) => ({ owner: p.owner, collection })))
}

const TIMEOUT_MS = 4000

export async function briefLinesFor(collection: string, item: string): Promise<BriefLine[]> {
  const list = providers.get(collection) ?? []
  if (list.length === 0) return []
  const out = await Promise.all(
    list.map((p) =>
      Promise.race([
        p.fn({ collection, item }).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS).unref())
      ])
    )
  )
  return out
    .filter((l): l is BriefLine => !!l && typeof l.text === 'string' && l.text.trim().length > 0)
    .map((l) => ({ label: String(l.label ?? '').slice(0, 60), text: l.text.slice(0, 300), tone: l.tone ?? 'neutral' }))
}
