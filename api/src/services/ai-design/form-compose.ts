import { extname } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import { db } from '../../db/index.js'
import {
  AiImagesUnsupportedError,
  getAiClient,
  getAiModelSettings,
  IMAGES_REQUIRED,
  settingsRow
} from '../ai-client.js'
import { ACCEPTED_EXTENSIONS, extractDocumentText, MAX_TEXT_CHARS } from '../document-extract.js'
import { isPersonField } from '../layout-usage.js'
import { pdfPageImages } from '../pdf-pages.js'
import { asArray, cleanText, parseJsonLoose, titleCase } from './model.js'

/**
 * AI form building (#2668 #2669 #2670): a form drafted from a description, a
 * picture or PDF of an old form, or a process document (SOP).
 *
 * The model gets the collection's field METADATA (keys, labels, types,
 * descriptions, relation targets) and, for an SOP, the states of the
 * pipelines bound to the collection — never record values. It answers with a
 * STRUCTURE (steps or sections, each listing field keys) that is checked here:
 * a name that is not a field of the collection is dropped and reported, a
 * field named twice keeps its first place, locks name only bound pipelines
 * and their states. The editor turns the structure into layout ops against
 * its own draft (ai-forms/plan.ts in packages/shared) and checks them with
 * the ops twin before showing them. Nothing here writes, and the uploaded
 * file is read in memory only — never stored.
 */

export type ComposeMode = 'describe' | 'picture' | 'sop'

export interface ComposeField {
  field: string
  label: string
  type: string
  note: string | null
  relation: string | null
  required: boolean
}

export interface ComposeState {
  pipeline_id: string
  pipeline: string
  key: string
  label: string
}

export interface ComposeContext {
  collection: string
  label: string | null
  fields: ComposeField[]
  states: ComposeState[]
}

export interface ComposedGroup {
  label: string
  fields: string[]
  /** The passage of the document this step / section came from (SOP, picture). */
  source: string | null
}

export interface ComposedLock {
  field: string
  pipeline_id: string
  state_keys: string[]
  source: string | null
}

export interface ComposedRequirement {
  field: string
  pipeline_id: string
  state_key: string
  source: string | null
}

export interface CandidateField {
  label: string
  type: string | null
  /** The step / section the label sat in on the document. */
  group: string | null
  /** #3186: a field key to create it with — snake_case of the label, not taken yet. */
  key?: string
}

export interface ComposedForm {
  name: string | null
  layout: 'steps' | 'sections'
  groups: ComposedGroup[]
  locks: ComposedLock[]
  requirements: ComposedRequirement[]
  /** Labels on the document no field matched: candidate new fields, never created. */
  candidates: CandidateField[]
  /** Names the model used that are not fields of the collection (left out). */
  dropped: string[]
  explanation: string | null
}

export const COMPOSE_MAX_BYTES = 10 * 1024 * 1024
/** #3186: a paper form photographed page by page — up to this many files, this much in all. */
export const COMPOSE_MAX_FILES = 6
export const COMPOSE_MAX_TOTAL_BYTES = 25 * 1024 * 1024
/** Pictures one request sends the model (photos plus drawn PDF pages). */
export const COMPOSE_MAX_IMAGES = 8
/** A picture's longest side after resizing: legible handwriting, a sane token count. */
const IMAGE_MAX_SIDE = 2000
/** Anthropic refuses an image over 5 MB (base64); keep a margin. */
const IMAGE_MAX_BYTES = 3_700_000
export const MAX_GROUPS = 15
const MAX_FIELDS_PER_GROUP = 80
const MAX_PROMPT_FIELDS = 300
const MAX_CANDIDATES = 40
const MAX_RULES = 60
const GROUP_LABEL_MAX = 40
const SOURCE_MAX = 300

export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** What an upload may be: a picture, or a document the autofill reader reads. */
export const COMPOSE_ACCEPT = [...Object.keys(IMAGE_TYPES), ...ACCEPTED_EXTENSIONS]

// ─── Context ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

