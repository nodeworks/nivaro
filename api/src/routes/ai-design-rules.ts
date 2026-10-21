import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import {
  buildCascadePrompt,
  CASCADE_SYSTEM,
  type CascadeContext,
  cascadeSentences,
  parseCascadeAnswer
} from '../services/ai-design/cascade-writer.js'
import {
  buildFieldRulePrompt,
  FIELD_RULE_SYSTEM,
  type FieldRuleContext,
  fieldRuleSentence,
  parseFieldRuleAnswer
} from '../services/ai-design/field-rule-writer.js'
import {
  type AiComplete,
  AiUnavailableError,
  cleanText,
  defaultComplete
} from '../services/ai-design/model.js'
import {
  type FieldMeta,
  loadFieldMeta,
  loadRelations,
  m2mTargets,
  m2oTargets,
  sampleRows
} from '../services/ai-design/rule-context.js'
import {
  buildRulePrompt,
  type LockCondition,
  type PipelineMeta,
  parseRuleAnswer,
  proposalSentence,
  RULE_SYSTEM,
  type RuleContext,
  type RuleTarget,
  ruleOps,
  testLockRule,
  testStepRule,
  type VisibleWhenRule
} from '../services/ai-design/rule-writer.js'
import {
  buildSuggestions,
  buildValidationPrompt,
  computeStats,
  parseValidationAnswer,
  patternCandidates,
  SAMPLE_CAP,
  VALIDATION_SYSTEM
} from '../services/ai-design/validation-suggest.js'
import { evaluateRuleRows, type FieldRuleRow } from '../services/field-rules.js'
import { loadLayoutBundle } from '../services/layout-ops.js'
import type { LayoutBundle } from '../services/layout-ops-apply.js'
import { getLabels } from '../services/queues.js'
import { attachRecordState } from '../services/record-state.js'
import type { ValidationRule } from '../services/validation-rules.js'

/**
 * AI rule writers for the layout editor (#2673 #2674 #2675 #2680) — admin only
 * (registered inside aiDesignRoutes, which gates every route on requireAdmin).
 *
 * Every endpoint PROPOSES and never writes: rules come back as layout ops the
 * editor applies through its draft (one undo step, manual Save), picker and
 * validation config the editor saves through the field's global writer, and a
 * draft field rule the admin saves through POST /field-rules. Record values
 * are read only to TEST a proposal (counts, a five-record dry run) — as the
 * admin, through the items service and the read gate — and never reach the model.
 */

const RULE_SAMPLE = 500
const DRY_RUN = 5

type Loaded = { bundle: LayoutBundle; collection: string }

async function loadLayout(id: string, reply: FastifyReply): Promise<Loaded | null> {
  const n = Number(id)
  if (!Number.isFinite(n)) {
    reply.code(400).send({ error: 'Invalid layout id' })
    return null
  }
  const bundle = await loadLayoutBundle(db, n)
  if (!bundle) {
    reply.code(404).send({ error: 'Layout not found' })
    return null
  }
  return { bundle, collection: String(bundle.layout.collection) }
}

/** Runs the model; null after replying (503 unconfigured, 502 provider failure). */
async function ask(
  reply: FastifyReply,
  feature: 'chat' | 'generate',
  system: string,
  user: string,
  maxTokens = 1500
): Promise<string | null> {
  let complete: AiComplete | null
  try {
    complete = await defaultComplete(feature)
  } catch {
    complete = null
  }
  if (!complete) {
    reply.code(503).send({ error: new AiUnavailableError().message })
    return null
  }
  try {
    return await complete({ system, user, maxTokens })
  } catch (err) {
    reply.code(502).send({
      error: `The AI could not answer: ${(err as Error).message}`.slice(0, 400)
    })
    return null
  }
}

async function loadPipelines(collection: string): Promise<PipelineMeta[]> {
  const bindings = (await db('nivaro_workflow_bindings as b')
    .join('nivaro_workflow_templates as t', 't.id', 'b.template')
    .where('b.collection', collection)
    .select('t.id', 't.name')) as Array<{ id: string; name: string }>
  if (!bindings.length) return []
  const ids = [...new Set(bindings.map((b) => String(b.id)))]
  const states = (await db('nivaro_workflow_states')
    .whereIn('template', ids)
    .select('template', 'key', 'label')) as Array<{ template: string; key: string; label: string }>
  return ids.map((id) => ({
    id,
    name: cleanText(bindings.find((b) => String(b.id) === id)?.name, 80) ?? 'Pipeline',
    states: states
      .filter((s) => String(s.template) === id)
      .map((s) => ({ key: String(s.key), label: cleanText(s.label, 60) ?? String(s.key) }))
  }))
}

