import { type AiPhrasing, parseAiPhrasing, type ReviewFinding } from './pure.js'

/**
 * The model's part in the config review: re-word each deterministic reason
 * for an administrator, and propose one label for each inconsistent label
 * concept. It sees configuration names only (codes, titles, reasons, the
 * candidate labels) — never record data — and its reply is parsed by
 * parseAiPhrasing, which keeps only reason text and label strings for ids we
 * sent. No reply is ever executed or turned into a change on its own.
 */

/** At most this many findings are sent — warnings first. */
export const AI_MAX_FINDINGS = 60

export interface AiClientLike {
  messages: {
    create: (params: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text?: string }>
    }>
  }
}

export interface PhrasingDeps {
  getClient: () => Promise<AiClientLike | null>
  model: () => Promise<string>
}

const SYSTEM = [
  'You help an administrator review the configuration of a business application.',
  'You receive findings produced by deterministic checks. For each id, write "reason": one or two plain sentences saying why it matters and what to look at, using only the facts given — never invent counts, names or causes.',
  'For findings that list "labels", also return "label": the single clearest label for that field, preferably one of the candidates, at most 40 characters, title case, no punctuation other than $ % & ( ) / -.',
  'Reply with one JSON object only, keyed by id: {"f1": {"reason": "...", "label": "..."}}. No markdown, no other text.'
].join(' ')

async function defaultDeps(): Promise<PhrasingDeps> {
  const { getAiClient, getAiModelSettings } = await import('../ai-client.js')
  let model: string | null = null
  return {
    model: async () => {
      model ??= (await getAiModelSettings()).summarizeModel
      return model
    },
    getClient: async () => {
      model ??= (await getAiModelSettings()).summarizeModel
      return (await getAiClient({ model })) as unknown as AiClientLike | null
    }
  }
}

export interface PhrasingResult {
  /** Keyed by `${family}|${code}|${subject}`. */
  byKey: Map<string, AiPhrasing>
  /** Why nothing came back, when nothing did. */
  note?: string
}

export async function phraseFindings(
  findings: ReviewFinding[],
  deps?: PhrasingDeps
): Promise<PhrasingResult> {
  const d = deps ?? (await defaultDeps())
  const client = await d.getClient().catch(() => null)
  if (!client) return { byKey: new Map(), note: 'AI is not configured' }
  const picked = [...findings]
    .sort((a, b) => Number(b.severity === 'warning') - Number(a.severity === 'warning'))
    .slice(0, AI_MAX_FINDINGS)
  const idToKey = new Map<string, string>()
  const payload = picked.map((f, i) => {
    const id = `f${i + 1}`
    idToKey.set(id, `${f.family}|${f.code}|${f.subject}`)
    const labels = Array.isArray(f.detail.data?.labels)
      ? (f.detail.data?.labels as Array<{ label: string }>).map((l) => l.label)
      : undefined
    return {
      id,
      code: f.code,
      title: f.title,
      reason: f.detail.reason,
      ...(labels ? { labels } : {})
    }
  })
  if (payload.length === 0) return { byKey: new Map() }
  try {
    const message = await client.messages.create({
      model: await d.model(),
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    })
    const text = message.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    const parsed = parseAiPhrasing(text, new Set(idToKey.keys()))
    const byKey = new Map<string, AiPhrasing>()
    for (const [id, item] of Object.entries(parsed)) {
      const key = idToKey.get(id)
      if (key) byKey.set(key, item)
    }
    return { byKey, note: byKey.size === 0 ? 'The model returned nothing usable' : undefined }
  } catch (err) {
    return { byKey: new Map(), note: `AI call failed: ${String(err).slice(0, 160)}` }
  }
}
