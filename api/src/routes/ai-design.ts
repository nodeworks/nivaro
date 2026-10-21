import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import { describeAiProvider } from '../services/ai-client.js'
import { CORRECTED_SHARE, MIN_PROPOSED } from '../services/ai-design/autofill-tuning.js'
import {
  applyHelpText,
  draftHelpText,
  HELP_MAX,
  helpTextCandidates
} from '../services/ai-design/help-text.js'
import {
  labelLookup,
  loadCorrectedFields,
  loadFieldMeta,
  loadRoleAccess
} from '../services/ai-design/layout-ai-load.js'
import {
  buildCommandPrompt,
  COMMAND_SYSTEM,
  type CommandContext,
  parseCommandAnswer
} from '../services/ai-design/layout-command.js'
import {
  executeLayoutFix,
  loadLayoutModel,
  planLayoutFix,
  reviewLayout
} from '../services/ai-design/layout-review.js'
import { attachSplitChangeSets, splitCandidates } from '../services/ai-design/layout-split.js'
import {
  AiUnavailableError,
  cleanText,
  defaultComplete,
  titleCase
} from '../services/ai-design/model.js'
import {
  buildPersonaPrompt,
  buildWalkthrough,
  PERSONA_SYSTEM,
  parsePersonaAnswer,
  walkthroughRuleFindings
} from '../services/ai-design/persona-test.js'
import {
  applyRoleProposal,
  countReadImpact,
  designRole,
  loadRoleCatalog,
  normalizeRoleProposal,
  proposalHash,
  simulateRoleProposal
} from '../services/ai-design/role-design.js'
import { DEFAULT_DAYS, suggestRoleViews } from '../services/ai-design/role-views.js'
import {
  buildCritiquePrompt,
  CRITIQUE_SYSTEM,
  cleanGeometry,
  critiqueRuleComments,
  critiqueSections,
  imageFromDataUri,
  parseCritiqueAnswer
} from '../services/ai-design/visual-critique.js'
import { clearMetadataCache } from '../services/collections.js'
import { loadLayoutBundle } from '../services/layout-ops.js'
import { meaningPass, registerLayoutAssistRoutes } from './ai-design-assist.js'
import { aiDesignFormRoutes } from './ai-design-forms.js'
import { aiDesignRuleRoutes } from './ai-design-rules.js'

/**
 * AI design helpers (#1920 #1964 #1912 #2010 #1965) — admin only.
 *
 * Every endpoint PROPOSES; the writes are separate calls an admin makes per
 * suggestion, each logged and each reversible (layout fixes via the layout's
 * version history, help text via the activity entry holding the old text,
 * roles and views by deleting what was created).
 */

type UiRoute = { path: string; label: string }

function uiRoutesFrom(v: unknown): UiRoute[] {
  if (!Array.isArray(v)) return []
  const out: UiRoute[] = []
  for (const r of v.slice(0, 400)) {
    const o = r as { path?: unknown; label?: unknown }
    if (typeof o?.path !== 'string' || !/^\/[A-Za-z0-9/_:-]{0,120}$/.test(o.path)) continue
    out.push({ path: o.path, label: cleanText(o.label, 80) ?? o.path })
  }
  return out
}