/** Field metadata and bound pipeline states — what the model may know. */
export async function loadComposeContext(collection: string): Promise<ComposeContext | null> {
  const col = (await db('nivaro_collections').where({ collection }).first()) as Row | undefined
  if (!col) return null
  const [fieldRows, relRows, stateRows] = await Promise.all([
    db('nivaro_fields').where({ collection }).select('*') as Promise<Row[]>,
    db('nivaro_relations')
      .where({ many_collection: collection })
      .orWhere({ one_collection: collection })
      .select('many_collection', 'many_field', 'one_collection', 'one_field')
      .catch(() => []) as Promise<Row[]>,
    db('nivaro_workflow_bindings as b')
      .join('nivaro_workflow_states as s', 's.template', 'b.template')
      .leftJoin('nivaro_workflow_templates as t', 't.id', 'b.template')
      .where('b.collection', collection)
      .orderBy('s.sort', 'asc')
      .select('b.template', 't.name', 's.key', 's.label')
      .catch(() => []) as Promise<Row[]>
  ])
  const relation = new Map<string, string>()
  for (const r of relRows) {
    if (r.many_collection === collection && r.many_field && r.one_collection)
      relation.set(String(r.many_field), `links to one ${String(r.one_collection)}`)
    else if (r.one_collection === collection && r.one_field && r.many_collection)
      relation.set(String(r.one_field), `lists ${String(r.many_collection)} rows`)
  }
  return {
    collection,
    label: cleanText(col.display_name ?? col.label, 80),
    fields: fieldRows
      .filter((f) => typeof f.field === 'string' && isPersonField(String(f.field)))
      .filter((f) => !String(f.field).startsWith('__'))
      .map((f) => ({
        field: String(f.field),
        label: cleanText(f.label, 80) ?? titleCase(String(f.field)),
        type: String(f.type ?? 'string'),
        note: cleanText(f.note, 200),
        relation: relation.get(String(f.field)) ?? null,
        required: f.required === true || f.required === 1
      })),
    states: stateRows
      .filter((s) => s.key)
      .map((s) => ({
        pipeline_id: String(s.template),
        pipeline: cleanText(s.name, 80) ?? 'Pipeline',
        key: String(s.key),
        label: cleanText(s.label, 80) ?? String(s.key)
      }))
  }
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const ANSWER_SHAPE = `Answer with ONE JSON object and nothing else:
{"name":"<short form name>","layout":"steps"|"sections","groups":[{"label":"<step or section name>","fields":["<field key>", ...],"source":"<quote, optional>"}],"unmatched":[{"label":"<label on the document>","type":"<text|number|date|yes/no|choice|file|person|record>","group":"<group label>"}],"locks":[{"field":"<field key>","pipeline":"<pipeline id>","states":["<state key>", ...],"source":"<quote>"}],"requirements":[{"field":"<field key>","pipeline":"<pipeline id>","state":"<state key>","source":"<quote>"}],"explanation":"<one short sentence>"}
or {"error":"<why this cannot be done>"}.`

const COMMON_RULES = `Rules: use ONLY field keys from the input "fields" list; never invent keys. Every field at most once. "steps" = the form is filled step by step (one group per step); "sections" = one page with headed sections. At most ${MAX_GROUPS} groups, short plain names (no numbering). Order fields the way a person fills them. Leave out fields that do not belong on this form.`

export const COMPOSE_SYSTEM: Record<ComposeMode, string> = {
  describe: `You design a data-entry form for a business application from an admin's description, using the collection's existing fields.
${ANSWER_SHAPE}
${COMMON_RULES} Leave "unmatched", "locks" and "requirements" empty.`,
  picture: `You rebuild a legacy form (a screenshot, scan, PDF or spreadsheet of a paper or Excel form) as a data-entry form on a business application's existing fields.
Read the document's labels and layout, match each label to the field of the input with the same meaning, and keep the document's order and grouping (its boxes, headings or pages become sections or steps). Several pictures, pages or files are pages of the same form, in order; a handwritten entry is an example value, never a label.
${ANSWER_SHAPE}
${COMMON_RULES} A label no field matches goes in "unmatched" with a guessed type — never in "groups". "source" = the heading on the document. Leave "locks" and "requirements" empty.`,
  sop: `You turn a process document (an SOP) into a data-entry form on a business application's existing fields: one step per stage of the process.
${ANSWER_SHAPE}
${COMMON_RULES} Use "steps". Each step's "source" quotes the passage (<= 200 chars, verbatim) the step came from. "locks": fields the document says must not change once the record reaches a stage (read-only in those pipeline states). "requirements": fields the document says must be filled before or at a stage. Locks and requirements may only name pipeline ids and state keys from the input "pipelines"; leave them empty when there are none. Leave "unmatched" empty.`
}

/** The JSON part of the user message: the collection, its fields, its pipelines. */
export function buildComposeContextJson(ctx: ComposeContext, extra: Row = {}): string {
  const pipelines = new Map<string, { id: string; name: string; states: Row[] }>()
  for (const s of ctx.states) {
    const p = pipelines.get(s.pipeline_id) ?? { id: s.pipeline_id, name: s.pipeline, states: [] }
    p.states.push({ key: s.key, label: s.label })
    pipelines.set(s.pipeline_id, p)
  }
  return JSON.stringify({
    ...extra,
    collection: ctx.collection,
    collection_label: ctx.label ?? undefined,
    fields: ctx.fields.slice(0, MAX_PROMPT_FIELDS).map((f) => ({
      key: f.field,
      label: f.label,
      type: f.type,
      description: f.note ?? undefined,
      relation: f.relation ?? undefined,
      required: f.required || undefined
    })),
    pipelines: [...pipelines.values()]
  })
}

// ─── Parsing ────────────────────────────────────────────────────────────────

export class ComposeRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComposeRefusal'
  }
}

