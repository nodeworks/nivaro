import { describe, expect, it } from 'vitest'
import {
  AI_MEMORY_MAX_CHARS,
  AI_MEMORY_MAX_NOTES,
  memoryFromPreferences,
  memoryPromptBlock,
  normalizeAiMemory,
  parseRememberCommand
} from '../../../services/ai-memory.js'

describe('parseRememberCommand (#1804)', () => {
  it('takes the note out of "remember that …" and its variants', () => {
    expect(parseRememberCommand('remember that I work Zone 3 inventory requests')).toBe(
      'I work Zone 3 inventory requests'
    )
    expect(parseRememberCommand('Please remember: amounts in thousands.')).toBe(
      'amounts in thousands'
    )
    expect(parseRememberCommand('Remember, my region is East')).toBe('my region is East')
  })

  it('never swallows a question', () => {
    expect(parseRememberCommand('Do you remember what I asked?')).toBeNull()
    expect(parseRememberCommand('remember what my zone is?')).toBeNull()
    expect(parseRememberCommand('How many workflows are open?')).toBeNull()
    expect(parseRememberCommand('remember')).toBeNull()
  })

  it('caps the note length', () => {
    const long = `remember that ${'x'.repeat(AI_MEMORY_MAX_CHARS + 50)}`
    expect(parseRememberCommand(long)?.length).toBe(AI_MEMORY_MAX_CHARS)
  })
})

describe('normalizeAiMemory', () => {
  it('accepts strings and notes, drops blanks and duplicates, keeps ids', () => {
    const r = normalizeAiMemory([
      'amounts in thousands',
      { id: 'n1', text: '  Zone 3  ', at: '2026-10-01T00:00:00Z' },
      { text: 'AMOUNTS IN THOUSANDS' },
      { text: '   ' }
    ])
    expect('value' in r && r.value?.map((n) => n.text)).toEqual(['amounts in thousands', 'Zone 3'])
    expect('value' in r && r.value?.[1].id).toBe('n1')
  })

  it('null and an empty list clear it', () => {
    expect(normalizeAiMemory(null)).toEqual({ value: null })
    expect(normalizeAiMemory([])).toEqual({ value: null })
  })

  it('refuses too many notes, an over-long note and a non-list', () => {
    expect(
      normalizeAiMemory(Array.from({ length: AI_MEMORY_MAX_NOTES + 1 }, (_, i) => `n${i}`))
    ).toHaveProperty('error')
    expect(normalizeAiMemory(['y'.repeat(AI_MEMORY_MAX_CHARS + 1)])).toHaveProperty('error')
    expect(normalizeAiMemory('remember me')).toHaveProperty('error')
  })
})

describe('memoryFromPreferences + memoryPromptBlock', () => {
  it('reads string or object preferences and tolerates junk', () => {
    expect(memoryFromPreferences(JSON.stringify({ ai_memory: ['Zone 3'] }))[0].text).toBe('Zone 3')
    expect(memoryFromPreferences({ ai_memory: 'nope' })).toEqual([])
    expect(memoryFromPreferences('{bad json')).toEqual([])
    expect(memoryFromPreferences(null)).toEqual([])
  })

  it('is empty without notes and says the notes grant nothing', () => {
    expect(memoryPromptBlock([])).toBe('')
    const block = memoryPromptBlock([{ id: 'a', text: 'amounts in thousands', at: '' }])
    expect(block).toContain('- amounts in thousands')
    expect(block).toContain('never grant access')
  })
})
