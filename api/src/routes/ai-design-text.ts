import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import { describeAiProvider, getAiClient, getAiModelSettings } from '../services/ai-client.js'
import type { GlossaryWord } from '../services/ai-design/glossary-terms.js'
import {
  buildChoicePrompt,
  buildIntroPrompt,
  buildPlaceholderPrompt,
  buildTextModel,
  buildTranslatePrompt,
  CHOICE_SYSTEM,
  choiceCandidates,
  choiceProposals,
  choicesFrom,
  glossaryTool,
  INTRO_SYSTEM,
  introCandidates,
  LOCALE_RE,
  PLACEHOLDER_SYSTEM,
  parseDeep,
  parseIntroAnswer,
  placeholderCandidates,
  placeholderProposals,
  READING_SYSTEM,
  readingItems,
  readingProposals,
  relabelChoices,
  TEXT_TOOLS,
  type TextModel,
  type TextResult,
  type TextTool,
  translateCandidates,
  translateProposals,
  translateSystem
} from '../services/ai-design/layout-text.js'
import { type AiComplete, AiUnavailableError, cleanText } from '../services/ai-design/model.js'
import { type ValueShape, valueShape } from '../services/ai-design/value-shapes.js'
import { listGlossary } from '../services/ai-knowledge.js'
import { clearMetadataCache } from '../services/collections.js'
import { announceConfigChanged } from '../services/config-live.js'
import { readItems } from '../services/items.js'
import { loadLayoutBundle } from '../services/layout-ops.js'
import { withReadGate } from '../services/read-gate.js'
import type { User } from '../types.js'

/**
 * AI wording tools for the layout editor (#2677 #2678 #2679 #2681 #2682 #2683)
 * — admin only, under /api/ai-design/layouts/:id/text/…
 *
 * Every tool READS and PROPOSES: the editor applies what the admin keeps
 * through its draft (one undo step; manual Save applies). The one write here
 * is choice labels "on the field" (#2681), which changes the field's own
 * options for every form — logged with the previous choices.
 */

const SAMPLE_ROWS = 300

/** The writing model (#2586 rules: 'generate' for writing), or null when AI is not set up. */
async function writingComplete(): Promise<AiComplete | null> {
  const { generateModel } = await getAiModelSettings()
  const client = await getAiClient({ model: generateModel })
  if (!client) return null
  return async ({ system, user, maxTokens }) => {
    const msg = await client.messages.create({
      model: generateModel,
      max_tokens: maxTokens ?? 2500,
      system,
      messages: [{ role: 'user', content: user }]
    })
    return msg.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n')
      .trim()
  }
}

async function loadModel(id: number): Promise<TextModel | null> {
  const bundle = await loadLayoutBundle(db, id)
  if (!bundle) return null
  const fieldRows = (await db('nivaro_fields').where({
    collection: bundle.layout.collection
  })) as Array<Record<string, unknown>>
  return buildTextModel(bundle, fieldRows)
}

async function glossaryWords(): Promise<GlossaryWord[]> {
  const rows = await listGlossary().catch(() => [])
  return rows.map((e) => ({ id: e.id, term: e.term, aliases: e.aliases }))
}

/** Words people know from the glossary: their abbreviations cost the reading score nothing. */
function knownWords(glossary: GlossaryWord[]): Set<string> {
  const out = new Set<string>()
  for (const e of glossary) for (const w of [e.term, ...e.aliases]) out.add(w.toLowerCase())
  return out
}

/**
 * Up to SAMPLE_ROWS values per field, read as the admin through the items
 * service (permissions, scopes, workspace) and the read gate. The values stay
 * on the server: only their shapes reach the model.
 */
async function sampleValues(
  user: User,
  collection: string,
  fields: string[]
): Promise<Map<string, unknown[]>> {
  const out = new Map<string, unknown[]>()
  if (fields.length === 0) return out
  try {
    const res = (await withReadGate(
      user.id,
      () => readItems(user, collection, { fields, limit: SAMPLE_ROWS, count: false }),
      { label: 'ai-text:placeholders' }
    )) as { data?: Array<Record<string, unknown>> }
    for (const f of fields)
      out.set(
        f,
        (res.data ?? []).map((r) => r[f])
      )
  } catch {
    /* no sample: the model writes from labels and types alone */
  }
  return out
}