/** Field key by key, case-insensitive key or (unique) label. */
export function fieldResolver(fields: ComposeField[]): (name: unknown) => string | null {
  const byKey = new Map(fields.map((f) => [f.field, f.field]))
  const byLower = new Map<string, string>()
  const labelCount = new Map<string, number>()
  for (const f of fields) {
    byLower.set(f.field.toLowerCase(), f.field)
    const l = f.label.toLowerCase()
    labelCount.set(l, (labelCount.get(l) ?? 0) + 1)
  }
  const byLabel = new Map<string, string>()
  for (const f of fields)
    if (labelCount.get(f.label.toLowerCase()) === 1) byLabel.set(f.label.toLowerCase(), f.field)
  return (name) => {
    if (typeof name !== 'string') return null
    const t = name.trim()
    if (!t) return null
    return byKey.get(t) ?? byLower.get(t.toLowerCase()) ?? byLabel.get(t.toLowerCase()) ?? null
  }
}

const quote = (v: unknown) => cleanText(v, SOURCE_MAX)

/**
 * The model's answer checked against the collection. Throws ComposeRefusal
 * when nothing usable came back (the route answers 422 with the reason).
 */
export function parseComposeAnswer(
  text: string,
  ctx: ComposeContext,
  mode: ComposeMode
): ComposedForm {
  const parsed = parseJsonLoose(text)
  if (!parsed) throw new ComposeRefusal('The AI answer was not readable — try again')
  const refusal = cleanText(parsed.error, 300)
  if (refusal && !Array.isArray(parsed.groups)) throw new ComposeRefusal(refusal)

  const resolve = fieldResolver(ctx.fields)
  const dropped: string[] = []
  const candidates: CandidateField[] = []
  const used = new Set<string>()
  const groups: ComposedGroup[] = []
  const labels = new Set<string>()

  for (const raw of asArray(parsed.groups).slice(0, MAX_GROUPS)) {
    const o = (raw ?? {}) as Row
    let label = cleanText(o.label, GROUP_LABEL_MAX)
    if (!label) continue
    // Two groups of the same name read as one on the form: number the second.
    for (let i = 2; labels.has(label.toLowerCase()); i++)
      label = `${cleanText(o.label, GROUP_LABEL_MAX - 3)} ${i}`
    const fields: string[] = []
    for (const name of asArray(o.fields).slice(0, MAX_FIELDS_PER_GROUP)) {
      const key = resolve(name)
      if (!key) {
        const shown = cleanText(name, 80)
        if (shown && !dropped.includes(shown)) {
          dropped.push(shown)
          if (mode === 'picture' && candidates.length < MAX_CANDIDATES)
            candidates.push({ label: shown, type: null, group: label })
        }
        continue
      }
      if (used.has(key)) continue
      used.add(key)
      fields.push(key)
    }
    if (fields.length === 0) continue
    labels.add(label.toLowerCase())
    groups.push({ label, fields, source: quote(o.source) })
  }

  if (mode === 'picture')
    for (const raw of asArray(parsed.unmatched)) {
      if (candidates.length >= MAX_CANDIDATES) break
      const o = (raw ?? {}) as Row
      const label = cleanText(o.label, 80)
      if (!label || resolve(label)) continue
      if (candidates.some((c) => c.label.toLowerCase() === label.toLowerCase())) continue
      candidates.push({ label, type: cleanText(o.type, 20), group: cleanText(o.group, 60) })
    }

  const locks: ComposedLock[] = []
  const requirements: ComposedRequirement[] = []
  if (mode === 'sop' && ctx.states.length) {
    const pipelineOf = (v: unknown): string | null => {
      if (typeof v !== 'string') return null
      const t = v.trim().toLowerCase()
      return (
        ctx.states.find((s) => s.pipeline_id.toLowerCase() === t || s.pipeline.toLowerCase() === t)
          ?.pipeline_id ??
        (new Set(ctx.states.map((s) => s.pipeline_id)).size === 1
          ? ctx.states[0].pipeline_id
          : null)
      )
    }
    const stateOf = (pipeline: string, v: unknown): string | null => {
      if (typeof v !== 'string') return null
      const t = v.trim().toLowerCase()
      return (
        ctx.states.find(
          (s) =>
            s.pipeline_id === pipeline && (s.key.toLowerCase() === t || s.label.toLowerCase() === t)
        )?.key ?? null
      )
    }
    for (const raw of asArray(parsed.locks).slice(0, MAX_RULES)) {
      const o = (raw ?? {}) as Row
      const field = resolve(o.field)
      const pipeline = pipelineOf(o.pipeline)
      if (!field || !pipeline) continue
      const keys = [...new Set(asArray(o.states).map((s) => stateOf(pipeline, s)))].filter(
        (k): k is string => !!k
      )
      if (keys.length === 0) continue
      const same = locks.find((l) => l.field === field && l.pipeline_id === pipeline)
      if (same) same.state_keys = [...new Set([...same.state_keys, ...keys])]
      else locks.push({ field, pipeline_id: pipeline, state_keys: keys, source: quote(o.source) })
    }
    for (const raw of asArray(parsed.requirements).slice(0, MAX_RULES)) {
      const o = (raw ?? {}) as Row
      const field = resolve(o.field)
      const pipeline = pipelineOf(o.pipeline)
      const state = pipeline ? stateOf(pipeline, o.state) : null
      if (!field || !pipeline || !state) continue
      if (requirements.some((r) => r.field === field)) continue
      requirements.push({ field, pipeline_id: pipeline, state_key: state, source: quote(o.source) })
    }
  }

  if (groups.length === 0)
    throw new ComposeRefusal(
      refusal ??
        (dropped.length
          ? `The AI named no field of this collection (it used: ${dropped.slice(0, 6).join(', ')})`
          : 'The AI found nothing to put on the form')
    )
  // Suggested keys for the labels no field matched (never created here).
  const taken = new Set(ctx.fields.map((f) => f.field.toLowerCase()))
  for (const c of candidates) c.key = candidateKey(c.label, taken)
  return {
    name: cleanText(parsed.name, 60),
    layout: mode === 'sop' || parsed.layout === 'steps' ? 'steps' : 'sections',
    groups,
    locks,
    requirements,
    candidates,
    dropped,
    explanation: cleanText(parsed.explanation, 300)
  }
}

