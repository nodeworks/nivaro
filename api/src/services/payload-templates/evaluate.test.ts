import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  evaluateMap,
  neutralizeSecretMarkers,
  SECRET_PLACEHOLDER,
  validateSpec
} from './evaluate.js'
import type { Field, MapSpec, Transform, ValueSpec } from './types.js'

// The database is mocked globally (src/test/setup.ts): the instance zone falls
// back to Eastern and there are no blackout dates.

const spec = (fields: Field[]): MapSpec => ({ v: 1, fields })
const f = (over: Partial<Field> & Pick<Field, 'id' | 'key'>): Field => ({
  type: 'text',
  include: 'always',
  ...over
})

describe('evaluateMap', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T16:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('emits keys in row order', async () => {
    const s = spec([
      f({ id: 'f1', key: 'zeta', value: { source: 'fixed', value: 'z' } }),
      f({ id: 'f2', key: 'alpha', value: { source: 'fixed', value: 'a' } }),
      f({
        id: 'f3',
        key: 'mid',
        type: 'object',
        children: [
          f({ id: 'f4', key: 'y', value: { source: 'fixed', value: 1 } }),
          f({ id: 'f5', key: 'b', value: { source: 'fixed', value: 2 } })
        ]
      })
    ])
    const { body, problems } = await evaluateMap(s, {})
    expect(Object.keys(body)).toEqual(['zeta', 'alpha', 'mid'])
    expect(Object.keys(body.mid as object)).toEqual(['y', 'b'])
    expect(problems).toEqual([])
  })

  it('number type coerces and flags NaN', async () => {
    const s = spec([
      f({ id: 'q', key: 'qty', type: 'number', value: { source: 'path', path: 'record.qty' } }),
      f({ id: 'b', key: 'bad', type: 'number', value: { source: 'path', path: 'record.bad' } })
    ])
    const { body, problems, values } = await evaluateMap(s, { record: { qty: '12', bad: 'abc' } })
    expect(body.qty).toBe(12)
    expect(values.q).toBe(12)
    expect(body.bad).toBeNull()
    expect(problems).toEqual([
      {
        field_id: 'b',
        path: 'bad',
        message: "Number expected, got 'abc'",
        severity: 'error',
        code: 'type_number',
        params: { got: 'abc', source: 'record.bad' }
      }
    ])
  })

  it('include not_empty drops null, empty string and empty list', async () => {
    const s = spec([
      f({ id: 'a', key: 'a', include: 'not_empty', value: { source: 'path', path: 'record.n' } }),
      f({ id: 'b', key: 'b', include: 'not_empty', value: { source: 'fixed', value: '' } }),
      f({
        id: 'c',
        key: 'c',
        type: 'list',
        include: 'not_empty',
        list: { source: 'record.none', item: 'line', scalar: true },
        children: [f({ id: 'c1', key: 'v' })]
      }),
      f({ id: 'd', key: 'd', include: 'not_empty', value: { source: 'fixed', value: 'kept' } }),
      f({ id: 'e', key: 'e', value: { source: 'path', path: 'record.n' } })
    ])
    const { body, problems } = await evaluateMap(s, { record: { n: null, none: [] } })
    expect(body).toEqual({ d: 'kept', e: null })
    expect(problems).toEqual([])
  })

  it('list numbers items after the where filter', async () => {
    const s = spec([
      f({
        id: 'l',
        key: 'lines',
        type: 'list',
        list: {
          source: 'context.materials',
          item: 'line',
          where: [{ field: 'quantity', op: 'gt', value: 0 }]
        },
        children: [
          f({
            id: 'n',
            key: 'orderLineNumber',
            type: 'number',
            value: { source: 'builtin', name: 'list.number' }
          }),
          f({
            id: 'q',
            key: 'quantity',
            type: 'number',
            value: { source: 'path', path: 'line.quantity' }
          })
        ]
      })
    ])
    const scope = { context: { materials: [{ quantity: 2 }, { quantity: 0 }, { quantity: 3 }] } }
    const { body, values } = await evaluateMap(s, scope)
    const lines = body.lines as Array<Record<string, unknown>>
    expect(lines.map((l) => l.orderLineNumber)).toEqual([1, 2])
    expect(lines.map((l) => l.quantity)).toEqual([2, 3])
    expect(values.n).toBe(1)
    expect(values.q).toBe(2)
    // dotted rule fields read the alias too
    const dotted = structuredClone(s)
    dotted.fields[0].list!.where = [{ field: 'line.quantity', op: 'gt', value: 2 }]
    const r2 = await evaluateMap(dotted, scope)
    expect((r2.body.lines as unknown[]).length).toBe(1)
  })

  it('scalar list builds a plain array', async () => {
    const s = spec([
      f({
        id: 'e',
        key: 'notificationEmails',
        type: 'list',
        list: { source: 'context.emails', item: 'email', scalar: true },
        children: [f({ id: 'e1', key: 'email' })]
      }),
      f({
        id: 'u',
        key: 'upperEmails',
        type: 'list',
        list: { source: 'context.emails', item: 'email', scalar: true },
        children: [
          f({
            id: 'u1',
            key: 'email',
            value: { source: 'path', path: 'email', transforms: [{ op: 'upper' }] }
          })
        ]
      })
    ])
    const { body, values } = await evaluateMap(s, { context: { emails: ['a@x.com', 'b@x.com'] } })
    expect(body.notificationEmails).toEqual(['a@x.com', 'b@x.com'])
    expect(body.upperEmails).toEqual(['A@X.COM', 'B@X.COM'])
    expect(values.e1).toBe('a@x.com')
  })

  it('switch picks the first matching case else the fallback', async () => {
    const s = spec([
      f({
        id: 's',
        key: 'account',
        value: {
          source: 'switch',
          cases: [
            {
              when: [{ field: 'record.cost_type', op: 'eq', value: 'Capital' }],
              value: { source: 'fixed', value: '1000' }
            },
            {
              when: [{ field: 'record.cost_type', op: 'eq', value: 'Capital' }],
              value: { source: 'fixed', value: 'never' }
            }
          ],
          else: { source: 'fixed', value: '2000' }
        }
      })
    ])
    expect((await evaluateMap(s, { record: { cost_type: 'Capital' } })).body.account).toBe('1000')
    expect((await evaluateMap(s, { record: { cost_type: 'Expense' } })).body.account).toBe('2000')
  })

  it('fallbacks take the first non-empty', async () => {
    const s = spec([
      f({
        id: 'm',
        key: 'email',
        value: {
          source: 'path',
          path: 'record.creator.email',
          fallbacks: [
            { source: 'builtin', name: 'acting_user.email' },
            { source: 'path', path: 'context.contact_email' }
          ]
        }
      })
    ])
    const base = { context: { contact_email: 'contact@x.com' } }
    const r1 = await evaluateMap(s, {
      ...base,
      record: { creator: { email: 'creator@x.com' } },
      acting_user: { email: 'me@x.com' }
    })
    expect(r1.body.email).toBe('creator@x.com')
    const r2 = await evaluateMap(s, {
      ...base,
      record: { creator: null },
      acting_user: { email: 'me@x.com' }
    })
    expect(r2.body.email).toBe('me@x.com')
    // a fallback that wins hides the primary's missing-parent note
    expect(r2.problems).toEqual([])
    const r3 = await evaluateMap(s, { ...base, record: { creator: { email: '' } } })
    expect(r3.body.email).toBe('contact@x.com')
  })

  it('transforms apply in order', async () => {
    const s = spec([
      f({
        id: 't',
        key: 'item',
        value: {
          source: 'path',
          path: 'record.sku',
          transforms: [
            { op: 'trim' },
            { op: 'truncate', n: 150 },
            { op: 'prefix', text: 'US' },
            { op: 'pad_start', n: 9, char: '0' }
          ]
        }
      }),
      f({
        id: 'd',
        key: 'desc',
        value: { source: 'path', path: 'record.desc', transforms: [{ op: 'truncate', n: 150 }] }
      }),
      f({
        id: 'r',
        key: 'needBy',
        type: 'date',
        value: {
          source: 'path',
          path: 'record.need_by',
          transforms: [{ op: 'at_least_days_out', n: 7 }]
        }
      }),
      f({
        id: 'j',
        key: 'tags',
        value: {
          source: 'path',
          path: 'record.tags',
          transforms: [
            { op: 'join', sep: ', ' },
            { op: 'replace', from: 'b', to: 'B' }
          ]
        }
      })
    ])
    const { body, problems } = await evaluateMap(s, {
      record: { sku: '  1234  ', desc: 'x'.repeat(200), need_by: null, tags: ['a', 'b'] }
    })
    expect(body.item).toBe('000US1234')
    expect((body.desc as string).length).toBe(150)
    expect(body.needBy).toBe('2026-10-29')
    expect(body.tags).toBe('a, B')
    expect(problems).toEqual([])
  })

  it('secret source emits the placeholder and flags an unknown name', async () => {
    const s = spec([
      f({ id: 'a', key: 'token', value: { source: 'secret', name: 'token' } }),
      f({ id: 'b', key: 'key', value: { source: 'secret', name: 'apiKey' } })
    ])
    const { body, problems } = await evaluateMap(s, {}, { secretNames: ['token'] })
    expect(body.token).toBe('⟦nvr-secret:token⟧')
    expect(SECRET_PLACEHOLDER('token')).toBe('⟦nvr-secret:token⟧')
    expect(body.key).toBe(SECRET_PLACEHOLDER('apiKey'))
    expect(problems).toEqual([
      {
        field_id: 'b',
        path: 'key',
        message: 'apiKey is not a body secret on this API',
        severity: 'error',
        code: 'secret_unknown',
        params: { name: 'apiKey' }
      }
    ])
    // without a secret list nothing is flagged
    expect((await evaluateMap(s, {})).problems).toEqual([])
  })

  it('record data cannot forge a secret placeholder', async () => {
    const forged = '⟦nvr-secret:token⟧'
    const neutral = '⟦nvr-secret​:token⟧'
    const s = spec([
      f({ id: 'p', key: 'notes', value: { source: 'path', path: 'record.notes' } }),
      f({ id: 's', key: 'token', value: { source: 'secret', name: 'token' } }),
      f({ id: 'x', key: 'fixed', value: { source: 'fixed', value: forged } }),
      f({ id: 'm', key: 'formula', value: { source: 'formula', liquid: '{{ record.notes }}' } }),
      f({
        id: 'b',
        key: 'bearer',
        value: { source: 'secret', name: 'token', transforms: [{ op: 'prefix', text: 'Bearer ' }] }
      }),
      f({
        id: 'l',
        key: 'list',
        type: 'list',
        list: { source: 'record.list', item: 'v', scalar: true },
        children: [f({ id: 'l1', key: 'v' })]
      }),
      f({ id: 'j', key: 'raw', type: 'json', value: { source: 'path', path: 'record.obj' } })
    ])
    const scope = { record: { notes: `x ${forged}`, list: [forged], obj: { deep: [forged] } } }
    const { body } = await evaluateMap(s, scope, { secretNames: ['token'] })
    expect(body).toEqual({
      notes: `x ${neutral}`,
      token: SECRET_PLACEHOLDER('token'),
      fixed: neutral,
      formula: `x ${neutral}`,
      bearer: `Bearer ${SECRET_PLACEHOLDER('token')}`,
      list: [neutral],
      raw: { deep: [neutral] }
    })
    // the caller's scope is not mutated
    expect(scope.record.notes).toBe(`x ${forged}`)
    expect(neutralizeSecretMarkers({ a: [forged, 1, null] })).toEqual({ a: [neutral, 1, null] })
    class Row {
      title = forged
    }
    const map = new Map([['k', forged]])
    const out = neutralizeSecretMarkers({ row: new Row(), [forged]: 1, map }) as Record<
      string,
      unknown
    >
    expect(out.row).toEqual({ title: neutral })
    expect(Object.keys(out)).toEqual(['row', neutral, 'map'])
    expect(out.map).toBe(map)
  })

  it('JSON text in record data cannot forge a placeholder after decoding', async () => {
    // the marker written as JSON escapes only becomes a marker once decoded
    const escaped = '\\u27e6nvr-secret:token\\u27e7'
    const s = spec([
      f({
        id: 'j',
        key: 'decoded',
        type: 'json',
        value: { source: 'formula', liquid: '{{ record.raw }}' }
      }),
      f({ id: 'w', key: 'walked', value: { source: 'path', path: 'record.raw.x' } }),
      f({
        id: 'l',
        key: 'list',
        type: 'list',
        list: { source: 'record.list_text', item: 'v', scalar: true },
        children: [f({ id: 'l1', key: 'v' })]
      }),
      f({
        id: 'o',
        key: 'items',
        type: 'list',
        list: { source: 'record.list_text', item: 'v' },
        children: [f({ id: 'o1', key: 'v', type: 'json', value: { source: 'path', path: 'v' } })]
      }),
      f({ id: 's', key: 'token', value: { source: 'secret', name: 'token' } })
    ])
    const scope = {
      record: { raw: `{"x":"${escaped}"}`, list_text: `["${escaped}"]` }
    }
    const { body, values } = await evaluateMap(s, scope, { secretNames: ['token'] })
    const neutral = '⟦nvr-secret​:token⟧'
    expect(body.decoded).toEqual({ x: neutral })
    expect(body.walked).toBe(neutral)
    expect(body.list).toEqual([neutral])
    expect(body.items).toEqual([{ v: neutral }])
    expect(body.token).toBe(SECRET_PLACEHOLDER('token'))
    const json = JSON.stringify(body)
    expect(json.split(SECRET_PLACEHOLDER('token')).length - 1).toBe(1)
    expect(values.s).toBe(SECRET_PLACEHOLDER('token'))
    expect(values.l1).toBe(neutral)
  })

  it('a list item column shadows a top-level scope key of the same name', async () => {
    const s = spec([
      f({
        id: 'l',
        key: 'lines',
        type: 'list',
        list: {
          source: 'context.lines',
          item: 'line',
          where: [{ field: 'state', op: 'eq', value: 'open' }]
        },
        children: [
          f({ id: 'st', key: 'state', value: { source: 'path', path: 'state' } }),
          f({ id: 'top', key: 'label', value: { source: 'builtin', name: 'state.label' } })
        ]
      })
    ])
    const { body } = await evaluateMap(s, {
      state: { label: 'Approved' },
      context: { lines: [{ state: 'open' }, { state: 'closed' }] }
    })
    expect(body.lines).toEqual([{ state: 'open', label: 'Approved' }])
  })

  it('fallbacks are judged after the row transforms', async () => {
    const s = spec([
      f({
        id: 'a',
        key: 'name',
        value: {
          source: 'path',
          path: 'record.name',
          transforms: [{ op: 'trim' }, { op: 'upper' }],
          fallbacks: [{ source: 'path', path: 'record.alt' }]
        }
      })
    ])
    const { body } = await evaluateMap(s, { record: { name: '   ', alt: ' bob ' } })
    expect(body.name).toBe('BOB')
  })

  it('more transforms: next_open_day, editor_text, add_days, date, lower, suffix', async () => {
    const v = (path: string, transforms: Transform[]): ValueSpec => ({
      source: 'path',
      path,
      transforms
    })
    const s = spec([
      f({ id: 'a', key: 'open', value: v('record.sat', [{ op: 'next_open_day' }]) }),
      f({ id: 'b', key: 'notes', value: v('record.doc', [{ op: 'editor_text' }]) }),
      f({ id: 'c', key: 'later', value: v('record.day', [{ op: 'add_days', n: 10 }]) }),
      f({ id: 'd', key: 'us', value: v('record.day', [{ op: 'date', format: '%m/%d/%Y' }]) }),
      f({
        id: 'e',
        key: 'mail',
        value: v('record.mail', [{ op: 'lower' }, { op: 'suffix', text: '>' }])
      }),
      f({ id: 'g', key: 'none', value: v('record.missing', [{ op: 'suffix', text: '!' }]) })
    ])
    const doc = JSON.stringify({ blocks: [{ data: { text: 'Hi <b>there</b>' } }] })
    const { body, problems } = await evaluateMap(s, {
      record: { sat: '2026-10-24', doc, day: '2026-10-22', mail: 'A@X.COM' }
    })
    expect(body).toEqual({
      open: '2026-10-26',
      notes: 'Hi there',
      later: '2026-11-01',
      us: '10/22/2026',
      mail: 'a@x.com>',
      // null skips the transforms on purpose
      none: null
    })
    expect(problems).toEqual([])
  })

  it('warns on array-index keys and keeps a __proto__ key as data', async () => {
    const s = spec([
      f({ id: 'a', key: '10', value: { source: 'fixed', value: 1 } }),
      f({ id: 'b', key: '4294967294', value: { source: 'fixed', value: 2 } }),
      f({ id: 'c', key: '4294967295', value: { source: 'fixed', value: 3 } }),
      f({ id: 'd', key: '__proto__', value: { source: 'fixed', value: 'x' } })
    ])
    const { body, problems } = await evaluateMap(s, {})
    expect(problems.map((p) => p.field_id)).toEqual(['a', 'b'])
    expect(problems[0].severity).toBe('warning')
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype)
    expect(Object.hasOwn(body, '__proto__')).toBe(true)
    expect(JSON.parse(JSON.stringify(body)).__proto__).toBe('x')
  })

  it('sorts with missing keys last in either direction', async () => {
    const items = [{ id: 1, k: null }, { id: 2, k: 'b' }, { id: 3 }, { id: 4, k: 'a' }]
    const mk = (sort: string) =>
      spec([
        f({
          id: 'l',
          key: 'ids',
          type: 'list',
          list: { source: 'record.items', item: 'line', scalar: true, sort },
          children: [
            f({ id: 'c', key: 'id', type: 'number', value: { source: 'path', path: 'line.id' } })
          ]
        })
      ])
    expect((await evaluateMap(mk('k'), { record: { items } })).body.ids).toEqual([4, 2, 1, 3])
    expect((await evaluateMap(mk('-line.k'), { record: { items } })).body.ids).toEqual([2, 4, 1, 3])
  })

  it('a string list source holding JSON text is a list', async () => {
    const s = spec([
      f({
        id: 'l',
        key: 'pos',
        type: 'list',
        list: { source: 'record.po_numbers', item: 'po', scalar: true },
        children: [f({ id: 'c', key: 'po' })]
      }),
      f({
        id: 'm',
        key: 'bad',
        type: 'list',
        list: { source: 'record.word', item: 'po', scalar: true },
        children: [f({ id: 'c2', key: 'po' })]
      })
    ])
    const { body, problems } = await evaluateMap(s, {
      record: { po_numbers: '["PO1","PO2"]', word: 'PO1' }
    })
    expect(body).toEqual({ pos: ['PO1', 'PO2'], bad: [] })
    expect(problems).toEqual([
      {
        field_id: 'm',
        path: 'bad',
        message: 'record.word is not a list',
        severity: 'error',
        code: 'list_not_list',
        params: { source: 'record.word', got: 'PO1' }
      }
    ])
  })

  it('missing related rows resolve to null with a problem', async () => {
    const s = spec([
      f({
        id: 'org',
        key: 'inventoryOrg',
        value: { source: 'path', path: 'context.shipping_location.inventory_org' }
      }),
      f({
        id: 'link',
        key: 'mwfId',
        rules: { required: true },
        value: { source: 'path', path: 'context.mwf_link[0].id' }
      }),
      f({ id: 'plain', key: 'notes', value: { source: 'path', path: 'record.notes' } }),
      f({
        id: 'lst',
        key: 'lines',
        type: 'list',
        list: { source: 'context.lines', item: 'line' },
        children: [f({ id: 'x', key: 'x', value: { source: 'path', path: 'line.x' } })]
      })
    ])
    const scope = { record: { notes: null }, context: { shipping_location: null, mwf_link: [] } }
    const { body, problems } = await evaluateMap(s, scope)
    expect(body).toEqual({ inventoryOrg: null, mwfId: null, notes: null, lines: [] })
    expect(problems).toEqual([
      {
        field_id: 'org',
        path: 'inventoryOrg',
        message: 'context.shipping_location.inventory_org has no value on this record',
        severity: 'warning',
        code: 'no_value',
        params: { source: 'context.shipping_location.inventory_org' }
      },
      {
        field_id: 'link',
        path: 'mwfId',
        message: 'context.mwf_link[0].id has no value on this record',
        severity: 'error',
        code: 'rule_required',
        params: { source: 'context.mwf_link[0].id' }
      }
    ])
    // nothing at all in scope still renders
    const empty = await evaluateMap(s, {})
    expect(empty.body.lines).toEqual([])
  })

  it('record text is emitted verbatim', async () => {
    const text = 'He said "hi"\n{{ x }} ü'
    const s = spec([
      f({ id: 'd', key: 'description', value: { source: 'path', path: 'record.description' } }),
      f({
        id: 'l',
        key: 'lines',
        type: 'list',
        list: { source: 'record.lines', item: 'line' },
        children: [f({ id: 'n', key: 'name', value: { source: 'path', path: 'line.name' } })]
      })
    ])
    const { body } = await evaluateMap(s, {
      record: { description: text, lines: [{ name: text }] }
    })
    const round = JSON.parse(JSON.stringify(body))
    expect(round.description).toBe(text)
    expect(round.lines[0].name).toBe(text)
  })

  it('duplicate sibling keys are a problem', async () => {
    const s = spec([
      f({ id: 'a', key: 'po', value: { source: 'fixed', value: 'first' } }),
      f({ id: 'b', key: 'po', value: { source: 'fixed', value: 'second' } }),
      f({ id: 'c', key: '  ', value: { source: 'fixed', value: 'x' } })
    ])
    const { body, problems } = await evaluateMap(s, {})
    expect(body).toEqual({ po: 'first' })
    expect(problems).toEqual([
      {
        field_id: 'b',
        path: 'po',
        message: "Duplicate key 'po'",
        severity: 'error',
        code: 'duplicate_key',
        params: { key: 'po' }
      },
      { field_id: 'c', path: '', message: 'Empty key', severity: 'error', code: 'empty_key' }
    ])
  })

  it('formula value renders Liquid with the line alias in scope', async () => {
    const s = spec([
      f({
        id: 'l',
        key: 'lines',
        type: 'list',
        list: { source: 'record.lines', item: 'mat', number_as: 'n' },
        children: [
          f({
            id: 'r',
            key: 'ref',
            value: { source: 'formula', liquid: '{{ record.code }}-{{ mat.sku }}-{{ n }}' }
          }),
          f({
            id: 'j',
            key: 'extra',
            type: 'json',
            value: { source: 'formula', liquid: '{{ mat | jsonify }}' }
          }),
          f({
            id: 'bad',
            key: 'bad',
            value: { source: 'formula', liquid: '{% if %}' }
          })
        ]
      })
    ])
    const { body, problems } = await evaluateMap(s, {
      record: { code: 'IR', lines: [{ sku: 'A' }, { sku: 'B' }] }
    })
    const lines = body.lines as Array<Record<string, unknown>>
    expect(lines.map((l) => l.ref)).toEqual(['IR-A-1', 'IR-B-2'])
    expect(lines[1].extra).toEqual({ sku: 'B' })
    expect(lines[0].bad).toBeNull()
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ field_id: 'bad', path: 'lines[0].bad', severity: 'error' })
    expect(problems[0].message).toMatch(/^Formula error: /)
    expect(problems[0].code).toBe('formula_error')
  })

  it('2000-line list renders under 200 ms', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => ({
      id: i + 1,
      sku: `  ${100000 + i}  `,
      quantity: String(i % 7),
      price: (i * 1.25).toFixed(2),
      description: `Line ${i} "quoted"`,
      cifa_data: { cifa_number: `C${i}` },
      need_by: '2026-11-01'
    }))
    const s = spec([
      f({ id: 'h', key: 'header', value: { source: 'path', path: 'record.code' } }),
      f({
        id: 'l',
        key: 'orderLines',
        type: 'list',
        list: {
          source: 'context.lines',
          item: 'line',
          where: [{ field: 'quantity', op: 'gt', value: 0 }],
          sort: '-id'
        },
        children: [
          f({
            id: 'c1',
            key: 'lineNumber',
            type: 'number',
            value: { source: 'builtin', name: 'list.number' }
          }),
          f({
            id: 'c2',
            key: 'item',
            value: {
              source: 'path',
              path: 'line.sku',
              transforms: [{ op: 'trim' }, { op: 'pad_start', n: 9, char: '0' }]
            }
          }),
          f({
            id: 'c3',
            key: 'quantity',
            type: 'number',
            value: { source: 'path', path: 'line.quantity' }
          }),
          f({
            id: 'c4',
            key: 'price',
            type: 'number',
            value: { source: 'path', path: 'line.price' }
          }),
          f({
            id: 'c5',
            key: 'description',
            value: {
              source: 'path',
              path: 'line.description',
              transforms: [{ op: 'truncate', n: 150 }]
            }
          }),
          f({
            id: 'c6',
            key: 'cifa',
            value: { source: 'path', path: 'line.cifa_data.cifa_number' }
          }),
          f({
            id: 'c7',
            key: 'needBy',
            type: 'date',
            value: { source: 'path', path: 'line.need_by' }
          }),
          f({
            id: 'c8',
            key: 'org',
            include: 'not_empty',
            value: {
              source: 'path',
              path: 'record.org',
              fallbacks: [{ source: 'fixed', value: 'X' }]
            }
          })
        ]
      })
    ])
    const scope = { record: { code: 'IR-1' }, context: { lines } }
    await evaluateMap(s, scope) // warm the module
    const t0 = performance.now()
    const { body, problems } = await evaluateMap(s, scope)
    const ms = performance.now() - t0
    const out = body.orderLines as Array<Record<string, unknown>>
    expect(out.length).toBe(lines.filter((l) => Number(l.quantity) > 0).length)
    expect(out[0].lineNumber).toBe(1)
    expect(out[0].item).toBe('000101999')
    expect(problems).toEqual([])
    expect(ms).toBeLessThan(200)
  })

  it('coerces boolean and date and flags mismatches', async () => {
    const s = spec([
      f({ id: 'b1', key: 'b1', type: 'boolean', value: { source: 'fixed', value: 'true' } }),
      f({ id: 'b2', key: 'b2', type: 'boolean', value: { source: 'fixed', value: 0 } }),
      f({ id: 'b3', key: 'b3', type: 'boolean', value: { source: 'fixed', value: 'maybe' } }),
      f({
        id: 'd1',
        key: 'd1',
        type: 'date',
        value: { source: 'fixed', value: '2026-11-03T00:00:00Z' }
      }),
      f({ id: 'd2', key: 'd2', type: 'date', value: { source: 'fixed', value: 'soon' } }),
      f({ id: 't1', key: 't1', value: { source: 'fixed', value: 42 } }),
      f({ id: 'n1', key: 'n1', type: 'number', value: { source: 'fixed', value: '' } })
    ])
    const { body, problems } = await evaluateMap(s, {})
    expect(body).toEqual({
      b1: true,
      b2: false,
      b3: null,
      d1: '2026-11-03',
      d2: null,
      t1: '42',
      n1: null
    })
    expect(problems.map((p) => p.message)).toEqual([
      "Boolean expected, got 'maybe'",
      "Date expected, got 'soon'"
    ])
    expect(problems.map((p) => [p.code, p.params?.got])).toEqual([
      ['type_boolean', 'maybe'],
      ['type_date', 'soon']
    ])
  })

  it('builtins read today, acting user and state from the scope', async () => {
    const s = spec([
      f({ id: 'a', key: 'today', value: { source: 'builtin', name: 'today' } }),
      f({ id: 'b', key: 'who', value: { source: 'builtin', name: 'acting_user.name' } }),
      f({ id: 'c', key: 'emp', value: { source: 'builtin', name: 'acting_user.employee_id' } }),
      f({ id: 'd', key: 'state', value: { source: 'builtin', name: 'state.external_label' } }),
      f({ id: 'e', key: 'now', value: { source: 'builtin', name: 'now' } })
    ])
    const { body } = await evaluateMap(s, {
      acting_user: { first_name: 'Ada', last_name: 'Lovelace', employee_id: 'E1' },
      state: { label: 'Approved', external_label: 'APPROVED' }
    })
    expect(body).toEqual({
      today: '2026-10-22',
      who: 'Ada Lovelace',
      emp: 'E1',
      state: 'APPROVED',
      now: '2026-10-22T16:00:00.000Z'
    })
  })

  it('include when evaluates rules against the scope', async () => {
    const s = spec([
      f({
        id: 'p',
        key: 'po_number',
        include: { when: [{ field: 'record.po', op: 'nnull', value: null }] },
        value: { source: 'path', path: 'record.po' }
      })
    ])
    expect((await evaluateMap(s, { record: { po: 'PO1' } })).body).toEqual({ po_number: 'PO1' })
    expect((await evaluateMap(s, { record: { po: null } })).body).toEqual({})
  })

  it('never throws on a malformed spec', async () => {
    const bad = {
      v: 1,
      fields: [
        { id: 'x', key: 'x', type: 'text', include: 'always', value: { source: 'nope' } },
        null
      ]
    }
    const { body, problems } = await evaluateMap(bad as unknown as MapSpec, {})
    expect(body).toEqual({ x: null })
    expect(problems.length).toBeGreaterThan(0)
  })
})

