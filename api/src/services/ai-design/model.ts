import { getAiClient, getAiModelSettings } from '../ai-client.js'

/**
 * The one model seam the AI design features use (layout review, help text,
 * role design, role views). Every feature takes a `complete` function so a
 * test can hand in a stub and never reach a provider; the default resolves
 * the configured client.
 *
 * What comes back is DATA: callers parse it with `parseJsonLoose`, validate
 * every value against the schema they already know, and drop the rest.
 * Nothing the model writes is ever executed or written without an admin's
 * confirmation.
 */
export type AiComplete = (req: {
  system: string
  user: string
  maxTokens?: number
}) => Promise<string>

export class AiUnavailableError extends Error {
  constructor() {
    super('AI is not configured — set it up under Settings → AI Features')
    this.name = 'AiUnavailableError'
  }
}

/** The configured provider, or null when none is set up. */
export async function defaultComplete(): Promise<AiComplete | null> {
  const client = await getAiClient()
  if (!client) return null
  const { model } = await getAiModelSettings()
  return async ({ system, user, maxTokens }) => {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens ?? 2000,
      system,
      messages: [{ role: 'user', content: user }]
    })
    return msg.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n')
      .trim()
  }
}

/**
 * The JSON object inside a model answer: strips code fences and surrounding
 * prose. Returns null when nothing parses — callers treat that as "no
 * suggestions", never as an error worth a 500.
 */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  let t = String(text ?? '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(t.slice(start, end + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A trimmed, single-line string capped at `max`, or null when empty. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export function titleCase(field: string): string {
  return field
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