/** "Date of birth" → date_of_birth: a key for a new field, unlike any taken one. */
export function candidateKey(label: string, taken: Set<string>): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48)
      .replace(/_+$/, '') || 'field'
  const start = /^[a-z]/.test(base) ? base : `f_${base}`
  let key = start
  for (let n = 2; taken.has(key); n++) key = `${start}_${n}`
  taken.add(key)
  return key
}

// ─── Model + uploaded documents ─────────────────────────────────────────────

export type ComposeContent = string | Anthropic.ContentBlockParam[]
/** One model call; injectable so tests never reach a provider. */
export type ComposeAsk = (
  system: string,
  content: ComposeContent,
  maxTokens: number
) => Promise<string>

/** The configured provider on the per-feature model, or null when AI is not set up. */
export async function composeAsk(kind: 'chat' | 'generate' = 'chat'): Promise<ComposeAsk | null> {
  const models = await getAiModelSettings()
  const model = kind === 'chat' ? models.chatModel : models.generateModel
  const client = await getAiClient({ model })
  if (!client) return null
  return async (system, content, maxTokens) => {
    // A picture IS the input here: a gateway that cannot read it must say so,
    // not answer from "[image omitted]" (ai-client withImageFallback).
    const pictures = Array.isArray(content) && content.some((b) => b.type === 'image')
    let msg: Anthropic.Message
    try {
      msg = (await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content }],
        ...(pictures ? { [IMAGES_REQUIRED]: true } : {})
      })) as Anthropic.Message
    } catch (err) {
      if (err instanceof AiImagesUnsupportedError) throw new ComposeRefusal(err.message)
      throw err
    }
    return msg.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n')
      .trim()
  }
}