async function localeSettings(): Promise<{ locales: string[]; default_locale: string }> {
  const row = (await db('nivaro_settings')
    .first('available_locales', 'default_language')
    .catch(() => null)) as { available_locales?: unknown; default_language?: unknown } | null
  let locales: string[] = []
  try {
    const parsed =
      typeof row?.available_locales === 'string'
        ? JSON.parse(row.available_locales)
        : row?.available_locales
    if (Array.isArray(parsed)) locales = parsed.map(String).filter((l) => LOCALE_RE.test(l))
  } catch {
    /* none */
  }
  const def =
    typeof row?.default_language === 'string' && row.default_language ? row.default_language : 'en'
  const base = def.split('-')[0].toLowerCase()
  return {
    locales: locales.filter((l) => l !== def && l.toLowerCase() !== base),
    default_locale: def
  }
}

class NeedsAi extends Error {}

async function runTool(
  tool: TextTool,
  model: TextModel,
  user: User,
  opts: { locale: string | null; ai: boolean }
): Promise<TextResult> {
  const complete = opts.ai ? await writingComplete() : null
  const ask = async (system: string, user: string) => {
    if (!complete) throw new NeedsAi()
    return complete({ system, user, maxTokens: 3000 })
  }
  switch (tool) {
    case 'glossary':
      return glossaryTool(model, await glossaryWords(), complete)
    case 'intros': {
      const cands = introCandidates(model)
      if (cands.length === 0)
        return {
          proposals: [],
          dropped: 0,
          ai_used: false,
          note: 'Every section and step with fields already has an intro.'
        }
      return parseIntroAnswer(await ask(INTRO_SYSTEM, buildIntroPrompt(model, cands)), cands)
    }
    case 'placeholders': {
      const rels = (await db('nivaro_relations')
        .where({ many_collection: model.collection })
        .select('many_field')
        .catch(() => [])) as Array<{ many_field: string | null }>
      const cands = placeholderCandidates(
        model,
        new Set(rels.map((r) => String(r.many_field ?? '')))
      )
      const samples = await sampleValues(
        user,
        model.collection,
        cands.filter((c) => c.sample).map((c) => c.placed.field)
      )
      const shapes = new Map<string, ValueShape>()
      for (const c of cands) {
        const s = valueShape(samples.get(c.placed.field) ?? [], c.numeric)
        if (s) shapes.set(c.placed.field, s)
      }
      const answer =
        complete && cands.length
          ? await complete({
              system: PLACEHOLDER_SYSTEM,
              user: buildPlaceholderPrompt(cands, shapes),
              maxTokens: 2000
            })
          : null
      return placeholderProposals(cands, shapes, samples, answer)
    }
    case 'choices': {
      const cands = choiceCandidates(model)
      const answer =
        complete && cands.length
          ? await complete({
              system: CHOICE_SYSTEM,
              user: buildChoicePrompt(cands),
              maxTokens: 3000
            })
          : null
      return choiceProposals(cands, answer)
    }
    case 'reading': {
      const known = knownWords(await glossaryWords())
      const items = readingItems(model, known)
      const answer =
        complete && items.length
          ? await complete({
              system: READING_SYSTEM,
              user: JSON.stringify({
                known: [...known].slice(0, 200),
                items: items.map((i) => ({ id: i.id, kind: i.kind, text: i.text, why: i.reasons }))
              }),
              maxTokens: 3000
            })
          : null
      return readingProposals(items, known, answer)
    }
    case 'translate': {
      const locale = opts.locale
      if (!locale) throw new Error('Pick a language')
      const cands = translateCandidates(model, locale)
      if (cands.length === 0) return translateProposals([], locale, '{}')
      return translateProposals(
        cands,
        locale,
        await ask(translateSystem(locale), buildTranslatePrompt(cands))
      )
    }
  }
}

