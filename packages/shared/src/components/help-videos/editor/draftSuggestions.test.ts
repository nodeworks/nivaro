import { describe, expect, it } from 'vitest'
import type { Annotation, DraftSuggestion, HelpVideoContext, VideoEdits } from '../types'
import {
  applyDraftSuggestion,
  describeSuggestion,
  isSuggestionApplied,
  withContext
} from './draftSuggestions'

const edits: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 }],
  poster_ms: 0,
  chapters: [{ id: 'c1', at_ms: 5000, title: 'Have' }],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
}
const callout: Annotation = {
  id: 'a1',
  type: 'callout',
  start_ms: 8000,
  end_ms: 11_000,
  rect: { x: 0.5, y: 0.5, w: 0.28, h: 0.1 },
  to: null,
  text: 'Click Approve',
  tone: 'accent'
}
const contexts: HelpVideoContext[] = [{ kind: 'collection', key: 'orders', state_key: null }]
const video = { title: 'Untitled video', description: null, contexts }

describe('applyDraftSuggestion', () => {
  it('adds a chapter through the checked upsert, sorted, and refuses one already there', () => {
    const r = applyDraftSuggestion(
      { id: 'chapter:1200', kind: 'chapter', chapter: { id: 'n1', at_ms: 1200, title: 'Start' } },
      edits,
      contexts
    )
    expect(r.how).toBe('edits')
    expect(r.how === 'edits' && r.edits.chapters.map((c) => c.id)).toEqual(['n1', 'c1'])
    const near = applyDraftSuggestion(
      { id: 'chapter:5200', kind: 'chapter', chapter: { id: 'n2', at_ms: 5200, title: 'Dup' } },
      edits,
      contexts
    )
    expect(near).toEqual({ how: 'refused', refused: 'A chapter already starts here' })
  })
  it('adds a callout as an annotation and refuses one the limits reject', () => {
    const r = applyDraftSuggestion(
      { id: 'callout:1', kind: 'callout', annotation: callout, click_index: 1 },
      edits,
      contexts
    )
    expect(r.how === 'edits' && r.edits.annotations).toEqual([callout])
    const short = applyDraftSuggestion(
      {
        id: 'callout:2',
        kind: 'callout',
        annotation: { ...callout, id: 'a2', end_ms: 8100 },
        click_index: 2
      },
      edits,
      contexts
    )
    expect(short.how).toBe('refused')
  })
  it('hands a title or description back as a details patch', () => {
    expect(
      applyDraftSuggestion({ id: 'title', kind: 'title', text: 'T' }, edits, contexts)
    ).toEqual({
      how: 'details',
      patch: { title: 'T' }
    })
    expect(
      applyDraftSuggestion({ id: 'description', kind: 'description', text: 'D' }, edits, contexts)
    ).toEqual({
      how: 'details',
      patch: { description: 'D' }
    })
  })
  it('hands a context back as the new context list', () => {
    const r = applyDraftSuggestion(
      {
        id: 'x',
        kind: 'context',
        context: { kind: 'page', key: 'settings', state_key: null },
        label: 'Settings'
      },
      edits,
      contexts
    )
    expect(r).toEqual({
      how: 'contexts',
      contexts: [...contexts, { kind: 'page', key: 'settings', state_key: null }]
    })
  })
})

describe('withContext', () => {
  it('adds a page once and a collection once', () => {
    const page: HelpVideoContext = { kind: 'page', key: 'p', state_key: null }
    const once = withContext(contexts, page)
    expect(withContext(once, page)).toBe(once)
    expect(withContext(contexts, { kind: 'collection', key: 'orders', state_key: null })).toBe(
      contexts
    )
    expect(withContext(contexts, { kind: 'collection', key: 'invoices', state_key: null })).toEqual(
      [...contexts, { kind: 'collection', key: 'invoices', state_key: null }]
    )
  })
  it('turns a step on for its collection, listing the collection first when needed', () => {
    const step: HelpVideoContext = { kind: 'collection', key: 'orders', state_key: 'approval' }
    const r = withContext(contexts, step)
    expect(r).toEqual([step])
    expect(withContext(r, step)).toBe(r)
    expect(withContext([], step)).toEqual([step])
    expect(withContext(r, { kind: 'collection', key: 'orders', state_key: 'draft' })).toEqual([
      step,
      { kind: 'collection', key: 'orders', state_key: 'draft' }
    ])
  })
})

describe('isSuggestionApplied', () => {
  it('reads what is already in place as done', () => {
    const chapter: DraftSuggestion = {
      id: 'c',
      kind: 'chapter',
      chapter: { id: 'n', at_ms: 5100, title: 'x' }
    }
    expect(isSuggestionApplied(chapter, edits, video)).toBe(true)
    expect(
      isSuggestionApplied(
        { ...chapter, chapter: { id: 'n', at_ms: 9000, title: 'x' } },
        edits,
        video
      )
    ).toBe(false)
    const co: DraftSuggestion = { id: 'co', kind: 'callout', annotation: callout, click_index: 0 }
    expect(isSuggestionApplied(co, edits, video)).toBe(false)
    expect(isSuggestionApplied(co, { ...edits, annotations: [callout] }, video)).toBe(true)
    expect(
      isSuggestionApplied({ id: 't', kind: 'title', text: 'Untitled video' }, edits, video)
    ).toBe(true)
    expect(isSuggestionApplied({ id: 'd', kind: 'description', text: 'D' }, edits, video)).toBe(
      false
    )
    expect(
      isSuggestionApplied(
        {
          id: 'x',
          kind: 'context',
          context: { kind: 'collection', key: 'orders', state_key: null },
          label: 'Orders'
        },
        edits,
        video
      )
    ).toBe(true)
    expect(
      isSuggestionApplied(
        {
          id: 'x',
          kind: 'context',
          context: { kind: 'collection', key: 'orders', state_key: 'approval' },
          label: 'Orders'
        },
        edits,
        video
      )
    ).toBe(false)
  })
})

describe('describeSuggestion', () => {
  it('names the kind and the content', () => {
    expect(
      describeSuggestion({
        id: 'c',
        kind: 'chapter',
        chapter: { id: 'n', at_ms: 65_000, title: 'Go' }
      })
    ).toEqual({
      kind: 'Chapter',
      text: 'Go',
      at: 65_000
    })
    expect(
      describeSuggestion({
        id: 'x',
        kind: 'context',
        context: { kind: 'page', key: 'p', state_key: null },
        label: 'Settings'
      })
    ).toEqual({ kind: 'Page', text: 'Settings' })
  })
})
