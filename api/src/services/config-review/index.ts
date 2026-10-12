import { db } from '../../db/index.js'
import { type PhrasingDeps, phraseFindings } from './ai-phrasing.js'
import { type CleanupOptions, cleanupFindings, labelFindings, reviewFindings } from './checks.js'
import {
  decodeDetail,
  encodeDetail,
  FIXED_KEEP_DAYS,
  type ReviewFamily,
  type ReviewFinding
} from './pure.js'

/**
 * Config review (#1913), cleanup suggestions (#2020) and the label check
 * (#1999): one run, three families stored beside the nightly config-health
 * findings in nivaro_config_health (families 'review' | 'cleanup' | 'label';
 * `detail` holds a JSON ReviewDetail). Upserted per (family, code, subject):
 * a dismissed finding stays dismissed while it keeps matching, a finding that
 * stops matching is deleted so a recurrence starts fresh — except a FIXED one
 * (status 'fixed', #1961), which stays listed with its undo for
 * FIXED_KEEP_DAYS. A fixed finding that matches again (a cleanup worked in
 * rounds, or someone put the problem back) reopens and keeps its fix history.
 */

export const REVIEW_FAMILIES: ReviewFamily[] = ['review', 'cleanup', 'label']

export interface RunOptions extends CleanupOptions {
  /** Ask the model to re-word reasons and propose labels. */
  ai?: boolean
  aiDeps?: PhrasingDeps
}

export interface RunOutcome {
  counts: Record<ReviewFamily, number>
  resolved: number
  ai: { asked: boolean; phrased: number; note?: string }
  summary: string
}

export async function collectFindings(opts: RunOptions = {}): Promise<ReviewFinding[]> {
  const [review, cleanup, labels] = await Promise.all([
    reviewFindings(),
    cleanupFindings(opts),
    labelFindings()
  ])
  return [...review, ...cleanup, ...labels]
}

const keyOf = (f: { family: string; code: string; subject: string }) =>
  `${f.family}|${f.code}|${f.subject}`

export async function runConfigReview(opts: RunOptions = {}): Promise<RunOutcome> {
  const findings = await collectFindings(opts)

  const existing = (await db('nivaro_config_health')
    .whereIn('family', REVIEW_FAMILIES)
    .select('id', 'family', 'code', 'subject', 'detail', 'status')) as Array<{
    id: number
    family: string
    code: string
    subject: string
    detail: string | null
    status: string
  }>
  const existingByKey = new Map(existing.map((r) => [keyOf(r), r]))

  // Carry an earlier model phrasing forward while the facts it described are
  // unchanged — a monthly run without AI should not erase last month's words.
  for (const f of findings) {
    const prev = existingByKey.get(keyOf(f))
    if (!prev) continue
    const d = decodeDetail(prev.detail)
    if (d.applied?.length) f.detail.applied = d.applied
    if (d.ai_reason && d.reason === f.detail.reason) f.detail.ai_reason = d.ai_reason
    const prevLabel = d.data?.ai_label
    if (typeof prevLabel === 'string' && f.detail.data && !f.detail.data.ai_label) {
      f.detail.data.ai_label = prevLabel
    }
  }

  let phrased = 0
  let aiNote: string | undefined
  if (opts.ai) {
    const res = await phraseFindings(findings, opts.aiDeps)
    aiNote = res.note
    for (const f of findings) {
      const p = res.byKey.get(keyOf(f))
      if (!p) continue
      phrased++
      if (p.reason) f.detail.ai_reason = p.reason
      if (p.label && f.family === 'label')
        f.detail.data = { ...(f.detail.data ?? {}), ai_label: p.label }
    }
  }

  const now = new Date()
  const seen = new Set<string>()
  for (const f of findings) {
    const key = keyOf(f)
    if (seen.has(key)) continue
    seen.add(key)
    const row = {
      title: f.title.slice(0, 400),
      detail: encodeDetail(f.detail),
      severity: f.severity,
      href: f.href ? f.href.slice(0, 400) : null,
      last_seen: now
    }
    const prev = existingByKey.get(key)
    if (prev) {
      await db('nivaro_config_health')
        .where('id', prev.id)
        .update(prev.status === 'fixed' ? { ...row, status: 'open' } : row)
    } else {
      await db('nivaro_config_health').insert({
        ...row,
        family: f.family,
        code: f.code,
        subject: f.subject.slice(0, 300),
        status: 'open',
        first_seen: now
      })
    }
  }
  const fixedCutoff = Date.now() - FIXED_KEEP_DAYS * 86_400_000
  const keepFixed = (r: (typeof existing)[number]) => {
    if (r.status !== 'fixed') return false
    const at = Date.parse(decodeDetail(r.detail).applied?.[0]?.at ?? '')
    return Number.isFinite(at) && at > fixedCutoff
  }
  const gone = existing.filter((r) => !seen.has(keyOf(r)) && !keepFixed(r)).map((r) => r.id)
  for (let i = 0; i < gone.length; i += 500) {
    await db('nivaro_config_health')
      .whereIn('id', gone.slice(i, i + 500))
      .del()
  }

  const counts: Record<ReviewFamily, number> = { review: 0, cleanup: 0, label: 0 }
  for (const f of findings) counts[f.family as ReviewFamily]++
  const summary = `${counts.review} review, ${counts.cleanup} cleanup, ${counts.label} label finding(s); ${gone.length} resolved${opts.ai ? `; AI phrased ${phrased}` : ''}`
  return {
    counts,
    resolved: gone.length,
    ai: { asked: !!opts.ai, phrased, note: aiNote },
    summary
  }
}

/** The monthly cron: run with AI phrasing, then tell the administrators. */
export async function runMonthlyConfigReview(): Promise<string> {
  const outcome = await runConfigReview({ ai: true })
  const total = outcome.counts.review + outcome.counts.cleanup + outcome.counts.label
  if (total === 0) return outcome.summary
  try {
    const { getApp } = await import('../io-holder.js')
    const { notifyUser } = await import('../notification-channels.js')
    const app = getApp()
    if (!app) return outcome.summary
    const admins = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .limit(10)
      .select('u.id')) as Array<{ id: string }>
    for (const a of admins) {
      await notifyUser(app, a.id, {
        subject: 'Monthly config review is ready',
        message: `${outcome.counts.review} configuration finding(s), ${outcome.counts.cleanup} cleanup suggestion(s) and ${outcome.counts.label} label inconsistency(ies).`,
        category: 'system',
        target: { kind: 'external', url: '/config-review', action: 'review' },
        source: { kind: 'config_review', label: 'Monthly config review' },
        why: 'You are an administrator; the config review runs on the first of each month.'
      })
    }
  } catch {
    /* the report is stored either way */
  }
  return outcome.summary
}
