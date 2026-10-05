import { db } from '../../../db/index.js'

export function extractSqlBlock(text: string): string | null {
  const m = text.match(/```sql\s*\n([\s\S]*?)```/i) ?? text.match(/```\s*\n([\s\S]*?)```/)
  return m ? m[1].trim() : null
}

function params(body: string): string[] {
  const head = body.split(/\bAS\b\s*(BEGIN|SET|SELECT|DECLARE|IF|WITH|;)/i)[0] ?? body
  return [...head.matchAll(/@(\w+)\s+([\w()\s,]+?)(?=\s*(=|,|\bAS\b|\bOUTPUT\b|$))/gi)]
    .map((m) => `${m[1].toLowerCase()}:${m[2].replace(/\s+/g, '').toLowerCase()}`)
    .sort()
}

export function sameSignature(a: string, b: string): boolean {
  return JSON.stringify(params(a)) === JSON.stringify(params(b))
}

/** The last 24 h of AI spend against the tuner's budget; true when the call log is absent. */
export async function aiBudgetAllows(limitUsd: number): Promise<boolean> {
  try {
    const row = (await db('nivaro_ai_calls')
      .where('created_at', '>', new Date(Date.now() - 86_400_000))
      .sum({ usd: 'cost_usd' })
      .first()) as { usd: number | string | null } | undefined
    return Number(row?.usd ?? 0) <= limitUsd
  } catch {
    return true
  }
}

interface MinimalClient {
  messages: {
    create(
      args: Record<string, unknown>
    ): Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

export async function aiRewriteCandidate(args: {
  proc: string
  body: string
  planOps: string[]
  hotLines: string[]
  client?: MinimalClient
  model?: string
}): Promise<{ body: string; notes: string[] } | null> {
  let client = args.client
  let model = args.model
  if (!client) {
    const { getAiClient, getAiModelSettings } = await import('../../ai-client.js')
    const settings = await getAiModelSettings()
    model = model ?? settings.chatModel
    client = ((await getAiClient({ model })) as unknown as MinimalClient | null) ?? undefined
  }
  if (!client || !model) return null
  const prompt = `You are rewriting one SQL Server stored procedure for performance in a production system.

RULES — every one is checked by a machine proof after you answer:
- The rewritten procedure must return EXACTLY the same result set (same rows, same columns, same values) for every parameter set.
- Keep the procedure name and the exact parameter list (names, types, defaults, order).
- No writes to real tables (temp tables and table variables are fine), no dynamic SQL, no linked servers, no new procedures.
- Prefer: set-based reads, EXISTS instead of filter-only joins, hoisting correlated subqueries into grouped temp tables, avoiding repeated scans.
- Answer with ONLY one fenced \`\`\`sql block holding the full CREATE OR ALTER PROCEDURE.

CURRENT PROCEDURE:
${args.body.slice(0, 24_000)}

HOT SPOTS FROM THE PLAN (operator · object · cost):
${args.planOps.slice(0, 20).join('\n') || '(none captured)'}

STATEMENTS THAT COST THE MOST:
${args.hotLines.slice(0, 10).join('\n') || '(none captured)'}`
  try {
    const message = await client.messages.create({
      model,
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = message.content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('')
    const body = extractSqlBlock(text)
    if (!body) return null
    const name = args.proc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`PROC(EDURE)?\\s+(\\[?dbo\\]?\\.)?\\[?${name}\\]?\\b`, 'i').test(body))
      return null
    if (!sameSignature(args.body, body)) return null
    return { body, notes: ['AI-written'] }
  } catch {
    return null
  }
}
