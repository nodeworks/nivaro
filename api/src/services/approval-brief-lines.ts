import type { BriefLine, BriefLineProvider } from '@nivaro/extension-kit'

export type { BriefLine, BriefLineProvider } from '@nivaro/extension-kit'

const providers = new Map<string, Array<{ owner: string; fn: BriefLineProvider }>>()

export function registerBriefLine(owner: string, collection: string, fn: BriefLineProvider): void {
  const list = providers.get(collection) ?? []
  list.push({ owner, fn })
  providers.set(collection, list)
}

export function describeBriefLines(): Array<{ owner: string; collection: string }> {
  return [...providers.entries()].flatMap(([collection, list]) =>
    list.map((p) => ({ owner: p.owner, collection }))
  )
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
    .map((l) => ({
      label: String(l.label ?? '').slice(0, 60),
      text: l.text.slice(0, 300),
      tone: l.tone ?? 'neutral'
    }))
}
