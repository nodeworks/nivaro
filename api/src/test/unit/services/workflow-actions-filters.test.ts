import { Liquid } from 'liquidjs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/integration-remediation.js', () => ({
  classifyError: vi.fn(() => 'unknown')
}))

import { registerPayloadFilters } from '../../../services/workflow-actions.js'

const engine = new Liquid({ strictFilters: false, strictVariables: false })
registerPayloadFilters(engine)
const render = (tpl: string, scope: Record<string, unknown> = {}) =>
  engine.parseAndRender(tpl, scope)

describe('payload template filters — pad_start', () => {
  it('left-pads a short numeric string to the requested width', async () => {
    expect(await render("{{ v | pad_start: 9, '0' }}", { v: '106416' })).toBe('000106416')
  })

  it('defaults the fill character to 0', async () => {
    expect(await render('{{ v | pad_start: 9 }}', { v: '106416' })).toBe('000106416')
  })

  it('returns already-wide input unchanged', async () => {
    expect(await render('{{ v | pad_start: 9 }}', { v: '000106416' })).toBe('000106416')
    expect(await render('{{ v | pad_start: 9 }}', { v: 'abcdefghij' })).toBe('abcdefghij')
  })

  it('renders a missing value as an empty string, never a padded "null"', async () => {
    expect(await render('{{ v | pad_start: 9 }}', {})).toBe('')
    expect(await render('{{ v | pad_start: 9 }}', { v: null })).toBe('')
  })

  it('pads numbers and trims whitespace before measuring', async () => {
    expect(await render('{{ v | pad_start: 5 }}', { v: 42 })).toBe('00042')
    expect(await render('{{ v | pad_start: 5 }}', { v: '  42 ' })).toBe('00042')
  })

  it('uses only the first character of a multi-character fill', async () => {
    expect(await render("{{ v | pad_start: 3, 'xy' }}", { v: '7' })).toBe('xx7')
  })

  it('leaves the value alone when the width is not a number', async () => {
    expect(await render("{{ v | pad_start: 'nine' }}", { v: '7' })).toBe('7')
  })
})

describe('payload template filters — the pre-existing set still registers', () => {
  it('jsonify renders a missing value as null and strings quoted', async () => {
    expect(await render('{{ v | jsonify }}', {})).toBe('null')
    expect(await render('{{ v | jsonify }}', { v: 'a"b' })).toBe('"a\\"b"')
  })

  it('add_days on a missing variable counts from today', async () => {
    const expected = new Date()
    expected.setDate(expected.getDate() + 60)
    const iso = expected.toISOString().slice(0, 10)
    expect(await render('{{ missing | add_days: 60 }}')).toBe(iso)
    // The idiom for "today + N" in a template: LiquidJS's `nil` literal hands a
    // filter an internal Nil object (not null), so `{{ nil | add_days: 60 }}`
    // renders EMPTY — start from `'now' | date` instead.
    expect(await render("{{ 'now' | date: '%Y-%m-%d' | add_days: 60 }}")).toBe(iso)
    expect(await render('{{ nil | add_days: 60 }}')).toBe('')
  })
})
