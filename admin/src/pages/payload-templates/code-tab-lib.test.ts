import { describe, expect, it } from 'vitest'
import { parseSpecText } from './code-tab-lib'

describe('parseSpecText', () => {
  it('accepts a minimal field map', () => {
    const r = parseSpecText(
      '{"v":1,"fields":[{"id":"a","key":"x","type":"text","include":"always"}]}'
    )
    expect(r.ok).toBe(true)
  })

  it('names the line of a JSON syntax error', () => {
    const r = parseSpecText('{\n  "v": 1,\n  "fields": [,]\n}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/^Line 3, column \d+: this isn't valid JSON/)
  })

  it('refuses shapes the field map cannot show', () => {
    expect(parseSpecText('[]')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/JSON object/)
    })
    expect(parseSpecText('{"v":2,"fields":[]}')).toMatchObject({
      ok: false,
      message: 'The field map needs "v": 1'
    })
    expect(parseSpecText('{"v":1,"fields":{}}')).toMatchObject({
      ok: false,
      message: 'fields must be a list'
    })
    expect(
      parseSpecText(
        '{"v":1,"fields":[{"id":"a","key":"k","type":"object","children":[{"key":"z","type":"text"}]}]}'
      )
    ).toMatchObject({ ok: false, message: 'fields[0].children[0] needs an "id" (text)' })
  })
})
