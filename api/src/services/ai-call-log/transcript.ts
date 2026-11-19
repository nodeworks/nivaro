import { isSensitiveKey, MASK, maskBodySecrets } from '../secret-mask.js'
import { parsePartialJson } from './partial-json.js'

/**
 * One logged model call, read the way a person reads it (Rob 2026-11-18:
 * "see the actual message not just the json and remove all the system prompts").
 *
 * The stored request is `{messages, tools, system}` (older rows `{system, tools,
 * messages}`), capped at 48 KB; the response is the content blocks, capped at
 * 16 KB. This turns both into: the earlier turns of the conversation, the
 * person's latest message, every tool step since (name, input, what came back),
 * and what this call answered. The system prompt, the tool definitions and
 * cache markers are counted, never shown here — the raw view has them.
 *
 * Pure. Values under credential-looking keys are masked; base64 attachments
 * are reduced to their type and size.
 */

export interface ToolStep {
  kind: 'tool'
  id: string | null
  name: string
  /** Flat, readable input: [label, value] pairs (nested values as compact JSON). */
  input: Array<[string, string]>
  /** null = the result arrives in the next call of the same question. */
  result: ToolResultSummary | null
  /** True when this tool call was asked for by THIS call's response. */
  from_this_call: boolean
}

export interface ToolResultSummary {
  error: boolean
  /** Row count when the result is a list or a compact table. */
  rows: number | null
  /** Total the tool reported (e.g. "50 of 255"). */
  total: number | null
  columns: string[]
  /** Up to 5 rows of the result, for a peek. */
  sample: Array<Record<string, string>>
  /** A short plain-language line ("50 of 255 rows", the error text, the first words). */
  text: string
  chars: number
}

export type TranscriptStep =
  | { kind: 'question'; text: string; attachments: AttachmentNote[] }
  | { kind: 'note'; text: string }
  | ToolStep
  | { kind: 'answer'; text: string; final: boolean }

export interface AttachmentNote {
  type: string
  media_type: string | null
  size_kb: number | null
  name: string | null
}

export interface EarlierTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface Transcript {
  /** Turns before the latest question (folded in the UI). */
  earlier: EarlierTurn[]
  steps: TranscriptStep[]
  hidden: {
    system_chars: number
    tool_definitions: number
    tool_names: string[]
    cache_markers: number
  }
  /** The stored request or response was cut at the log's size cap. */
  cut: { request: boolean; response: boolean }
  /** The request body could not be read at all (cut before the messages). */
  unreadable: boolean
}

type Block = Record<string, unknown>

const WRAP = /^\s*<data source="[^"]*">\s*([\s\S]*?)\s*(?:<\/data>\s*)?$/

function asBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content)
    ? (content.filter((b) => b && typeof b === 'object') as Block[])
    : []
}

function textOf(blocks: Block[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n')
    .trim()
}

/** Every value under a credential-looking key becomes `••••••`, at any depth. */
export function maskDeep(v: unknown, depth = 0): unknown {
  if (depth > 12) return v
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] =
        isSensitiveKey(k) &&
        x != null &&
        x !== '' &&
        typeof x !== 'number' &&
        typeof x !== 'boolean'
          ? MASK
          : maskDeep(x, depth + 1)
    }
    return out
  }
  return v
}

/** Base64 bodies (images, documents) replaced by a size note; the rest kept. */
export function stripBinary(v: unknown, depth = 0): unknown {
  if (depth > 12) return v
  if (Array.isArray(v)) return v.map((x) => stripBinary(x, depth + 1))
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.type === 'base64' && typeof o.data === 'string') {
      return { ...o, data: `[${Math.round((o.data.length * 3) / 4 / 1024)} KB of base64 left out]` }
    }
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(o)) out[k] = stripBinary(x, depth + 1)
    return out
  }
  return v
}