describe('secret typed as non-text', () => {
  it('a number-typed secret field is a blocking problem, not a number', async () => {
    const s = spec([
      f({ id: 'a', key: 'n', type: 'number', value: { source: 'secret', name: 'token' } })
    ])
    const { problems } = await evaluateMap(s, {}, { secretNames: ['token'] })
    expect(problems.some((p) => p.severity === 'error')).toBe(true)
  })
  it('validateSpec rejects a secret on a non-text type', () => {
    const r = validateSpec(
      spec([f({ id: 'a', key: 'n', type: 'number', value: { source: 'secret', name: 'token' } })])
    )
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('A secret can only be sent as text')
  })
})

describe('secret names', () => {
  it('validateSpec rejects a secret name outside letters, digits, - and _', () => {
    const r = validateSpec(
      spec([f({ id: 'a', key: 'a', value: { source: 'secret', name: 'a b' } })])
    )
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain('Secret names use letters, digits, - and _')
  })
})

describe('validateSpec draft vs publish', () => {
  const half = {
    v: 1,
    fields: [
      { id: 'a', key: 'x', type: 'text', include: 'always', value: { source: 'path', path: '' } },
      { id: 'b', key: 'y', type: 'text', include: 'always', value: { source: 'secret', name: '' } },
      {
        id: 'c',
        key: 'n',
        type: 'number',
        include: 'always',
        value: { source: 'secret', name: 'token' }
      },
      {
        id: 'd',
        key: 'l',
        type: 'list',
        include: 'always',
        list: { source: '', item: 'line', scalar: true },
        children: []
      },
      { id: 'e', key: 'p', type: 'text', include: 'always', rules: { pattern: '([a-' } }
    ]
  }

  it('draft lets incomplete rows through', () => {
    expect(validateSpec(half, { mode: 'draft' }).ok).toBe(true)
  })

  it('publish (the default) requires every row complete', () => {
    const r = validateSpec(half)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join('\n')).toMatch(/fields\[0\]\.value\.path must be a path/)
    expect(r.errors.join('\n')).toMatch(/fields\[1\]\.value\.name must name a secret/)
    expect(r.errors.join('\n')).toMatch(/secret can only be sent as text/)
    expect(r.errors.join('\n')).toMatch(/a list needs list.source/)
    expect(r.errors.join('\n')).toMatch(/scalar list needs exactly one child/)
    expect(r.errors.join('\n')).toMatch(/rules\.pattern/)
  })

  it('draft still refuses the wrong structure and types', () => {
    const r = validateSpec(
      {
        v: 1,
        fields: [
          { id: 'a', key: 1, type: 'texty', include: 'sometimes' },
          { id: 'a', key: 'b', type: 'list', include: 'always', list: { source: 3 } },
          { id: 'c', key: 'c', type: 'text', include: 'always', value: { source: 'path', path: 5 } }
        ]
      },
      { mode: 'draft' }
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join('\n')).toMatch(/key must be text/)
    expect(r.errors.join('\n')).toMatch(/unknown type/)
    expect(r.errors.join('\n')).toMatch(/include must be/)
    expect(r.errors.join('\n')).toMatch(/duplicate id/)
    expect(r.errors.join('\n')).toMatch(/list needs list.source/)
    expect(r.errors.join('\n')).toMatch(/path must be a path/)
  })
})