export async function aiDesignRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  app.addHook('preHandler', resolveWorkspace)
  // AI rule writers (#2673 #2674 #2675 #2680) — same admin gate.
  await aiDesignRuleRoutes(app)

  // Layout editor AI assists (#2684 #2688 #2689): proposals only, see ai-design-assist.ts.
  registerLayoutAssistRoutes(app)

  // AI form building (#2668-#2672): compose, slim version, sections by meaning.
  await app.register(aiDesignFormRoutes)

  // ── Layout review (#1920) + apply (#1964) ──────────────────────────────────

  app.post<{ Params: { id: string }; Body: { ai?: boolean } }>(
    '/layouts/:id/review',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const model = await loadLayoutModel(id)
      if (!model) return reply.code(404).send({ error: 'Layout not found' })
      const complete = await defaultComplete()
      // Crowded steps / sections also get a split change set (#2587), built on the
      // bundle the editor edits; the model, when asked, names and groups the parts.
      const bundle = await loadLayoutBundle(db, id)
      // Help text vs behaviour + same-meaning fields (#2686 #2687) ride beside it.
      const [{ splits, ...result }, meaning] = await Promise.all([
        reviewLayout(model, req.body?.ai === false ? null : complete, (findings) =>
          splitCandidates(findings, bundle)
        ),
        meaningPass(bundle, !!complete && req.body?.ai !== false)
      ])
      const labels = new Map(model.fields.map((f) => [f.field, f.label]))
      const findings = [
        ...attachSplitChangeSets(result.findings, bundle, (f) => labels.get(f) ?? f, splits),
        ...meaning.findings
      ]
      return reply.send({
        data: {
          layout: model.layout,
          ...result,
          ai_error: result.ai_error ?? meaning.error,
          findings,
          ai_configured: !!complete
        }
      })
    }
  )

  app.post<{ Params: { id: string }; Body: { fix?: unknown } }>(
    '/layouts/:id/apply',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const model = await loadLayoutModel(id)
      if (!model) return reply.code(404).send({ error: 'Layout not found' })
      const plan = planLayoutFix(model, req.body?.fix)
      if (!plan.ok) return reply.code(409).send({ error: plan.error })
      const { undo_version_id } = await executeLayoutFix(id, plan, req.user?.id ?? null)
      await logActivity({
        action: 'ai-layout-fix',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: String(id),
        comment: `AI suggestion applied: ${plan.description}`,
        req
      })
      return reply.send({ data: { applied: plan.description, undo_version_id } })
    }
  )

  // ── Command palette, AI half (#2586) ───────────────────────────────────────
  // Read-only: answers intents the editor previews and applies through its draft.

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/layouts/:id/command',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const text = cleanText(req.body?.text, 500)
      if (!text) return reply.code(400).send({ error: 'Type a command' })
      const bundle = await loadLayoutBundle(db, id)
      if (!bundle) return reply.code(404).send({ error: 'Layout not found' })
      const complete = await defaultComplete()
      if (!complete) return reply.code(503).send({ error: new AiUnavailableError().message })
      const [fieldRows, roleRows] = await Promise.all([
        db('nivaro_fields')
          .where({ collection: bundle.layout.collection })
          .select('field', 'label') as Promise<Array<{ field: string; label: string | null }>>,
        db('nivaro_roles').select('id', 'name') as Promise<Array<{ id: string; name: string }>>
      ])
      const ctx: CommandContext = {
        bundle,
        fields: new Map(
          fieldRows.map((f) => [
            String(f.field),
            cleanText(f.label, 80) ?? titleCase(String(f.field))
          ])
        ),
        roles: roleRows.map((r) => ({ id: String(r.id), name: String(r.name) }))
      }
      let answer: string
      try {
        answer = await complete({
          system: COMMAND_SYSTEM,
          user: buildCommandPrompt(ctx, text),
          maxTokens: 1500
        })
      } catch (err) {
        return reply.code(502).send({
          error: `The AI could not read the command: ${(err as Error).message}`.slice(0, 400)
        })
      }
      const parsed = parseCommandAnswer(answer, ctx)
      if (parsed.error) return reply.code(422).send({ error: parsed.error })
      return reply.send({
        data: { intents: parsed.intents, explanation: parsed.explanation, dropped: parsed.dropped }
      })
    }
  )

  // ── Role persona test (#2685) ──────────────────────────────────────────────
  // Read-only: the model walks a new record through the form as the role and
  // reports what would confuse that person. Rule checks run without the model.

  app.post<{ Params: { id: string }; Body: { role_id?: string; goal?: string } }>(
    '/layouts/:id/persona-test',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const roleId = cleanText(req.body?.role_id, 64)
      if (!roleId) return reply.code(400).send({ error: 'Pick a role to play' })
      const bundle = await loadLayoutBundle(db, id)
      if (!bundle) return reply.code(404).send({ error: 'Layout not found' })
      const collection = bundle.layout.collection
      const meta = await loadFieldMeta(collection)
      const role = await loadRoleAccess(collection, roleId, [...meta.keys()])
      if (!role) return reply.code(404).send({ error: 'Role not found' })
      const steps = buildWalkthrough(bundle, meta, role, roleId)
      const ruleFindings = walkthroughRuleFindings(steps, role)
      const walkthrough = steps.map((s) => ({
        key: s.key,
        label: s.label,
        kind: s.kind,
        fields: s.fields.filter((f) => !f.hidden).length,
        required: s.fields.filter((f) => !f.hidden && f.required).length
      }))
      const base = { role: role.name, walkthrough, written: false }
      const complete = await defaultComplete('chat')
      if (!complete)
        return reply.send({
          data: {
            ...base,
            summary: null,
            steps: [],
            findings: ruleFindings,
            dropped: [],
            ai_configured: false
          }
        })
      let answer: string
      try {
        answer = await complete({
          system: PERSONA_SYSTEM,
          user: buildPersonaPrompt({
            collection,
            layout: String(bundle.layout.name ?? ''),
            role: role.name,
            goal: cleanText(req.body?.goal, 300),
            steps,
            ruleFindings
          }),
          maxTokens: 3000
        })
      } catch (err) {
        return reply.code(502).send({
          error: `The AI could not run the test: ${(err as Error).message}`.slice(0, 400)
        })
      }
      const parsed = parsePersonaAnswer(answer, steps)
      return reply.send({
        data: {
          ...base,
          summary: parsed.summary,
          steps: parsed.steps,
          findings: [...ruleFindings, ...parsed.findings],
          dropped: parsed.dropped,
          ai_configured: true
        }
      })
    }
  )

  // ── Visual critique (#2690) ────────────────────────────────────────────────
  // The editor sends its canvas picture (no preview record, values masked) and
  // each section's measured box; comments come back pinned to section keys.

  app.post<{
    Params: { id: string }
    Body: { image?: string; sections?: unknown; canvas?: { w?: number; h?: number } }
  }>('/layouts/:id/visual-critique', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
    const bundle = await loadLayoutBundle(db, id)
    if (!bundle) return reply.code(404).send({ error: 'Layout not found' })
    const meta = await loadFieldMeta(bundle.layout.collection)
    const keys = new Set(bundle.groups.map((g) => g.key))
    const sections = critiqueSections(
      bundle,
      labelLookup(meta),
      cleanGeometry(req.body?.sections, keys)
    )
    const ruleComments = critiqueRuleComments(sections)
    const complete = await defaultComplete('chat')
    if (!complete)
      return reply.send({
        data: {
          summary: null,
          comments: ruleComments,
          dropped: [],
          used_image: false,
          ai_configured: false
        }
      })
    // The OpenAI-compatible gateway shim drops pictures: send structure only there.
    const provider = await describeAiProvider()
    const seesImages = provider.provider === 'anthropic' || provider.format === 'anthropic'
    const image = seesImages ? imageFromDataUri(req.body?.image) : null
    const w = Number(req.body?.canvas?.w)
    const h = Number(req.body?.canvas?.h)
    let answer: string
    try {
      answer = await complete({
        system: CRITIQUE_SYSTEM,
        user: buildCritiquePrompt({
          layout: String(bundle.layout.name ?? ''),
          layout_type: String(bundle.layout.layout_type ?? 'grouped'),
          steps: bundle.layout.tab_mode === 'steps',
          canvas:
            Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
              ? { w: Math.round(w), h: Math.round(h) }
              : null,
          sections,
          ruleComments,
          hasImage: !!image
        }),
        image: image ?? undefined,
        maxTokens: 2500
      })
    } catch (err) {
      return reply.code(502).send({
        error: `The AI could not review the form: ${(err as Error).message}`.slice(0, 400)
      })
    }
    const parsed = parseCritiqueAnswer(answer, new Set(sections.map((s) => s.key)))
    return reply.send({
      data: {
        summary: parsed.summary,
        comments: [...ruleComments, ...parsed.comments],
        dropped: parsed.dropped,
        used_image: !!image,
        image_skipped:
          !image && typeof req.body?.image === 'string'
            ? seesImages
              ? 'invalid'
              : 'provider'
            : null,
        ai_configured: true
      }
    })
  })

  // ── Layout tuned by autofill (#2691) ───────────────────────────────────────
  // Counts only: which fields people change after "Fill from document".

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/layouts/:id/autofill-corrections',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const layout = (await db('nivaro_collection_layouts').where({ id }).first('collection')) as
        | { collection: string }
        | undefined
      if (!layout) return reply.code(404).send({ error: 'Layout not found' })
      const days = Math.max(7, Math.min(365, Number(req.query?.days) || 90))
      const { documents, fields } = await loadCorrectedFields(layout.collection, days)
      return reply.send({
        data: {
          days,
          documents,
          min_proposed: MIN_PROPOSED,
          corrected_share: CORRECTED_SHARE,
          fields: fields.slice(0, 100)
        }
      })
    }
  )

  // ── Field help text drafts (#1912) ─────────────────────────────────────────

  app.get<{ Params: { collection: string } }>('/help-text/:collection', async (req, reply) => {
    const { collection } = req.params
    const col = await db('nivaro_collections').where({ collection }).first('collection')
    if (!col) return reply.code(404).send({ error: 'Collection not found' })
    const candidates = await helpTextCandidates(collection)
    return reply.send({ data: { candidates } })
  })

  app.post<{ Params: { collection: string }; Body: { fields?: string[] } }>(
    '/help-text/:collection/draft',
    async (req, reply) => {
      const { collection } = req.params
      const col = await db('nivaro_collections').where({ collection }).first('collection')
      if (!col) return reply.code(404).send({ error: 'Collection not found' })
      const complete = await defaultComplete()
      if (!complete) return reply.code(503).send({ error: new AiUnavailableError().message })
      let candidates = await helpTextCandidates(collection)
      const wanted = Array.isArray(req.body?.fields) ? new Set(req.body.fields.map(String)) : null
      if (wanted) candidates = candidates.filter((c) => wanted.has(c.field))
      if (candidates.length === 0) return reply.send({ data: { drafts: [] } })
      try {
        const drafts = await draftHelpText(collection, candidates, complete)
        return reply.send({ data: { drafts } })
      } catch (err) {
        return reply.code(502).send({
          error: `The AI could not draft help text: ${(err as Error).message}`.slice(0, 400)
        })
      }
    }
  )

  app.post<{ Params: { collection: string }; Body: { field?: string; text?: string | null } }>(
    '/help-text/:collection/apply',
    async (req, reply) => {
      const { collection } = req.params
      const field = String(req.body?.field ?? '')
      if (!field) return reply.code(400).send({ error: 'field is required' })
      const text = req.body?.text == null ? null : cleanText(req.body.text, HELP_MAX)
      if (req.body?.text != null && !text)
        return reply.code(400).send({ error: 'Help text is empty' })
      const result = await applyHelpText(collection, field, text)
      if (!result) return reply.code(404).send({ error: 'Field not found' })
      clearMetadataCache(collection)
      await logActivity({
        action: 'ai-help-text',
        user: req.user?.id,
        collection: 'nivaro_fields',
        item: String(result.id),
        comment: JSON.stringify({
          collection,
          field,
          previous: result.previous,
          next: text
        }).slice(0, 4000),
        req
      })
      return reply.send({ data: { field, note: text, previous: result.previous } })
    }
  )

  // ── Design a role from a description (#2010) ───────────────────────────────

  app.post<{ Body: { description?: string; ui_routes?: unknown } }>(
    '/roles/design',
    async (req, reply) => {
      const description = cleanText(req.body?.description, 2000)
      if (!description || description.length < 8)
        return reply.code(400).send({ error: 'Describe the role in a sentence or two' })
      const complete = await defaultComplete()
      if (!complete) return reply.code(503).send({ error: new AiUnavailableError().message })
      const catalog = await loadRoleCatalog(uiRoutesFrom(req.body?.ui_routes))
      try {
        const { proposal, dropped } = await designRole(description, catalog, complete)
        const simulation = simulateRoleProposal(proposal, catalog)
        await countReadImpact(simulation)
        return reply.send({
          data: { proposal, dropped, simulation, hash: proposalHash(proposal) }
        })
      } catch (err) {
        return reply.code(502).send({
          error: `The AI could not design the role: ${(err as Error).message}`.slice(0, 400)
        })
      }
    }
  )

  /** The permission simulator on an (edited) proposal — returns the hash apply needs. */
  app.post<{ Body: { proposal?: unknown; ui_routes?: unknown } }>(
    '/roles/simulate',
    async (req, reply) => {
      const catalog = await loadRoleCatalog(uiRoutesFrom(req.body?.ui_routes))
      const { proposal, dropped } = normalizeRoleProposal(req.body?.proposal, catalog)
      const simulation = simulateRoleProposal(proposal, catalog)
      await countReadImpact(simulation)
      return reply.send({ data: { proposal, dropped, simulation, hash: proposalHash(proposal) } })
    }
  )

  app.post<{ Body: { proposal?: unknown; hash?: string; ui_routes?: unknown } }>(
    '/roles/apply',
    async (req, reply) => {
      const catalog = await loadRoleCatalog(uiRoutesFrom(req.body?.ui_routes))
      const { proposal } = normalizeRoleProposal(req.body?.proposal, catalog)
      // Only what the simulator ran on may be saved.
      if (!req.body?.hash || req.body.hash !== proposalHash(proposal))
        return reply
          .code(409)
          .send({ error: 'The proposal changed since it was simulated — run the simulator again' })
      if (proposal.policies.length === 0)
        return reply.code(400).send({ error: 'The proposal grants nothing' })
      try {
        const result = await applyRoleProposal(proposal, req.workspaceId ?? null)
        await logActivity({
          action: 'create',
          user: req.user?.id,
          collection: 'nivaro_roles',
          item: result.id,
          comment: `Designed with AI: "${proposal.name}" (${result.policies} policies)`,
          req
        })
        return reply.code(201).send({
          data: {
            ...result,
            name: proposal.name,
            // NOT applied: User Scopes belong to people, so the admin sets
            // these on each member after adding them to the role.
            scopes_to_set_per_member: proposal.scopes
          }
        })
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode ?? 500
        return reply.code(code).send({ error: (err as Error).message })
      }
    }
  )

  // ── Suggested saved views per role (#1965) ─────────────────────────────────

  app.post<{ Body: { days?: number; ai?: boolean } }>('/role-views/suggest', async (req, reply) => {
    const days = Math.max(1, Math.min(30, Number(req.body?.days) || DEFAULT_DAYS))
    const complete = await defaultComplete()
    const result = await suggestRoleViews(days, req.body?.ai === false ? null : complete)
    return reply.send({ data: { days, ...result, ai_configured: !!complete } })
  })

  app.post<{
    Body: {
      role?: string
      collection?: string
      name?: string
      filters?: unknown
      sort?: string | null
      columns?: unknown
    }
  }>('/role-views/apply', async (req, reply) => {
    const b = req.body ?? {}
    const name = cleanText(b.name, 80)
    if (!b.role || !b.collection || !name)
      return reply.code(400).send({ error: 'role, collection and name are required' })
    const [role, col] = await Promise.all([
      db('nivaro_roles').where({ id: b.role }).first('id', 'name'),
      db('nivaro_collections').where({ collection: b.collection }).first('collection')
    ])
    if (!role) return reply.code(404).send({ error: 'Role not found' })
    if (!col) return reply.code(404).send({ error: 'Collection not found' })
    const fieldRows = (await db('nivaro_fields')
      .where({ collection: b.collection })
      .select('field')) as Array<{ field: string }>
    const known = new Set(fieldRows.map((f) => f.field))
    const filters = Array.isArray(b.filters) ? b.filters : []
    if (
      filters.length === 0 ||
      filters.some((f) => {
        const p = (f as { path?: unknown })?.path
        return !Array.isArray(p) || !known.has(String(p[0]))
      })
    )
      return reply.code(400).send({ error: 'Every filter must start at a field of the collection' })
    const columns = Array.isArray(b.columns)
      ? b.columns.filter((c): c is string => typeof c === 'string' && known.has(c.split('.')[0]))
      : null
    const [row] = (await db('nivaro_saved_views')
      .insert({
        collection: b.collection,
        name,
        filters: JSON.stringify(filters),
        sort: JSON.stringify(cleanText(b.sort, 120) ?? ''),
        columns: columns?.length ? JSON.stringify(columns) : null,
        user: req.user!.id,
        is_shared: true,
        is_default: false,
        role: role.id,
        created_at: new Date()
      })
      .returning('id')) as unknown as Array<{ id: number } | number>
    const viewId = typeof row === 'object' ? row.id : row
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_saved_views',
      item: String(viewId),
      comment: `AI-suggested view "${name}" for role ${role.name} on ${b.collection}`,
      req
    })
    return reply.code(201).send({ data: { id: viewId, name, role: role.id } })
  })
}
