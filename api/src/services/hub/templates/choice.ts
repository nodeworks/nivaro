// Hub app templates (Hub enhancement 24): the template a creation installs. Create app sends
// `template_id` beside the rest of CreateAppInput; the preview shows it (templatePlanNotes, added
// to the creation plan by the route), startCreation records one install row per new environment
// inside its own transaction (recordTemplateChoices), and the creation's last step
// (create/template-step.ts) installs it over the hub link after the first administrator exists.
import type { Knex } from 'knex'
import { db } from '../../../db/index.js'
import { compareVersions } from '../promote-plan.js'
import { readTemplate, TEMPLATE_INSTALLS, TemplateError } from './library.js'

/** The first Nivaro version whose hub link takes a template (POST /api/hub-link/template). */
export const TEMPLATE_MIN_VERSION = '0.3.215'

export type TemplateInstallStatus = 'pending' | 'installing' | 'done' | 'failed'

export interface TemplateInstallRow {
  id: number
  app_id: number
  environment_id: number
  template_id: number
  status: TemplateInstallStatus
  note: string | null
  report: Record<string, unknown> | null
  finished_at: string | null
}

/** A template id as sent: null when none was picked, NaN-safe. */
export function templateIdOf(input: unknown): number | null {
  const v = (input as { template_id?: unknown } | null)?.template_id
  if (v === undefined || v === null || v === '' || v === 0) return null
  const n = typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : -1
}

export interface TemplatePlanNotes {
  blockers: Array<{ code: string; text: string }>
  lines: string[]
  warnings: string[]
}

/**
 * What the creation preview says about the picked template: it must exist and not be archived,
 * and the version the app is created at must be one whose hub link takes a template.
 */
export async function templatePlanNotes(input: unknown): Promise<TemplatePlanNotes> {
  const out: TemplatePlanNotes = { blockers: [], lines: [], warnings: [] }
  const id = templateIdOf(input)
  if (id === null) return out
  const t = id > 0 ? await readTemplate(id) : null
  if (!t || t.archived) {
    out.blockers.push({
      code: 'TEMPLATE_UNKNOWN',
      text: 'The picked template is not in the library (or was archived); pick another or none.'
    })
    return out
  }
  const version = String((input as { version?: unknown }).version ?? '').trim()
  if (/^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, TEMPLATE_MIN_VERSION) < 0)
    out.blockers.push({
      code: 'TEMPLATE_APP_TOO_OLD',
      text: `Templates install into apps on ${TEMPLATE_MIN_VERSION} or later; this app would run ${version}.`
    })
  const c = t.manifest?.counts
  out.lines.push(
    `Install the template ${t.name} ${t.version} into every environment after its first administrator${
      c ? ` (${c.collections} collections, ${c.workflows} workflows, ${c.queues} queues)` : ''
    }.`
  )
  const made = t.manifest?.nivaro_version
  if (
    made &&
    /^\d+\.\d+\.\d+$/.test(made) &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    compareVersions(made, version) > 0
  )
    out.warnings.push(
      `The template was exported from Nivaro ${made}, newer than ${version}: settings that version does not know are skipped.`
    )
  return out
}

/** Adds the template notes to a creation plan (the route answers the result). */
export function withTemplateNotes<
  P extends { ok: boolean; blockers: unknown[]; lines: string[]; warnings?: string[] }
>(plan: P, notes: TemplatePlanNotes): P {
  if (!notes.blockers.length && !notes.lines.length && !notes.warnings.length) return plan
  return {
    ...plan,
    ok: plan.ok && notes.blockers.length === 0,
    blockers: [...plan.blockers, ...notes.blockers],
    lines: [...plan.lines, ...notes.lines],
    warnings: [...(plan.warnings ?? []), ...notes.warnings]
  }
}

/**
 * Inside startCreation's transaction: one pending install row per new environment of the app
 * when a template was picked (none picked: nothing). The template is judged again here (an
 * archive between the preview and Create refuses the whole creation).
 */
export async function recordTemplateChoices(
  trx: Knex | Knex.Transaction,
  o: { input: unknown; appId: number; envIds: number[]; by: string | null }
): Promise<void> {
  const id = templateIdOf(o.input)
  if (id === null) return
  const t = id > 0 ? await readTemplate(id, trx) : null
  if (!t || t.archived)
    throw new TemplateError(
      'TEMPLATE_UNKNOWN',
      'The picked template is not in the library (or was archived).',
      409
    )
  const now = new Date()
  for (const envId of o.envIds)
    await trx(TEMPLATE_INSTALLS).insert({
      app_id: o.appId,
      environment_id: envId,
      template_id: id,
      status: 'pending',
      created_by: o.by || null,
      created_at: now,
      updated_at: now
    })
}

function parseReport(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === 'object') return v as Record<string, unknown>
  try {
    return JSON.parse(String(v)) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function readTemplateInstall(envId: number): Promise<TemplateInstallRow | null> {
  const r = (await db(TEMPLATE_INSTALLS).where({ environment_id: envId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    template_id: Number(r.template_id),
    status: String(r.status) as TemplateInstallStatus,
    note: r.note == null ? null : String(r.note),
    report: parseReport(r.report),
    finished_at:
      r.finished_at == null ? null : new Date(r.finished_at as string | Date).toISOString()
  }
}

export async function setTemplateInstall(
  envId: number,
  patch: {
    status: TemplateInstallStatus
    note?: string | null
    report?: Record<string, unknown> | null
  }
): Promise<void> {
  const out: Record<string, unknown> = { status: patch.status, updated_at: new Date() }
  if (patch.note !== undefined) out.note = patch.note ? patch.note.slice(0, 500) : null
  if (patch.report !== undefined) out.report = patch.report ? JSON.stringify(patch.report) : null
  if (patch.status === 'done' || patch.status === 'failed') out.finished_at = new Date()
  await db(TEMPLATE_INSTALLS).where({ environment_id: envId }).update(out)
}
