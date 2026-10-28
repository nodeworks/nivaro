import type Anthropic from '@anthropic-ai/sdk'

/**
 * Prompt cost breakdown (#2731): how many tokens each part of a request
 * carried. Counted from the request the client actually sent — the system
 * prompt is cut at the headings the builders write (ai-chat.ts,
 * ai-knowledge.ts, ai-playbooks.ts, ai-ask-context.ts), the tool definitions
 * and the message history are measured as sent.
 *
 * Sizes start as ≈4 characters per token; once the provider reports the real
 * prompt size (input + cache read + cache write) the parts are scaled to sum
 * to it. The cached share of each part follows the provider's order — tools,
 * then system, then messages — so a part is "cached" for exactly the tokens
 * that sit inside the cache-read prefix.
 */

export const PROMPT_PARTS = [
  'tool_definitions',
  'system_rules',
  'data_guide',
  'glossary',
  'catalogues',
  'playbooks',
  'attachments',
  'history',
  'question'
] as const
export type PromptPart = (typeof PROMPT_PARTS)[number]

export const PART_LABELS: Record<PromptPart, string> = {
  tool_definitions: 'Tool definitions',
  system_rules: 'System prompt rules',
  data_guide: 'Data guides',
  glossary: 'Glossary',
  catalogues: 'Collection, query and view lists',
  playbooks: 'Playbooks (answered before)',
  attachments: 'Attachments',
  history: 'History and tool results',
  question: 'The question'
}

export interface PartTokens {
  part: PromptPart
  tokens: number
  cached: number
}

