import { type Editor, getHTMLFromFragment } from '@tiptap/react'

/**
 * Co-editing long text (realtime round 3, item 8) — the browser side of the writing session.
 *
 * The protocol is ProseMirror's central-authority collaboration (prosemirror-collab, MIT):
 * every editor keeps the steps it made that the server has not confirmed yet ("unconfirmed"),
 * sends them against the version it last saw, and when steps from others arrive it undoes its
 * own, applies theirs, and re-applies its own mapped over them (`rebaseSteps`). The server
 * (api services/coedit.ts) accepts a batch only at the newest version, so every editor applies
 * the same steps in the same order and lands on the same document. The algorithm is the
 * library's, written here against Tiptap's editor so no new package enters the build.
 *
 * Everything ProseMirror-shaped comes from the editor itself (its state, schema and step
 * classes), never from an import of @tiptap/pm.
 */

export type PMState = Editor['state']
export type PMTransaction = PMState['tr']
export type PMStep = PMTransaction['steps'][number]
export type PMNode = PMState['doc']
export type PMSchema = Editor['schema']
type PMStepMap = ReturnType<PMStep['getMap']>

/** Meta on every transaction this module dispatches: not the person's own typing. */
export const COEDIT_REMOTE = 'nvrCoeditRemote'

/** One unconfirmed step, with its inverse (to undo it while others' steps go under it). */
export interface Rebaseable {
  step: PMStep
  inverted: PMStep
}

export function rebaseable(step: PMStep, docBefore: PMNode): Rebaseable {
  return { step, inverted: step.invert(docBefore) }
}

/**
 * Undo `steps`, apply `over`, re-apply `steps` mapped over them — on `tr`. Returns the steps
 * that still applied (a step whose target others deleted is dropped). prosemirror-collab's
 * rebaseSteps.
 */
export function rebaseSteps(
  steps: Rebaseable[],
  over: readonly PMStep[],
  tr: PMTransaction
): Rebaseable[] {
  for (let i = steps.length - 1; i >= 0; i--) tr.step(steps[i].inverted)
  for (const s of over) tr.step(s)
  const out: Rebaseable[] = []
  let mapFrom = steps.length
  for (const s of steps) {
    const mapped = s.step.map(tr.mapping.slice(mapFrom))
    mapFrom--
    if (mapped && !tr.maybeStep(mapped).failed) {
      // Mapping#setMirror is public at runtime, missing from the typings.
      ;(tr.mapping as unknown as { setMirror(n: number, m: number): void }).setMirror(
        mapFrom,
        tr.steps.length - 1
      )
      out.push({ step: mapped, inverted: mapped.invert(tr.docs[tr.docs.length - 1]) })
    }
  }
  return out
}

// ── The step class, from the editor ──────────────────────────────────────────

// The schema parameter is loose: Tiptap's typings carry two prosemirror-model copies.
type StepClass = { fromJSON(schema: unknown, json: unknown): PMStep }
const stepClasses = new WeakMap<object, StepClass>()

/**
 * `Step` (whose static fromJSON dispatches on `stepType`): the parent class of the step an
 * insert at the end of the document makes. Read once per schema.
 */
export function stepClassOf(state: PMState): StepClass {
  const known = stepClasses.get(state.schema)
  if (known) return known
  const filler = state.schema.topNodeType.contentMatch.defaultType?.createAndFill()
  if (!filler) throw new Error('coedit: the schema has no default block')
  const tr = state.tr.insert(state.doc.content.size, filler)
  const step = tr.steps[0] as object
  const cls = Object.getPrototypeOf(step.constructor) as StepClass
  if (typeof cls?.fromJSON !== 'function') throw new Error('coedit: no step class')
  stepClasses.set(state.schema, cls)
  return cls
}

export function stepFromJSON(state: PMState, json: unknown): PMStep {
  return stepClassOf(state).fromJSON(state.schema, json)
}

/** A transaction over `doc` (not the editor's own document). */
export function transformOn(state: PMState, doc: PMNode): PMTransaction {
  const S = state.constructor as unknown as {
    create(config: { schema: unknown; doc: unknown }): PMState
  }
  return S.create({ schema: state.schema, doc }).tr
}

export interface SessionPayload {
  sid: string
  version: number
  baseVersion: number
  doc: unknown
  steps: Array<{ s: unknown; c: string }>
}

/** The session's current document: its base with every step applied. */
export function sessionDoc(state: PMState, session: SessionPayload): PMNode {
  const base = state.schema.nodeFromJSON(session.doc)
  if (session.steps.length === 0) return base
  const tr = transformOn(state, base)
  for (const s of session.steps) tr.step(stepFromJSON(state, s.s))
  return tr.doc
}

/** The HTML a save of `doc` stores (what `editor.getHTML()` gives for it). */
export function htmlOf(doc: PMNode, schema: PMSchema): string {
  // `never`: Tiptap's typings carry two prosemirror-model copies (one runtime).
  return getHTMLFromFragment(doc.content as never, schema as never)
}

// ── Receiving ────────────────────────────────────────────────────────────────

export interface ReceiveResult {
  tr: PMTransaction | null
  unconfirmed: Rebaseable[]
  version: number
  /** How many of the batch's steps were this editor's own (now confirmed). */
  confirmed: number
  /** The map of each version the batch moved through, in order (cursor mapping). */
  maps: PMStepMap[]
}

/**
 * Take a batch of confirmed steps that starts at `version` (= the editor's). Own steps at the
 * head confirm unconfirmed ones; the rest are applied under the unconfirmed ones (rebased).
 * prosemirror-collab's receiveTransaction.
 */
export function receiveSteps(
  state: PMState,
  unconfirmed: Rebaseable[],
  version: number,
  steps: PMStep[],
  clientIDs: string[],
  myID: string
): ReceiveResult {
  let ours = 0
  while (ours < clientIDs.length && clientIDs[ours] === myID && ours < unconfirmed.length) ours++
  const maps: PMStepMap[] = []
  for (let i = 0; i < steps.length; i++)
    maps.push(i < ours ? unconfirmed[i].step.getMap() : steps[i].getMap())
  let rest = unconfirmed.slice(ours)
  const theirs = steps.slice(ours)
  const nextVersion = version + steps.length
  if (theirs.length === 0) {
    return { tr: null, unconfirmed: rest, version: nextVersion, confirmed: ours, maps }
  }
  const tr = state.tr
  const n = rest.length
  if (n) rest = rebaseSteps(rest, theirs, tr)
  else for (const s of theirs) tr.step(s)
  tr.setMeta(COEDIT_REMOTE, true)
  tr.setMeta('addToHistory', false)
  // prosemirror-history rebases its own entries over a rebased transaction.
  if (n) tr.setMeta('rebased', n)
  return { tr, unconfirmed: rest, version: nextVersion, confirmed: ours, maps }
}

/** The document without the unconfirmed steps (what the server holds at `version`). */
export function confirmedDoc(state: PMState, unconfirmed: Rebaseable[]): PMNode {
  if (unconfirmed.length === 0) return state.doc
  const tr = state.tr
  for (let i = unconfirmed.length - 1; i >= 0; i--) tr.step(unconfirmed[i].inverted)
  return tr.doc
}

/** A random editor id (one per mounted editor). */
export function newClientId(): string {
  const a = Math.random().toString(36).slice(2, 10)
  const b = Date.now().toString(36).slice(-6)
  return `e${a}${b}`
}
