import type { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import type { LayoutBundle } from '../../../lib/layout-ops'
import type { ComposedForm, MeaningSuggestion, PipelineStateRef, SlimPlan } from './plan'

/**
 * Calls for AI form building (#2668-#2672), all admin-only under
 * /ai-design/layouts. They PROPOSE; the editor applies through its draft.
 */

type Client = ReturnType<typeof useNivaroClient>

export type ComposeMode = 'describe' | 'picture' | 'sop'

export interface ComposeResult {
  form: ComposedForm
  /** How the server read the upload (image, pdf, pdftotext, sheet, …). */
  read_as?: string
  /** SOP: the states of pipelines bound to the collection. */
  states?: PipelineStateRef[]
}

export interface SlimResult {
  role: { id: string; name: string }
  parent: { id: number; name: string }
  days: number
  revisions: number
  people: number
  /** null: too little history for this role to judge. */
  plan: SlimPlan | null
  name?: string
}

/** Pictures, PDFs and the documents document autofill reads. */
export const COMPOSE_ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.xlsx,.xls,.xlsm,.csv,.txt,.md,.eml,.html,.htm'
export const COMPOSE_MAX_BYTES = 10 * 1024 * 1024

export async function composeFromText(
  client: Client,
  collection: string,
  text: string
): Promise<ComposeResult> {
  const res = await client.request<{ data: ComposeResult }>(
    post('/ai-design/layouts/compose', { collection, text })
  )
  return res.data
}

/** multipart, like the Ask AI attachments: the client has no multipart command. */
export async function composeFromFile(
  client: Client,
  input: { collection: string; mode: 'picture' | 'sop'; file: File; note?: string }
): Promise<ComposeResult> {
  const form = new FormData()
  form.append('collection', input.collection)
  form.append('mode', input.mode)
  if (input.note?.trim()) form.append('note', input.note.trim())
  form.append('file', input.file, input.file.name)
  const token = client.getToken()
  const res = await fetch(`${client.url}/api/ai-design/layouts/compose/file`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: token ? 'omit' : 'include',
    body: form
  })
  const json = (await res.json().catch(() => ({}))) as { data?: ComposeResult; error?: string }
  if (!res.ok || !json.data)
    // Shaped like a client error so apiFailure() reads the status and message.
    throw Object.assign(new Error(json.error || 'The AI could not read the file'), {
      status: res.status,
      response: { status: res.status, data: { error: json.error } }
    })
  return json.data
}

export async function fetchSlim(
  client: Client,
  layoutId: number,
  roleId: string
): Promise<SlimResult> {
  const res = await client.request<{ data: SlimResult }>(
    post(`/ai-design/layouts/${layoutId}/slim`, { role_id: roleId })
  )
  return res.data
}

export async function fetchMeaning(
  client: Client,
  layoutId: number,
  body: { groups: Array<{ key: string; label: string; fields: string[] }>; fields: string[] }
): Promise<{ suggestions: MeaningSuggestion[]; dropped: number }> {
  const res = await client.request<{
    data: { suggestions: MeaningSuggestion[]; dropped: number }
  }>(post(`/ai-design/layouts/${layoutId}/sections-by-meaning`, body))
  return res.data
}

/** A new, empty form of the collection: what a composed form is previewed against. */
export function emptyBundle(collection: string): LayoutBundle {
  return {
    layout: { id: 0, collection, name: '', layout_type: 'grouped' },
    groups: [],
    placements: [],
    rev: ''
  }
}
