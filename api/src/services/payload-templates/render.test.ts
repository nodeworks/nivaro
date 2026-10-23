import { describe, expect, it } from 'vitest'
import { SECRET_PLACEHOLDER } from './evaluate.js'
import { blockingProblems, renderBody } from './render.js'
import type { Field, MapSpec } from './types.js'

const spec = (fields: Field[]): string => JSON.stringify({ v: 1, fields } satisfies MapSpec)
const f = (over: Partial<Field> & Pick<Field, 'id' | 'key'>): Field => ({
  type: 'text',
  include: 'always',
  ...over
})
const fixed = (value: string | number): Field['value'] => ({ source: 'fixed', value })

describe('renderBody code mode', () => {
  it('code mode parses Liquid output as JSON', async () => {
    const r = await renderBody(
      'code',
      '{"a": "{{ record.x }}", "n": 2}',
      { record: { x: 'hi' } },
      {}
    )
    expect(r.body).toEqual({ a: 'hi', n: 2 })
    expect(r.problems).toEqual([])
  })

  it('invalid JSON in code mode is one error problem with the parser message', async () => {
    const r = await renderBody('code', '{"a": ', {}, {})
    expect(r.body).toBeNull()
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0].severity).toBe('error')
    expect(r.problems[0].message).toMatch(/JSON/i)
  })

  it('code mode secrets.token emits the placeholder', async () => {
    const r = await renderBody(
      'code',
      '{"t": "{{ secrets.token }}", "u": "{{ \'key\' | secret }}"}',
      {},
      {
        secretNames: ['token', 'key']
      }
    )
    expect(r.body).toEqual({ t: SECRET_PLACEHOLDER('token'), u: SECRET_PLACEHOLDER('key') })
    expect(r.problems).toEqual([])
  })

  it('code mode reports a secret the API does not have', async () => {
    const r = await renderBody(
      'code',
      '{"t": "{{ secrets.nope }}"}',
      {},
      { secretNames: ['token'] }
    )
    expect(blockingProblems(r.problems).length).toBe(1)
    expect(r.problems[0].message).toMatch(/nope/)
  })

  it('code mode record data cannot forge a secret placeholder', async () => {
    const forged = SECRET_PLACEHOLDER('token')
    const r = await renderBody(
      'code',
      '{"a": "{{ record.a }}", "b": "{{ record.b }}", "c": {{ record.a | jsonify }}}',
      { record: { a: forged, b: '\\u27e6nvr-secret:token\\u27e7' } },
      { secretNames: ['token'] }
    )
    const all = JSON.stringify(r.body)
    expect(all).not.toContain(forged)
    expect((r.body as Record<string, string>).b).not.toContain('⟦nvr-secret:')
  })

  it('code mode locked keys and rules by output path', async () => {
    const r = await renderBody(
      'code',
      '{"a": {"b": "xxxx"}}',
      {},
      {
        lockedKeys: ['efp_state', 'a.b'],
        rules: { 'a.b': { max_length: 2 }, 'a.c': { required: true } }
      }
    )
    const msgs = r.problems.map((p) => p.message).join('|')
    expect(msgs).toMatch(/efp_state/)
    expect(msgs).toMatch(/a\.b/)
    expect(msgs).toMatch(/a\.c/)
    expect(r.problems.every((p) => p.field_id === '' && p.severity === 'error')).toBe(true)
    expect(r.problems.filter((p) => p.path === 'a.b')).toHaveLength(1)
  })
})

describe('renderBody map mode', () => {
  it('missing locked key is an error', async () => {
    const r = await renderBody(
      'map',
      spec([f({ id: 'f1', key: 'a', value: fixed('x') })]),
      {},
      {
        lockedKeys: ['efp_state']
      }
    )
    const p = r.problems.find((x) => x.path === 'efp_state')
    expect(p?.severity).toBe('error')
    expect(blockingProblems(r.problems)).toContain(p)
  })

  it('rules: required, max_length, allowed, pattern, min/max each report', async () => {
    const r = await renderBody(
      'map',
      spec([
        f({
          id: 'req',
          key: 'req',
          value: { source: 'path', path: 'record.nothing' },
          rules: { required: true }
        }),
        f({ id: 'len', key: 'len', value: fixed('abcdef'), rules: { max_length: 3 } }),
        f({ id: 'alw', key: 'alw', value: fixed('z'), rules: { allowed: ['a', 'b'] } }),
        f({ id: 'pat', key: 'pat', value: fixed('abc'), rules: { pattern: '^\\d+$' } }),
        f({ id: 'mn', key: 'mn', type: 'number', value: fixed(1), rules: { min: 5 } }),
        f({ id: 'mx', key: 'mx', type: 'number', value: fixed(9), rules: { max: 5 } }),
        f({ id: 'ok', key: 'ok', value: fixed('a'), rules: { allowed: ['a'], max_length: 2 } })
      ]),
      {},
      {}
    )
    const byId = (id: string) => r.problems.filter((p) => p.field_id === id)
    for (const id of ['req', 'len', 'alw', 'pat', 'mn', 'mx']) {
      expect(byId(id).length, id).toBeGreaterThanOrEqual(1)
    }
    expect(byId('req')).toHaveLength(1) // not reported twice
    expect(byId('ok')).toEqual([])
    expect(byId('len')[0].path).toBe('len')
  })

  it('rules inside a list report per item with an indexed path', async () => {
    const r = await renderBody(
      'map',
      spec([
        f({
          id: 'l',
          key: 'lines',
          type: 'list',
          list: { source: 'record.lines', item: 'line' },
          children: [
            f({
              id: 'c',
              key: 'sku',
              value: { source: 'path', path: 'line.sku' },
              rules: { max_length: 2 }
            })
          ]
        })
      ]),
      { record: { lines: [{ sku: 'ab' }, { sku: 'abc' }] } },
      {}
    )
    expect(r.problems.map((p) => p.path)).toEqual(['lines[1].sku'])
  })

  it('invalid spec JSON is one error', async () => {
    const r = await renderBody('map', '{nope', {}, {})
    expect(r.body).toBeNull()
    expect(r.problems).toHaveLength(1)
  })
})