function compact(v: unknown, max = 400): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  let s: string
  try {
    s = JSON.stringify(v)
  } catch {
    s = String(v)
  }
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** A tool input as label/value pairs — one level flat, deeper values compact JSON. */
export function flatInput(input: unknown): Array<[string, string]> {
  const masked = maskDeep(input)
  if (!masked || typeof masked !== 'object' || Array.isArray(masked))
    return masked == null ? [] : [['input', compact(masked)]]
  return Object.entries(masked as Record<string, unknown>).map(([k, v]) => [k, compact(v)])
}

function cellText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') return compact(v, 80)
  const s = String(v)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

/** What a tool returned, in a line and a peek. Understands the compact table
 *  shape (`$cols` / `$rows`), plain lists, `{rows|data|items: [...]}` and errors. */
export function summarizeToolResult(content: unknown, isError: boolean): ToolResultSummary {
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content as Block[])
            .map((b) => (b?.type === 'text' ? String(b.text ?? '') : ''))
            .join('\n')
        : compact(content, 100_000)
  const unwrapped = raw.match(WRAP)?.[1] ?? raw
  const error = isError || /^\s*error\b/i.test(unwrapped)
  const parsed = parsePartialJson(unwrapped.trim()).value
  let rows: number | null = null
  let total: number | null = null
  let columns: string[] = []
  let sample: Array<Record<string, string>> = []
  const fromList = (list: unknown[]) => {
    rows = list.length
    const objs = list.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Array<
      Record<string, unknown>
    >
    columns = [...new Set(objs.slice(0, 20).flatMap((o) => Object.keys(o)))].slice(0, 12)
    sample = objs.slice(0, 5).map((o) => {
      const m = maskDeep(o) as Record<string, unknown>
      return Object.fromEntries(columns.map((c) => [c, cellText(m[c])]))
    })
  }
  const visit = (p: unknown, depth: number) => {
    if (depth > 3 || rows != null) return
    if (Array.isArray(p)) return fromList(p)
    if (!p || typeof p !== 'object') return
    const o = p as Record<string, unknown>
    if (Array.isArray(o.$cols) && Array.isArray(o.$rows)) {
      const cols = (o.$cols as unknown[]).map(String)
      const list = (o.$rows as unknown[]).map((r) =>
        Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r
      )
      fromList(list)
    }
    for (const k of ['total', 'count', 'total_count']) {
      if (total == null && typeof o[k] === 'number') total = o[k] as number
    }
    for (const k of ['rows', 'data', 'items', 'results', 'records', 'sections', 'videos']) {
      if (rows == null && o[k] != null) visit(o[k], depth + 1)
    }
    // A compact table under any other key (list_collections: `fields: {$cols, $rows}`).
    for (const v of Object.values(o)) {
      if (rows != null) break
      if (v && typeof v === 'object' && !Array.isArray(v) && '$rows' in (v as object))
        visit(v, depth + 1)
    }
  }
  visit(parsed, 0)
  let text: string
  if (error) text = unwrapped.replace(/\s+/g, ' ').trim().slice(0, 300)
  else if (rows != null)
    text =
      total != null && total !== rows
        ? `${rows} of ${total} rows`
        : `${rows} ${rows === 1 ? 'row' : 'rows'}`
  else text = unwrapped.replace(/\s+/g, ' ').trim().slice(0, 240)
  return { error, rows, total, columns, sample, text, chars: raw.length }
}

function attachmentOf(b: Block): AttachmentNote | null {
  if (b.type !== 'image' && b.type !== 'document') return null
  const src = (b.source ?? {}) as Record<string, unknown>
  const data = typeof src.data === 'string' ? src.data : null
  return {
    type: String(b.type),
    media_type: typeof src.media_type === 'string' ? src.media_type : null,
    size_kb: data ? Math.round((data.length * 3) / 4 / 1024) : null,
    name: typeof b.title === 'string' ? b.title : null
  }
}

