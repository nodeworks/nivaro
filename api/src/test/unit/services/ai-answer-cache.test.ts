import { describe, expect, it } from 'vitest'
import {
  askLocale,
  isDocsOnlyTrace,
  personalAnswerKey,
  sharedAnswerKey
} from '../../../services/ai-answer-cache.js'

// #2455 — the shared answer cache for docs-only questions.

const base = {
  tenant: '',
  docsVersion: 'v1',
  admin: false,
  locale: 'en',
  command: null,
  question: 'How do I add a delegate?'
}

describe('shared answer key (#2455)', () => {
  it('is the same for everyone asking the same question', () => {
    expect(sharedAnswerKey(base)).toBe(
      sharedAnswerKey({ ...base, question: '  how do I   add a DELEGATE? ' })
    )
    expect(sharedAnswerKey(base)).toMatch(/^nvr:aichat:shared:-:[0-9a-f]{40}$/)
  })
  it('moves with the docs index, the audience, the locale, the command and the tenant', () => {
    const k = sharedAnswerKey(base)
    expect(sharedAnswerKey({ ...base, docsVersion: 'v2' })).not.toBe(k)
    expect(sharedAnswerKey({ ...base, admin: true })).not.toBe(k)
    expect(sharedAnswerKey({ ...base, locale: 'fr' })).not.toBe(k)
    expect(sharedAnswerKey({ ...base, command: 'steps' })).not.toBe(k)
    expect(sharedAnswerKey({ ...base, tenant: 't1' })).not.toBe(k)
  })
  it('the personal key is unchanged from #723', () => {
    expect(personalAnswerKey('u1', null, 'Hi  There')).toBe(
      personalAnswerKey('u1', null, 'hi there')
    )
    expect(personalAnswerKey('u1', null, 'x')).not.toBe(personalAnswerKey('u2', null, 'x'))
  })
})

describe('isDocsOnlyTrace', () => {
  it('needs at least one docs search and nothing else', () => {
    expect(isDocsOnlyTrace([{ tool: 'search_docs', summary: '2 docs section(s)' }])).toBe(true)
    expect(isDocsOnlyTrace([])).toBe(false)
    expect(
      isDocsOnlyTrace([
        { tool: 'search_docs', summary: '2 docs section(s)' },
        { tool: 'query_items', summary: '3 of 3 row(s)' }
      ])
    ).toBe(false)
    expect(isDocsOnlyTrace([{ tool: 'page_context', summary: 'record' }])).toBe(false)
    expect(isDocsOnlyTrace([{ tool: 'search_docs', summary: 'error: boom' }])).toBe(false)
  })
})

describe('askLocale', () => {
  it('prefers the saved preference, then the browser, then English', () => {
    expect(askLocale({ locale: 'fr-CA' }, 'de-DE,de;q=0.9')).toBe('fr')
    expect(askLocale(null, 'de-DE,de;q=0.9')).toBe('de')
    expect(askLocale('{"language":"es"}', undefined)).toBe('es')
    expect(askLocale(null, undefined)).toBe('en')
    expect(askLocale(null, '*')).toBe('en')
  })
})
