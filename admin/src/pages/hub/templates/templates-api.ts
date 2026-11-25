import { describeError, type ErrorDescription, errorToastOptions } from '@nivaro/shared'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { hubError } from '../hub-api'

/**
 * Nivaro Hub app templates (enhancement 24): the template library (/api/hub/templates). An
 * administrator uploads an App Blueprint export (Promotion → Blueprints: Export or Publish in any
 * app) with a name, description and version; Create app offers the non-archived ones and the
 * creation's last step installs the picked one into each new environment.
 */

export interface TemplateManifest {
  name: string
  description: string | null
  version: string | null
  exported_at: string
  nivaro_version: string
  collections: string[]
  counts: {
    collections: number
    fields: number
    relations: number
    workflows: number
    layouts: number
    queues: number
    rules: number
  }
}

export interface HubTemplate {
  id: number
  name: string
  version: string
  description: string | null
  digest: string
  size_bytes: number
  manifest: TemplateManifest | null
  archived: boolean
  archived_at: string | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
  /** Environments a creation installed (or is installing) it into. */
  used: number
}

export const templateKeys = {
  all: () => ['hub', 'templates'] as const,
  list: (archived: boolean) => ['hub', 'templates', 'list', archived ? 'all' : 'live'] as const
}

export async function fetchTemplates(archived = false): Promise<HubTemplate[]> {
  const res = await api.get<{ data: HubTemplate[] }>('/hub/templates', {
    params: archived ? { archived: 1 } : {}
  })
  return res.data.data
}

export async function uploadTemplate(body: {
  bundle: unknown
  name?: string
  description?: string
  version?: string
}): Promise<HubTemplate> {
  const res = await api.post<{ data: HubTemplate }>('/hub/templates', body)
  return res.data.data
}

export async function patchTemplate(
  id: number,
  patch: { name?: string; description?: string | null; archived?: boolean }
): Promise<HubTemplate> {
  const res = await api.patch<{ data: HubTemplate }>(`/hub/templates/${id}`, patch)
  return res.data.data
}

export async function deleteTemplate(id: number): Promise<void> {
  await api.delete(`/hub/templates/${id}`)
}

/** The stored package as a file (to install it by hand from Promotion → Blueprints). */
export async function downloadTemplate(t: HubTemplate): Promise<void> {
  const res = await api.get(`/hub/templates/${t.id}/bundle`, { responseType: 'blob' })
  const url = URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${t.name}-${t.version}`.replace(/[^A-Za-z0-9._-]+/g, '-') + '.blueprint.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Every refusal the template routes answer, in plain words. */
export const TEMPLATE_COPY: Record<string, { title: string; hint?: string; detail?: boolean }> = {
  BAD_BUNDLE: {
    title: 'That is not an App Blueprint',
    hint: 'Export one from an app: Promotion → Blueprints → Export or Publish.'
  },
  EMPTY_BUNDLE: {
    title: 'The blueprint brings no collections',
    hint: 'Export it again with collections picked.'
  },
  BAD_NAME: { title: 'Give the template a name' },
  BAD_VERSION: {
    title: 'That is not a version',
    hint: 'Use letters, digits, dots or dashes, like 1.2.0.'
  },
  BAD_ARCHIVED: { title: 'Archive could not be changed' },
  TOO_LARGE: { title: 'The blueprint is too large', hint: 'A template is at most 16 MB.' },
  TEMPLATE_EXISTS: { title: 'This name and version are in the library already', detail: true },
  TEMPLATE_IN_USE: {
    title: 'A creation used this template',
    hint: 'Archive it instead: it then leaves Create app but its history stays.'
  },
  TEMPLATE_UNREADABLE: { title: 'The stored template cannot be read', hint: 'Upload it again.' }
}

export function templateError(err: unknown, fallback: string): ErrorDescription {
  const d = describeError(err, fallback)
  const copy = d.code ? TEMPLATE_COPY[d.code] : undefined
  if (!copy) return hubError(err, fallback)
  const out: ErrorDescription = { ...d, title: copy.title }
  const said = d.title !== fallback && d.title !== copy.title ? d.title : undefined
  const hint = copy.detail ? (said ?? copy.hint) : copy.hint
  if (hint) out.hint = hint
  else delete out.hint
  return out
}

export function templateToast(err: unknown, fallback: string) {
  const d = templateError(err, fallback)
  toast.error(d.title, errorToastOptions(d))
}

/** Pure: the counts line shown on a template card (parts that are zero are left out). */
export function countsLine(m: TemplateManifest | null): string {
  if (!m) return ''
  const c = m.counts
  const part = (n: number, one: string, many: string) =>
    n > 0 ? `${n} ${n === 1 ? one : many}` : ''
  return [
    `${c.collections} ${c.collections === 1 ? 'collection' : 'collections'}`,
    part(c.workflows, 'workflow', 'workflows'),
    part(c.layouts, 'layout', 'layouts'),
    part(c.queues, 'queue', 'queues'),
    part(c.rules, 'rule', 'rules')
  ]
    .filter(Boolean)
    .join(' · ')
}