/** Does this user turn carry words the person typed (not only tool results)? */
function isPersonTurn(m: { role?: unknown; content?: unknown }): boolean {
  if (m.role !== 'user') return false
  const blocks = asBlocks(m.content)
  return (
    blocks.some((b) => b.type === 'text' && String(b.text ?? '').trim()) ||
    blocks.some((b) => b.type === 'image' || b.type === 'document')
  )
}

function countCacheMarkers(v: unknown, depth = 0): number {
  if (depth > 8 || !v || typeof v !== 'object') return 0
  if (Array.isArray(v)) return v.reduce((s: number, x) => s + countCacheMarkers(x, depth + 1), 0)
  const o = v as Record<string, unknown>
  let n = o.cache_control ? 1 : 0
  for (const x of Object.values(o)) n += countCacheMarkers(x, depth + 1)
  return n
}

export function buildTranscript(
  requestText: string | null,
  responseText: string | null,
  opts: { stopReason?: string | null } = {}
): Transcript {
  const req = parsePartialJson(requestText)
  const res = parsePartialJson(responseText)
  const body = (req.value && typeof req.value === 'object' ? req.value : {}) as {
    system?: unknown
    tools?: unknown
    messages?: Array<{ role?: unknown; content?: unknown }>
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const systemChars =
    typeof body.system === 'string'
      ? body.system.length
      : Array.isArray(body.system)
        ? (body.system as Block[]).reduce((s, b) => s + String(b?.text ?? '').length, 0)
        : 0
  const toolNames = Array.isArray(body.tools)
    ? (body.tools as unknown[]).map((t) =>
        typeof t === 'string' ? t : String((t as { name?: unknown })?.name ?? '')
      )
    : []

  // The latest message the person typed: everything before it is earlier turns.
  let qi = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPersonTurn(messages[i])) {
      qi = i
      break
    }
  }
  const earlier: EarlierTurn[] = []
  for (let i = 0; i < Math.max(0, qi); i++) {
    const m = messages[i]
    const text = textOf(asBlocks(m.content))
    if (!text) continue
    earlier.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text })
  }

  const steps: TranscriptStep[] = []
  const toolById = new Map<string, ToolStep>()
  if (qi >= 0) {
    const qBlocks = asBlocks(messages[qi].content)
    steps.push({
      kind: 'question',
      text: textOf(qBlocks),
      attachments: qBlocks.map(attachmentOf).filter((a): a is AttachmentNote => !!a)
    })
  }
  const start = qi >= 0 ? qi + 1 : 0
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]
    for (const b of asBlocks(m.content)) {
      if (m.role === 'assistant') {
        if (b.type === 'text' && String(b.text ?? '').trim())
          steps.push({ kind: 'note', text: String(b.text).trim() })
        if (b.type === 'tool_use') {
          const step: ToolStep = {
            kind: 'tool',
            id: typeof b.id === 'string' ? b.id : null,
            name: String(b.name ?? 'tool'),
            input: flatInput(b.input),
            result: null,
            from_this_call: false
          }
          if (step.id) toolById.set(step.id, step)
          steps.push(step)
        }
      } else if (b.type === 'tool_result') {
        const s = summarizeToolResult(b.content, b.is_error === true)
        const step = typeof b.tool_use_id === 'string' ? toolById.get(b.tool_use_id) : undefined
        if (step) step.result = s
        else steps.push({ kind: 'note', text: `A tool result: ${s.text}` })
      } else if (b.type === 'text' && String(b.text ?? '').trim()) {
        steps.push({ kind: 'note', text: String(b.text).trim() })
      }
    }
  }

  const out = Array.isArray(res.value) ? (res.value as Block[]) : []
  const answerText = textOf(out)
  const asksTools = out.some((b) => b.type === 'tool_use')
  if (answerText)
    steps.push({
      kind: 'answer',
      text: answerText,
      final: !asksTools && opts.stopReason !== 'tool_use'
    })
  for (const b of out) {
    if (b.type !== 'tool_use') continue
    steps.push({
      kind: 'tool',
      id: typeof b.id === 'string' ? b.id : null,
      name: String(b.name ?? 'tool'),
      input: flatInput(b.input),
      result: null,
      from_this_call: true
    })
  }

  return {
    earlier,
    steps,
    hidden: {
      system_chars: systemChars,
      tool_definitions: toolNames.length,
      tool_names: toolNames.filter(Boolean).slice(0, 80),
      cache_markers: countCacheMarkers(body)
    },
    cut: { request: req.cut, response: res.cut },
    unreadable: requestText != null && messages.length === 0
  }
}

