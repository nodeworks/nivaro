import { describe, expect, it } from 'vitest'
import { highlightGraphql, highlightJson } from '../highlight'

describe('highlightGraphql', () => {
  it('classes keywords, operation names, fields, argument names, strings and numbers', () => {
    const t = highlightGraphql(
      'mutation CreateWorkflow {\n  create_workflows_item(data: { name: "x", qty: 3, ok: true }) { id }\n}'
    )
    const kinds = (k: string) => t.filter((x) => x.kind === k).map((x) => x.text)
    expect(kinds('keyword')).toEqual(['mutation'])
    expect(kinds('name')).toEqual(['CreateWorkflow'])
    expect(kinds('field')).toEqual(['create_workflows_item', 'id'])
    expect(kinds('arg')).toEqual(['data', 'name', 'qty', 'ok'])
    expect(kinds('string')).toEqual(['"x"'])
    expect(kinds('number')).toEqual(['3'])
    expect(kinds('bool')).toEqual(['true'])
    expect(t.map((x) => x.text).join('')).toBe(
      'mutation CreateWorkflow {\n  create_workflows_item(data: { name: "x", qty: 3, ok: true }) { id }\n}'
    )
  })
})

describe('highlightJson', () => {
  it('separates keys from string values and keeps the text intact', () => {
    const src = '{\n  "a": "b",\n  "n": 1.5,\n  "z": null\n}'
    const t = highlightJson(src)
    expect(t.filter((x) => x.kind === 'arg').map((x) => x.text)).toEqual(['"a"', '"n"', '"z"'])
    expect(t.filter((x) => x.kind === 'string').map((x) => x.text)).toEqual(['"b"'])
    expect(t.filter((x) => x.kind === 'number').map((x) => x.text)).toEqual(['1.5'])
    expect(t.filter((x) => x.kind === 'bool').map((x) => x.text)).toEqual(['null'])
    expect(t.map((x) => x.text).join('')).toBe(src)
  })
})
