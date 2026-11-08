// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyFieldA11y, nameFieldControl } from './field-a11y'

describe('field a11y (army11 f3)', () => {
  it('marks an invalid required input and ties the message to it', () => {
    const input = document.createElement('input')
    input.setAttribute('aria-describedby', 'own-hint')
    applyFieldA11y(input, { required: true, hasError: true, errorId: 'f-error' })
    expect(input.getAttribute('aria-required')).toBe('true')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('own-hint f-error')
    applyFieldA11y(input, { required: true, hasError: false, errorId: 'f-error' })
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.getAttribute('aria-describedby')).toBe('own-hint')
  })
  it("never takes back the control's own aria-invalid", () => {
    const input = document.createElement('input')
    input.setAttribute('aria-invalid', 'true')
    applyFieldA11y(input, { required: false, hasError: false, errorId: 'x' })
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })
  it('a picker button is named after its label and keeps its own text', () => {
    const root = document.createElement('div')
    const btn = document.createElement('button')
    root.appendChild(btn)
    nameFieldControl(root, 'lbl', { required: true, hasError: true, errorId: 'e', describe: false })
    expect(btn.getAttribute('aria-labelledby')).toBe(`lbl ${btn.id}`)
    expect(btn.hasAttribute('aria-required')).toBe(false)
    expect(btn.hasAttribute('aria-describedby')).toBe(false)
    expect(btn.getAttribute('aria-invalid')).toBe('true')
  })
})