/** The person's latest question in a message list (for the `question` column). */
export function questionFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown }
    if (!m || !isPersonTurn(m)) continue
    return textOf(asBlocks(m.content)).replace(/\s+/g, ' ').trim().slice(0, 500)
  }
  return ''
}

/** The person's latest question in a stored request body. */
export function questionOf(requestText: string | null): string {
  const body = parsePartialJson(requestText).value as { messages?: unknown } | null
  return questionFromMessages(body && typeof body === 'object' ? body.messages : null)
}

/** `,a,b,` — the tools a response's content blocks asked for (for the `tools` column). */
export function toolsFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const names = [
    ...new Set(
      (content as Block[])
        .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
        .map((b) => String(b.name).replace(/,/g, ''))
    )
  ]
  if (!names.length) return ''
  const s = `,${names.join(',')},`
  return s.length > 400 ? `${s.slice(0, s.lastIndexOf(',', 399))},` : s
}

/** The same, read from a stored response body. */
export function toolsOf(responseText: string | null): string {
  return toolsFromBlocks(parsePartialJson(responseText).value)
}

/** The raw bodies for "View raw": parsed where possible, masked, base64 cut out. */
export function rawView(text: string | null): {
  value: unknown
  cut: boolean
  text: string | null
} {
  if (text == null) return { value: null, cut: false, text: null }
  const p = parsePartialJson(text)
  if (p.value == null) {
    const masked = (maskBodySecrets(text) ?? '').replace(
      /"data"\s*:\s*"[A-Za-z0-9+/=]{200,}"?/g,
      '"data":"[base64 left out]"'
    )
    return { value: null, cut: p.cut, text: masked.slice(0, 60_000) }
  }
  return { value: stripBinary(maskDeep(p.value)), cut: p.cut, text: null }
}

/**
 * The tool plan a question's answer followed, read from its LAST call's
 * request (every earlier round is in it): [{tool, input, summary}] in order,
 * a failed call's summary starting `error:` (playbooks skip those).
 */
export function traceFromRequest(
  requestText: string | null
): Array<{ tool: string; input: Record<string, unknown>; summary: string }> {
  const body = parsePartialJson(requestText).value as {
    messages?: Array<{ role?: unknown; content?: unknown }>
  } | null
  const messages = body && Array.isArray(body.messages) ? body.messages : []
  let qi = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPersonTurn(messages[i])) {
      qi = i
      break
    }
  }
  const out: Array<{
    tool: string
    input: Record<string, unknown>
    summary: string
    id: string | null
  }> = []
  for (let i = qi + 1; i < messages.length; i++) {
    const m = messages[i]
    for (const b of asBlocks(m.content)) {
      if (m.role === 'assistant' && b.type === 'tool_use') {
        const input =
          b.input && typeof b.input === 'object' && !Array.isArray(b.input)
            ? (b.input as Record<string, unknown>)
            : {}
        out.push({
          tool: String(b.name ?? ''),
          input,
          summary: '',
          id: typeof b.id === 'string' ? b.id : null
        })
      } else if (b.type === 'tool_result') {
        const step = out.find((x) => x.id && x.id === b.tool_use_id)
        if (!step) continue
        const s = summarizeToolResult(b.content, b.is_error === true)
        step.summary = s.error ? `error: ${s.text}` : s.text
      }
    }
  }
  return out.filter((x) => x.tool).map(({ id: _id, ...rest }) => rest)
}