const MARKERS: Array<{ re: RegExp; part: PromptPart }> = [
  { re: /\nHow this instance's data is organised/, part: 'data_guide' },
  { re: /(?:^|\n)Data guides for the collections this question touches/, part: 'data_guide' },
  {
    re: /(?:^|\n)Glossary (?:\(business terms|terms defined|definitions for terms)/,
    part: 'glossary'
  },
  { re: /(?:^|\n)Readable collections \(/, part: 'catalogues' },
  { re: /(?:^|\n)Which collections you can read is not listed/, part: 'catalogues' },
  { re: /(?:^|\n)Saved queries you may run/, part: 'catalogues' },
  { re: /(?:^|\n)Queues you may ask about/, part: 'catalogues' },
  { re: /(?:^|\n)Saved views you may use/, part: 'catalogues' },
  {
    re: /(?:^|\n)(?:Answered before — similar questions|Tool plans that answered similar questions)/,
    part: 'playbooks'
  },
  { re: /(?:^|\n)Documents the person attached to the question/, part: 'attachments' }
]

const tok = (chars: number) => Math.ceil(chars / 4)

/** Cut a system prompt into parts at the known headings; the head is the rules. */
export function splitSystem(system: string): Array<{ part: PromptPart; chars: number }> {
  const hits: Array<{ at: number; part: PromptPart }> = []
  for (const m of MARKERS) {
    const found = m.re.exec(system)
    if (found) hits.push({ at: found.index, part: m.part })
  }
  hits.sort((a, b) => a.at - b.at)
  const out: Array<{ part: PromptPart; chars: number }> = []
  const push = (part: PromptPart, chars: number) => {
    if (chars <= 0) return
    const last = out[out.length - 1]
    if (last && last.part === part) last.chars += chars
    else out.push({ part, chars })
  }
  let cursor = 0
  let current: PromptPart = 'system_rules'
  for (const h of hits) {
    push(current, h.at - cursor)
    cursor = h.at
    current = h.part
  }
  push(current, system.length - cursor)
  return out
}

type Block = { type?: string; text?: string; [k: string]: unknown }

function systemText(system: Anthropic.MessageCreateParams['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system.map((b) => (b as Block).text ?? '').join('\n')
}

const ATTACH_RE = /^Documents the person attached to the question/

/** Estimated token size of each part, in the order the provider reads them. */
export function measureParts(params: Anthropic.MessageCreateParams): PartTokens[] {
  const seq: Array<{ part: PromptPart; chars: number }> = []
  if (params.tools?.length) {
    const chars = params.tools.reduce((n, t) => {
      const { cache_control: _c, ...rest } = t as unknown as Record<string, unknown>
      return n + JSON.stringify(rest).length
    }, 0)
    seq.push({ part: 'tool_definitions', chars })
  }
  seq.push(...splitSystem(systemText(params.system)))
  const msgs = Array.isArray(params.messages) ? params.messages : []
  msgs.forEach((m, i) => {
    const newest = i === msgs.length - 1
    const content = m.content as string | Block[]
    const blocks: Block[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content
    for (const b of blocks ?? []) {
      let part: PromptPart = newest && m.role === 'user' ? 'question' : 'history'
      let chars: number
      if (b.type === 'image' || b.type === 'document') {
        part = 'attachments'
        // a base64 payload counts for what it costs the model, not its encoded length
        const data = (b.source as { data?: string } | undefined)?.data
        chars = data ? Math.ceil(data.length * 0.75) : 4000
      } else if (b.type === 'text') {
        const text = b.text ?? ''
        if (ATTACH_RE.test(text)) part = 'attachments'
        chars = text.length
      } else {
        // tool_use / tool_result: the loop's own history
        part = 'history'
        chars = JSON.stringify(b).length
      }
      seq.push({ part, chars })
    }
  })
  return foldParts(seq.map((s) => ({ part: s.part, tokens: tok(s.chars), cached: 0 })))
}

/** Same part appearing twice (history before and after a question) keeps first-seen order. */
function foldParts(rows: PartTokens[]): PartTokens[] {
  const out: PartTokens[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last && last.part === r.part) {
      last.tokens += r.tokens
      last.cached += r.cached
    } else out.push({ ...r })
  }
  return out
}

/**
 * Scale the estimate to the provider's real prompt size and mark which tokens
 * were served from cache (the first `cacheRead` tokens in reading order).
 * Without usage figures the estimate stands, uncached.
 */
export function applyUsage(
  parts: PartTokens[],
  usage: {
    input?: number | null
    cacheRead?: number | null
    cacheWrite?: number | null
    /** The OpenAI-shaped gateway reports prompt_tokens, which already counts the cached ones. */
    inputIncludesCache?: boolean
  }
): PartTokens[] {
  const total = parts.reduce((n, p) => n + p.tokens, 0)
  const real = usage.inputIncludesCache
    ? (usage.input ?? 0)
    : (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const k = real > 0 && total > 0 ? real / total : 1
  let cacheLeft = Math.max(0, usage.cacheRead ?? 0)
  return parts.map((p) => {
    const tokens = Math.max(0, Math.round(p.tokens * k))
    const cached = Math.min(tokens, cacheLeft)
    cacheLeft -= cached
    return { part: p.part, tokens, cached }
  })
}

/**
 * Compact storage form: `{"v":"<release>","p":[[part, tokens, cached], …]}` —
 * the release rides along so the page can trend prompt size per release.
 */
export function serializeParts(parts: PartTokens[], version?: string): string {
  return JSON.stringify({ v: version ?? null, p: parts.map((p) => [p.part, p.tokens, p.cached]) })
}

export function parseStored(raw: unknown): { version: string | null; parts: PartTokens[] } {
  if (typeof raw !== 'string' || !raw) return { version: null, parts: [] }
  try {
    const obj = JSON.parse(raw)
    const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.p) ? obj.p : []
    const parts: PartTokens[] = []
    for (const r of arr) {
      if (!Array.isArray(r)) continue
      const part = String(r[0]) as PromptPart
      if (!(PROMPT_PARTS as readonly string[]).includes(part)) continue
      parts.push({ part, tokens: Number(r[1]) || 0, cached: Number(r[2]) || 0 })
    }
    return { version: typeof obj?.v === 'string' ? obj.v : null, parts }
  } catch {
    return { version: null, parts: [] }
  }
}

export const parseParts = (raw: unknown): PartTokens[] => parseStored(raw).parts

/** Sum the same part across many calls. */
export function sumParts(
  rows: PartTokens[][]
): Record<PromptPart, { tokens: number; cached: number }> {
  const out = {} as Record<PromptPart, { tokens: number; cached: number }>
  for (const p of PROMPT_PARTS) out[p] = { tokens: 0, cached: 0 }
  for (const parts of rows)
    for (const p of parts) {
      out[p.part].tokens += p.tokens
      out[p.part].cached += p.cached
    }
  return out
}
