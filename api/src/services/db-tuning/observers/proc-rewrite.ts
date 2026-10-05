import { db } from '../../../db/index.js'
import { capturedPlanFor } from '../../custom-query-plans.js'
import { isReplicatedProcedure } from '../../replication.js'
import { type ProcStat, procedureBody, procedureStats } from '../dmv.js'
import { paramSetsFor } from '../param-sets.js'
import { applyTransformers } from '../rewrites/index.js'
import { bodyHash, isTwinName, provability } from '../twin.js'
import { type Candidate, IDENT, KIND_RISK } from '../types.js'

/**
 * Procedure-rewrite observer: slow, frequent procedures whose bodies the twin harness can prove
 * (read-only, no dynamic SQL, no remote calls) and that have recorded parameter sets to replay.
 * Selection is pure; the rewrite itself (mechanical transformers, else the AI candidate) is
 * handed in by the orchestrator, which also proves it before anything is proposed.
 */

export interface ProcEvidence {
  stats: ProcStat[]
  bodies: Map<string, string>
  paramSets: Map<string, Array<Record<string, unknown>>>
  planOps: Map<string, string[]>
  /** Lower-cased names of procedures published by replication. */
  replicated: Set<string>
}

export interface ProcSelection {
  proc: string
  body: string
  stat: ProcStat
  paramSets: Array<Record<string, unknown>>
  planOps: string[]
  replicated: boolean
}

export const MIN_AVG_MS = 2000
export const MIN_RUNS_PER_WEEK = 20
const MAX_PLAN_OPS = 20
const MAX_PARAM_SETS = 10

/** The temp-table guard is for query wrapper SQL: inside a callee it drops the caller's #t. */
const PROC_EXCLUDED_TRANSFORMERS = ['temp-table-guard']

export function selectProcCandidates(ev: ProcEvidence): ProcSelection[] {
  const out: ProcSelection[] = []
  for (const s of ev.stats) {
    if (isTwinName(s.name)) continue
    const perWeek = (s.execution_count / s.cached_days) * 7
    if (s.avg_elapsed_ms < MIN_AVG_MS || perWeek < MIN_RUNS_PER_WEEK) continue
    const body = ev.bodies.get(s.name)
    if (!body) continue
    if (provability(s.name, body)) continue
    const sets = ev.paramSets.get(s.name) ?? []
    if (!sets.length) continue
    out.push({
      proc: s.name,
      body,
      stat: s,
      paramSets: sets,
      planOps: ev.planOps.get(s.name) ?? [],
      replicated: ev.replicated.has(s.name.toLowerCase())
    })
  }
  return out.sort((a, b) => b.stat.total_elapsed_ms - a.stat.total_elapsed_ms)
}

/** The mechanical rewrite of a stored-procedure body, or null when no transformer applies. */
export function mechanicalProcRewrite(
  body: string
): { body: string; notes: string[]; applied: string[] } | null {
  return applyTransformers(body, { exclude: PROC_EXCLUDED_TRANSFORMERS })
}

/**
 * An AI attempt is keyed by the body it rewrites, not by what the model answered (a different
 * body every night): one attempt per live body, so a rejected attempt stays quiet instead of
 * minting a new fingerprint each run. A mechanical rewrite is keyed by its (stable) new body.
 */
export const aiChangeKey = (oldBody: string): string => `ai:${bodyHash(oldBody)}`

export function buildProcCandidate(
  sel: ProcSelection,
  rewritten: { body: string; notes: string[]; applied: string[] }
): Candidate {
  const perDay = sel.stat.execution_count / sel.stat.cached_days
  const hash = bodyHash(rewritten.body)
  return {
    kind: 'proc_rewrite',
    target: sel.proc,
    change_key: rewritten.applied.includes('ai') ? aiChangeKey(sel.body) : hash,
    title: `Rewrite ${sel.proc} — ${(sel.stat.avg_elapsed_ms / 1000).toFixed(1)} s avg over ${Math.round(perDay)} runs/day`,
    // The prior body lives in `undo`, not here.
    evidence: {
      avg_elapsed_ms: Math.round(sel.stat.avg_elapsed_ms),
      runs_per_day: Math.round(perDay),
      parameter_sets: sel.paramSets.length,
      // the masked recorded sets the proof replays — a re-prove uses exactly these
      parameter_set_values: sel.paramSets,
      plan_ops: sel.planOps.slice(0, MAX_PLAN_OPS),
      rewrite_notes: rewritten.notes,
      transformers: rewritten.applied
    },
    // the proof's minimum gain; replaced by the measured one after proving
    estimate_ms_per_day: Math.round(perDay * sel.stat.avg_elapsed_ms * 0.25),
    risk: KIND_RISK.proc_rewrite,
    apply: { type: 'proc_body', proc: sel.proc, body: rewritten.body, hash },
    undo: { type: 'proc_body', proc: sel.proc, body: sel.body, hash: bodyHash(sel.body) },
    replicated: sel.replicated
  }
}

export async function loadProcEvidence(): Promise<ProcEvidence> {
  // catalog names only: anything outside IDENT is never read, matched or proposed
  const stats = (await procedureStats()).filter(
    (s) => s.avg_elapsed_ms >= MIN_AVG_MS && IDENT.test(s.name) && !isTwinName(s.name)
  )
  const bodies = new Map<string, string>()
  const paramSets = new Map<string, Array<Record<string, unknown>>>()
  const planOps = new Map<string, string[]>()
  const replicated = new Set<string>()
  const queries = (await db('nivaro_custom_queries')
    .select('id', 'slug', 'sql_text')
    .catch(() => [])) as Array<{ id: number; slug: string; sql_text: string | null }>
  for (const s of stats) {
    const body = await procedureBody(s.name)
    if (body) bodies.set(s.name, body)
    const own = await paramSetsFor('proc', s.name)
    // a wrapping query's recorded sets reach the proc it EXECs
    const exec = new RegExp(String.raw`\bEXEC(UTE)?\s+(\[?dbo\]?\.)?\[?${s.name}\]?(?![\w])`, 'i')
    const wrappers = queries.filter((q) => exec.test(q.sql_text ?? ''))
    const viaQuery = (await Promise.all(wrappers.map((q) => paramSetsFor('query', q.slug)))).flat()
    const sets = [...own, ...viaQuery].slice(0, MAX_PARAM_SETS)
    if (sets.length) paramSets.set(s.name, sets)
    const ops = wrappers
      .flatMap((q) => capturedPlanFor(Number(q.id))?.plan.operators ?? [])
      .sort((a, b) => b.cost - a.cost)
      .slice(0, MAX_PLAN_OPS)
      .map((o) => `${o.op} · ${o.object ?? '-'} · ${o.cost.toFixed(2)}`)
    if (ops.length) planOps.set(s.name, ops)
    if (await isReplicatedProcedure(s.name)) replicated.add(s.name.toLowerCase())
  }
  return { stats, bodies, paramSets, planOps, replicated }
}
