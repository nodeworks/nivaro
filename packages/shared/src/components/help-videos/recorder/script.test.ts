import { describe, expect, it } from 'vitest'
import { isNextStepKey, parseScript, SCRIPT_LIMITS, scriptText, teleprompterView } from './script'

// Script mode (#1491): the textarea's lines as steps, the Next shortcut and
// what the teleprompter shows.

describe('parseScript', () => {
  it('takes one step per non-empty line, trimmed', () => {
    expect(parseScript('  Open the  record \n\n\r\nPress\tApprove\n ')).toEqual({
      steps: ['Open the record', 'Press Approve'],
      problem: null
    })
  })
  it('is empty for no text', () => {
    expect(parseScript('')).toEqual({ steps: [], problem: null })
    expect(parseScript('\n \n')).toEqual({ steps: [], problem: null })
  })
  it('names too many steps', () => {
    const text = Array.from({ length: SCRIPT_LIMITS.steps + 1 }, (_, i) => `Step ${i}`).join('\n')
    const r = parseScript(text)
    expect(r.steps).toHaveLength(61)
    expect(r.problem).toBe('A script can have up to 60 steps (this one has 61).')
  })
  it('names the first step that is too long', () => {
    const r = parseScript(`ok\n${'x'.repeat(201)}\n${'y'.repeat(300)}`)
    expect(r.problem).toBe('Step 2 is longer than 200 characters.')
    expect(parseScript('x'.repeat(200)).problem).toBeNull()
  })
})

describe('scriptText', () => {
  it('joins the steps, one per line, and is empty for none', () => {
    expect(scriptText(['a', 'b'])).toBe('a\nb')
    expect(scriptText(null)).toBe('')
    expect(scriptText([])).toBe('')
  })
})

describe('isNextStepKey', () => {
  const base = { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false }
  it('is Alt+Shift+N on the physical key or the letter', () => {
    expect(isNextStepKey({ ...base, altKey: true, shiftKey: true, code: 'KeyN' })).toBe(true)
    expect(isNextStepKey({ ...base, altKey: true, shiftKey: true, key: 'N' })).toBe(true)
    expect(isNextStepKey({ ...base, altKey: true, shiftKey: true, key: '˜', code: 'KeyN' })).toBe(
      true
    )
  })
  it('is nothing else', () => {
    expect(isNextStepKey({ ...base, code: 'KeyN' })).toBe(false)
    expect(isNextStepKey({ ...base, altKey: true, code: 'KeyN' })).toBe(false)
    expect(isNextStepKey({ ...base, shiftKey: true, code: 'KeyN' })).toBe(false)
    expect(isNextStepKey({ ...base, ctrlKey: true, shiftKey: true, code: 'KeyN' })).toBe(false)
    expect(isNextStepKey({ ...base, metaKey: true, shiftKey: true, code: 'KeyN' })).toBe(false)
    expect(isNextStepKey({ ...base, altKey: true, shiftKey: true, code: 'KeyM', key: 'M' })).toBe(
      false
    )
    expect(
      isNextStepKey({ ...base, altKey: true, shiftKey: true, code: 'KeyN', repeat: true })
    ).toBe(false)
  })
})

describe('teleprompterView', () => {
  const steps = ['One', 'Two', 'Three']
  it('shows the current step, the next one and the count', () => {
    expect(teleprompterView(steps, 0)).toEqual({
      current: 'One',
      next: 'Two',
      label: 'Step 1 of 3',
      last: false
    })
    expect(teleprompterView(steps, 2)).toEqual({
      current: 'Three',
      next: null,
      label: 'Step 3 of 3',
      last: true
    })
  })
  it('clamps the index and is null without steps', () => {
    expect(teleprompterView(steps, 9)?.current).toBe('Three')
    expect(teleprompterView(steps, -1)?.current).toBe('One')
    expect(teleprompterView([], 0)).toBeNull()
  })
})