export async function aiDesignTextRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  app.addHook('preHandler', resolveWorkspace)

  app.get<{ Params: { id: string } }>('/layouts/:id/text/locales', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
    const [settings, ai] = await Promise.all([
      localeSettings(),
      describeAiProvider().catch(() => ({ configured: false }))
    ])
    return reply.send({ data: { ...settings, ai_configured: ai.configured } })
  })

  app.post<{ Params: { id: string; tool: string }; Body: { locale?: string; ai?: boolean } }>(
    '/layouts/:id/text/:tool',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const tool = req.params.tool as TextTool
      if (!TEXT_TOOLS.includes(tool)) return reply.code(404).send({ error: 'Unknown tool' })
      let locale: string | null = null
      if (tool === 'translate') {
        const { locales } = await localeSettings()
        locale = typeof req.body?.locale === 'string' ? req.body.locale : null
        if (!locale || !locales.includes(locale))
          return reply
            .code(400)
            .send({ error: 'Pick one of the languages set under Settings → Localization' })
      }
      const model = await loadModel(id)
      if (!model) return reply.code(404).send({ error: 'Layout not found' })
      try {
        const result = await runTool(tool, model, req.user!, {
          locale,
          ai: req.body?.ai !== false
        })
        return reply.send({ data: { tool, ...result } })
      } catch (err) {
        if (err instanceof NeedsAi || err instanceof AiUnavailableError)
          return reply.code(503).send({ error: new AiUnavailableError().message })
        return reply.code(502).send({
          error: `The AI could not write this: ${(err as Error).message}`.slice(0, 400)
        })
      }
    }
  )

  /**
   * #2681 "on the field": new labels for the field's own choices (every form
   * that does not keep its own copy). Only existing values change; their order
   * and every other option stay.
   */
  app.post<{
    Params: { id: string }
    Body: { field?: string; choices?: Array<{ value?: unknown; text?: unknown }> }
  }>('/layouts/:id/text/choices/field', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
    const layout = (await db('nivaro_collection_layouts').where({ id }).first('collection')) as
      | { collection: string }
      | undefined
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })
    const field = String(req.body?.field ?? '')
    const wanted = new Map<string, string>()
    for (const c of Array.isArray(req.body?.choices) ? req.body.choices : []) {
      const text = cleanText(c?.text, 60)
      if (text && c?.value != null) wanted.set(String(c.value), text)
    }
    if (!field || wanted.size === 0)
      return reply.code(400).send({ error: 'field and choices are required' })
    const row = (await db('nivaro_fields')
      .where({ collection: layout.collection, field })
      .first('id', 'options')) as { id: number; options: unknown } | undefined
    if (!row) return reply.code(404).send({ error: 'Field not found' })
    const options = parseDeep(row.options)
    const current = choicesFrom(options)
    if (!current || !Array.isArray(options.choices))
      return reply.code(409).send({ error: 'The field has no choices' })
    const previous = current.map((c) => ({ text: c.text, value: c.value }))
    const { next, changed } = relabelChoices(options.choices, wanted)
    if (changed === 0) return reply.send({ data: { field, changed: 0 } })
    await db('nivaro_fields')
      .where({ id: row.id })
      .update({ options: JSON.stringify({ ...options, choices: next }), updated_at: new Date() })
    clearMetadataCache(layout.collection)
    try {
      announceConfigChanged(
        'field-config',
        layout.collection,
        (req as unknown as { nvrTenantId?: string }).nvrTenantId
      )
    } catch {
      /* best-effort */
    }
    await logActivity({
      action: 'ai-choice-labels',
      user: req.user?.id,
      collection: 'nivaro_fields',
      item: String(row.id),
      comment: JSON.stringify({
        collection: layout.collection,
        field,
        previous,
        next
      }).slice(0, 4000),
      req
    })
    return reply.send({ data: { field, changed } })
  })
}