/** Can the configured wire carry a PDF as a document block? (The OpenAI shim cannot.) */
export async function providerReadsPdf(): Promise<boolean> {
  const s = (await settingsRow()) ?? {}
  return s.ai_provider !== 'gateway' || s.ai_gateway_format === 'anthropic'
}

export interface UploadedDoc {
  buffer: Buffer
  filename: string
  mimetype: string | null
}

export function imageTypeOf(doc: { filename: string; mimetype: string | null }): string | null {
  const byExt = IMAGE_TYPES[extname(doc.filename || '').toLowerCase()]
  if (byExt) return byExt
  const m = (doc.mimetype ?? '').toLowerCase()
  return Object.values(IMAGE_TYPES).includes(m) ? m : null
}

const isPdf = (doc: UploadedDoc) =>
  extname(doc.filename || '').toLowerCase() === '.pdf' ||
  (doc.mimetype ?? '').toLowerCase() === 'application/pdf'

/**
 * The upload as message content: a picture as an image block, a PDF as a
 * document block where the provider reads them, anything else (and a PDF on
 * the OpenAI shim) as its text, read the way document autofill reads it.
 */
export async function documentContent(
  doc: UploadedDoc,
  opts: {
    pdfBlocks: boolean
    /** #3186: a form's PDF on a provider without PDF blocks is sent as page pictures. */
    pdfPagesFirst?: boolean
    /** Pictures still allowed in this request (photos + drawn pages). */
    images?: number
    /** Injectable for tests: draws PDF pages (locally or on the render peer). */
    drawPages?: typeof pdfPageImages
  }
): Promise<{ blocks: Anthropic.ContentBlockParam[]; method: string }> {
  const image = imageTypeOf(doc)
  if (image) {
    const pic = await preparePicture(doc.buffer, image)
    return { blocks: [imageBlock(pic.data, pic.type)], method: 'image' }
  }
  const room = Math.max(0, Math.min(opts.images ?? 4, 4))
  const draw = opts.drawPages ?? pdfPageImages
  if (isPdf(doc) && !opts.pdfBlocks && opts.pdfPagesFirst && room > 0) {
    const pages = await pagesOf(doc, room, draw)
    if (pages) return pages
  }
  if (isPdf(doc) && opts.pdfBlocks)
    return {
      blocks: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: doc.buffer.toString('base64')
          }
        }
      ],
      method: 'pdf'
    }
  const extracted = await extractDocumentText(doc.buffer, doc.filename, doc.mimetype)
  if (extracted.text.trim().length < 20) {
    // A scanned PDF: look at its pages instead (#3186).
    const pages = isPdf(doc) && room > 0 ? await pagesOf(doc, room, draw) : null
    if (pages) return pages
    throw new ComposeRefusal(
      isPdf(doc)
        ? 'This PDF has no readable text (a scan?). Upload a picture of it (PNG or JPG) instead.'
        : 'No readable text in this file.'
    )
  }
  return {
    blocks: [
      {
        type: 'text',
        text: `Document "${doc.filename}"${extracted.pages ? ` (${extracted.pages} pages)` : ''}${extracted.truncated ? `, first ${MAX_TEXT_CHARS} characters` : ''}:\n\n${extracted.text}`
      }
    ],
    method: extracted.method
  }
}

function imageBlock(data: Buffer, type: string): Anthropic.ContentBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: type as 'image/jpeg', data: data.toString('base64') }
  }
}

/**
 * A photo as the model should see it (#3186): turned upright from its EXIF
 * orientation (phones store most photos sideways), at most IMAGE_MAX_SIDE on
 * its longest side and under the provider's per-image limit. A screenshot
 * (PNG) stays PNG while it fits; anything else becomes JPEG. A GIF and a
 * picture sharp cannot read go as they came.
 */