function parseList<T>(raw: unknown): T[] {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? (v as T[]) : []
}

function targetFrom(raw: unknown): RuleTarget | null {
  const o = (raw ?? {}) as Record<string, unknown>
  if (o.kind === 'step' && typeof o.group === 'string') return { kind: 'step', group: o.group }
  if (o.kind === 'lock' && typeof o.field === 'string') return { kind: 'lock', field: o.field }
  return null
}

export async function aiDesignRuleRoutes(app: FastifyInstance) {
  // ── #2673 Rule writer: words → step visible_when / field lock_conditions ──

  app.post<{ Params: { id: string }; Body: { text?: string; target?: unknown } }>(
    '/layouts/:id/rule',
    async (req, reply) => {
      const text = cleanText(req.body?.text, 500)
      if (!text) return reply.code(400).send({ error: 'Describe the rule' })
      const loaded = await loadLayout(req.params.id, reply)
      if (!loaded) return
      const { bundle, collection } = loaded
      const target = targetFrom(req.body?.target)
      const [fields, rels, pipelines, roleRows] = await Promise.all([
        loadFieldMeta(collection),
        loadRelations(collection),
        loadPipelines(collection),
        db('nivaro_roles').select('id', 'name') as Promise<Array<{ id: string; name: string }>>
      ])
      const ctx: RuleContext = {
        bundle,
        fields,
        pipelines,
        roles: roleRows.map((r) => ({ id: String(r.id), name: String(r.name) })),
        m2o: m2oTargets(collection, rels)
      }
      const answer = await ask(reply, 'chat', RULE_SYSTEM, buildRulePrompt(ctx, text, target))
      if (answer == null) return
      const parsed = parseRuleAnswer(answer, ctx, target)
      if (!parsed.proposal)
        return reply.code(422).send({ error: parsed.error, dropped: parsed.dropped })
      const planned = ruleOps(bundle, parsed.proposal)
      if (!planned.ok) return reply.code(422).send({ error: planned.error })

      // Test against the newest records, judged as the form judges them.
      const p = parsed.proposal
      let test: ReturnType<typeof testStepRule>
      let currentWords: string | null = null
      if (p.kind === 'step') {
        const group = bundle.groups.find((g) => g.key === p.group)
        const current = parseList<VisibleWhenRule>(group?.visible_when)
        const needed = [...new Set([...p.conditions, ...current].map((c) => c.field))]
        const rows = await sampleRows(req.user!, collection, needed, RULE_SAMPLE)
        test = testStepRule(p.conditions, current, rows)
        if (current.length)
          currentWords = proposalSentence(
            { kind: 'step', group: p.group, conditions: current },
            ctx
          )
      } else {
        const at = bundle.placements.find((x) => x.field === p.field)
        const current = parseList<LockCondition>(at?.lock_conditions)
        const usesState = [...p.conditions, ...current].some((c) => c.type === 'pipeline_state')
        let keys: Array<string | null> = []
        if (usesState) {
          const rows = await sampleRows(req.user!, collection, [], RULE_SAMPLE)
          await attachRecordState(collection, rows)
          keys = rows.map((r) => (r.$state as { key?: string } | null)?.key ?? null)
        }
        test = testLockRule(p.conditions, current, keys, ctx)
        if (current.length)
          currentWords = proposalSentence(
            { kind: 'lock', field: p.field, conditions: current },
            ctx
          )
      }
      return reply.send({
        data: {
          proposal: p,
          ops: planned.ops,
          sentence: proposalSentence(p, ctx),
          replaces: currentWords,
          explanation: parsed.explanation,
          dropped: parsed.dropped,
          notes: parsed.notes,
          test
        }
      })
    }
  )

  // ── #2674 Cascade writer: words → cascade_filters / option_filter ─────────

  app.post<{ Params: { id: string }; Body: { field?: string; text?: string } }>(
    '/layouts/:id/cascade',
    async (req, reply) => {
      const text = cleanText(req.body?.text, 500)
      const field = typeof req.body?.field === 'string' ? req.body.field : ''
      if (!text || !field)
        return reply.code(400).send({ error: 'Name the field and describe the filter' })
      const loaded = await loadLayout(req.params.id, reply)
      if (!loaded) return
      const { collection } = loaded
      const [fields, rels] = await Promise.all([
        loadFieldMeta(collection),
        loadRelations(collection)
      ])
      const m2o = m2oTargets(collection, rels)
      const m2m = m2mTargets(collection, rels)
      const related = m2o.get(field) ?? m2m.get(field)
      if (!related) return reply.code(400).send({ error: 'That field is not a picker' })
      const [relatedFields, relatedRels] = await Promise.all([
        loadFieldMeta(related),
        loadRelations(related)
      ])
      const label = (f: string) => fields.find((x) => x.field === f)?.label ?? f
      const ctx: CascadeContext = {
        collection,
        field,
        fieldLabel: label(field),
        related,
        fields,
        relatedFields,
        parents: [
          ...[...m2o].map(([f, t]) => ({
            field: f,
            label: label(f),
            kind: 'M2O' as const,
            target: t
          })),
          ...[...m2m].map(([f, t]) => ({
            field: f,
            label: label(f),
            kind: 'M2M' as const,
            target: t
          }))
        ].filter((p) => p.field !== field),
        relatedM2o: m2oTargets(related, relatedRels),
        relatedM2m: m2mTargets(related, relatedRels)
      }
      const answer = await ask(reply, 'chat', CASCADE_SYSTEM, buildCascadePrompt(ctx, text))
      if (answer == null) return
      const parsed = parseCascadeAnswer(answer, ctx)
      if (parsed.error)
        return reply.code(422).send({ error: parsed.error, dropped: parsed.dropped })
      return reply.send({
        data: {
          related,
          cascade_filters: parsed.cascade_filters,
          option_filter: parsed.option_filter,
          sentences: cascadeSentences(parsed, ctx),
          explanation: parsed.explanation,
          dropped: parsed.dropped
        }
      })
    }
  )

  // ── #2675 Default / field-rule writer: words → draft nivaro_field_rules row ──

  app.post<{ Params: { id: string }; Body: { text?: string; field?: string } }>(
    '/layouts/:id/field-rule',
    async (req, reply) => {
      const text = cleanText(req.body?.text, 500)
      if (!text) return reply.code(400).send({ error: 'Describe the rule' })
      const loaded = await loadLayout(req.params.id, reply)
      if (!loaded) return
      const { collection } = loaded
      const targetField = typeof req.body?.field === 'string' ? req.body.field : null
      const [fields, rels] = await Promise.all([
        loadFieldMeta(collection),
        loadRelations(collection)
      ])
      const m2o = m2oTargets(collection, rels)
      const targetCols = [...new Set(m2o.values())].slice(0, 20)
      const targetMeta = await Promise.all(targetCols.map((c) => loadFieldMeta(c)))
      const ctx: FieldRuleContext = {
        collection,
        fields,
        m2o,
        targets: new Map(targetCols.map((c, i) => [c, targetMeta[i]]))
      }
      const answer = await ask(
        reply,
        'chat',
        FIELD_RULE_SYSTEM,
        buildFieldRulePrompt(ctx, text, targetField)
      )
      if (answer == null) return
      const parsed = parseFieldRuleAnswer(answer, ctx, targetField)
      if (!parsed.rule) return reply.code(422).send({ error: parsed.error })
      const rule = parsed.rule

      // Dry run on the newest records that have the trigger, with the engine stored rules use.
      const rows = await sampleRows(
        req.user!,
        collection,
        [rule.trigger_field, rule.target_field],
        DRY_RUN,
        rule.trigger_op === 'null' ? {} : { filter: { [rule.trigger_field]: { _nnull: true } } }
      )
      const row: FieldRuleRow = {
        id: 0,
        ...rule,
        dynamic_config: rule.dynamic_config ? JSON.stringify(rule.dynamic_config) : null,
        sort: 0,
        is_active: true
      }
      const flat = (v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v) ? ((v as { id?: unknown }).id ?? null) : v
      const runs = await Promise.all(
        rows.map(async (r) => {
          const draft: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(r)) draft[k] = flat(v)
          const trig = draft[rule.trigger_field]
          const now = await evaluateRuleRows(
            db,
            collection,
            rule.trigger_field,
            trig,
            draft,
            [row],
            req.log
          )
          const fresh = await evaluateRuleRows(
            db,
            collection,
            rule.trigger_field,
            trig,
            { ...draft, [rule.target_field]: null },
            [row],
            req.log
          )
          const before = draft[rule.target_field] ?? null
          return {
            id: String(r.id),
            before,
            after: rule.target_field in now ? (now[rule.target_field] ?? null) : before,
            new_record: rule.target_field in fresh ? (fresh[rule.target_field] ?? null) : null
          }
        })
      )
      // Labels: the records themselves, and record values of a picker target.
      const wanted = new Map<string, Set<string>>([[collection, new Set(runs.map((r) => r.id))]])
      const targetRel = m2o.get(rule.target_field)
      if (targetRel) {
        const ids = new Set<string>()
        for (const r of runs)
          for (const v of [r.before, r.after, r.new_record])
            if (v != null && v !== '') ids.add(String(v))
        if (ids.size) wanted.set(targetRel, ids)
      }
      let labels: Record<string, string> = {}
      try {
        labels = await getLabels(wanted)
      } catch {
        labels = {}
      }
      const valueLabel = (v: unknown) =>
        v == null || v === ''
          ? null
          : targetRel
            ? (labels[`${targetRel}:${v}`] ?? String(v))
            : String(v)
      return reply.send({
        data: {
          rule,
          sentence: fieldRuleSentence(rule, ctx),
          explanation: parsed.explanation,
          dry_run: runs.map((r) => ({
            ...r,
            label: labels[`${collection}:${r.id}`] ?? `#${r.id}`,
            before_label: valueLabel(r.before),
            after_label: valueLabel(r.after),
            new_record_label: valueLabel(r.new_record)
          }))
        }
      })
    }
  )

  // ── #2680 Validation suggestions: value shapes → checks + fail counts ─────

  app.post<{ Params: { id: string }; Body: { field?: string; ai?: boolean } }>(
    '/layouts/:id/validation',
    async (req, reply) => {
      const field = typeof req.body?.field === 'string' ? req.body.field : ''
      if (!field) return reply.code(400).send({ error: 'Name the field' })
      const loaded = await loadLayout(req.params.id, reply)
      if (!loaded) return
      const { collection } = loaded
      const meta: FieldMeta | undefined = (await loadFieldMeta(collection)).find(
        (f) => f.field === field
      )
      if (!meta || meta.type === 'alias')
        return reply.code(400).send({ error: 'That field holds no values to learn from' })
      const stored = (await db('nivaro_fields')
        .where({ collection, field })
        .first('validation_rules')) as { validation_rules?: unknown } | undefined
      const current = parseList<ValidationRule>(stored?.validation_rules).filter(
        (r) => r && typeof r === 'object' && typeof r.type === 'string'
      )

      const rows = await sampleRows(req.user!, collection, [field], SAMPLE_CAP)
      const values = rows.map((r) => r[field])
      const stats = computeStats(values, meta.type)
      const candidates = patternCandidates(stats)

      let aiRules: ValidationRule[] = []
      let aiConfigured = false
      let aiError: string | null = null
      if (req.body?.ai !== false && stats.checked - stats.empty >= 5) {
        const complete = await defaultComplete('generate').catch(() => null)
        aiConfigured = !!complete
        if (complete) {
          try {
            const answer = await complete({
              system: VALIDATION_SYSTEM,
              user: buildValidationPrompt(meta, stats, candidates, current),
              maxTokens: 1200
            })
            aiRules = parseValidationAnswer(answer).rules
          } catch (err) {
            aiError = `The AI could not answer: ${(err as Error).message}`.slice(0, 300)
          }
        }
      }
      return reply.send({
        data: {
          field,
          label: meta.label,
          kind: stats.kind,
          checked: stats.checked,
          empty: stats.empty,
          capped: stats.checked >= SAMPLE_CAP,
          current,
          suggestions: buildSuggestions(
            candidates,
            aiRules,
            current,
            values,
            meta.label,
            stats.kind
          ),
          ai_configured: aiConfigured,
          ai_error: aiError
        }
      })
    }
  )
}