describe('validateSpec', () => {
  it('accepts a well-formed spec', () => {
    const s: MapSpec = spec([
      f({
        id: 'a',
        key: 'a',
        value: { source: 'path', path: 'record.a', transforms: [{ op: 'trim' }] }
      }),
      f({
        id: 'l',
        key: 'l',
        type: 'list',
        list: { source: 'context.x', item: 'line' },
        children: [f({ id: 'c', key: 'c', value: { source: 'builtin', name: 'list.number' } })]
      })
    ])
    const r = validateSpec(s)
    expect(r.ok).toBe(true)
  })

  it('a scalar list needs exactly one child', () => {
    const r = validateSpec(
      spec([
        f({
          id: 'l',
          key: 'l',
          type: 'list',
          list: { source: 'x', item: 'v', scalar: true },
          children: [f({ id: 'a', key: 'a' }), f({ id: 'b', key: 'b' })]
        }),
        f({ id: 'm', key: 'm', type: 'list', list: { source: 'x', item: 'v', scalar: true } })
      ])
    )
    expect(r).toEqual({
      ok: false,
      errors: [
        'fields[0].children: a scalar list needs exactly one child (has 2)',
        'fields[1].children: a scalar list needs exactly one child (has 0)'
      ]
    })
  })

  it('names every problem with its location', () => {
    const r = validateSpec({
      v: 2,
      fields: [
        { id: 'a', key: 'a', type: 'texty', include: 'always' },
        { id: 'a', key: 'b', type: 'list', include: 'sometimes' },
        {
          id: 'c',
          key: 'c',
          type: 'text',
          include: 'always',
          value: { source: 'fixed', value: 1, transforms: [{ op: 'truncate' }] }
        }
      ]
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([
      'v must be 1',
      "fields[0].type: unknown type 'texty'",
      "fields[1].id: duplicate id 'a'",
      'fields[1].include must be always, not_empty or { when: [...] }',
      'fields[1].list: a list needs list.source',
      'fields[2].value.transforms[0].n must be a number'
    ])
    expect(validateSpec(null)).toEqual({ ok: false, errors: ['spec must be an object'] })
  })
})