export async function preparePicture(
  buffer: Buffer,
  type: string
): Promise<{ data: Buffer; type: string }> {
  if (type === 'image/gif') return { data: buffer, type }
  try {
    const img = sharp(buffer, { failOn: 'none' }).rotate().resize({
      width: IMAGE_MAX_SIDE,
      height: IMAGE_MAX_SIDE,
      fit: 'inside',
      withoutEnlargement: true
    })
    if (type === 'image/png') {
      const png = await img.clone().png({ compressionLevel: 9 }).toBuffer()
      if (png.length <= IMAGE_MAX_BYTES) return { data: png, type: 'image/png' }
    }
    for (const quality of [85, 70, 55]) {
      const jpg = await img.clone().flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer()
      if (jpg.length <= IMAGE_MAX_BYTES || quality === 55) return { data: jpg, type: 'image/jpeg' }
    }
  } catch {
    /* not readable here: send it as it came */
  }
  return { data: buffer, type }
}

/** A PDF's first pages as pictures, or null when they cannot be drawn here or on the render peer. */
async function pagesOf(
  doc: UploadedDoc,
  room: number,
  draw: typeof pdfPageImages
): Promise<{ blocks: Anthropic.ContentBlockParam[]; method: string } | null> {
  let drawn: Awaited<ReturnType<typeof pdfPageImages>>
  try {
    drawn = await draw(doc.buffer, { maxPages: room, width: 1600 })
  } catch {
    return null
  }
  if (!drawn.pages.length) return null
  const blocks: Anthropic.ContentBlockParam[] = []
  for (const [i, page] of drawn.pages.entries()) {
    blocks.push({ type: 'text', text: `Page ${i + 1} of ${drawn.total}:` })
    blocks.push(imageBlock(page, 'image/jpeg'))
  }
  if (drawn.total > drawn.pages.length)
    blocks.push({
      type: 'text',
      text: `(Only the first ${drawn.pages.length} of ${drawn.total} pages are shown.)`
    })
  return { blocks, method: 'pdf-pages' }
}

/**
 * Several uploads (pages of one paper form, photographed one by one) as one
 * message: each labelled with its file name, pictures counted against
 * COMPOSE_MAX_IMAGES.
 */
export async function documentsContent(
  docs: UploadedDoc[],
  opts: { pdfBlocks: boolean; pdfPagesFirst?: boolean; drawPages?: typeof pdfPageImages }
): Promise<{ blocks: Anthropic.ContentBlockParam[]; method: string }> {
  if (docs.length === 1) return documentContent(docs[0], { ...opts, images: COMPOSE_MAX_IMAGES })
  const blocks: Anthropic.ContentBlockParam[] = []
  const methods: string[] = []
  let images = COMPOSE_MAX_IMAGES
  for (const [i, doc] of docs.entries()) {
    if (imageTypeOf(doc) && images <= 0)
      throw new ComposeRefusal(`At most ${COMPOSE_MAX_IMAGES} pictures in one go`)
    const part = await documentContent(doc, { ...opts, images })
    images -= part.blocks.filter((b) => b.type === 'image').length
    blocks.push({ type: 'text', text: `File ${i + 1} of ${docs.length}: "${doc.filename}"` })
    blocks.push(...part.blocks)
    if (!methods.includes(part.method)) methods.push(part.method)
  }
  return { blocks, method: methods.join('+') }
}

/** Ask the model and check its answer: the whole of one compose request. */
export async function composeForm(
  ask: ComposeAsk,
  ctx: ComposeContext,
  input: { mode: ComposeMode; text?: string | null; doc?: Anthropic.ContentBlockParam[] | null }
): Promise<ComposedForm> {
  const json = buildComposeContextJson(ctx, input.text ? { description: input.text } : {})
  const content: ComposeContent = input.doc?.length
    ? [
        ...input.doc,
        {
          type: 'text',
          text: `${input.mode === 'sop' ? 'The process document is above.' : 'The form to rebuild is above.'}${input.text ? ` Admin's note: ${input.text}` : ''}\n\n${json}`
        }
      ]
    : json
  const answer = await ask(COMPOSE_SYSTEM[input.mode], content, 4000)
  return parseComposeAnswer(answer, ctx, input.mode)
}
