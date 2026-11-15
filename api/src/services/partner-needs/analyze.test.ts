import { describe, expect, it } from 'vitest'
import { analyzeLiquid, analyzeMapSpec, liquidOutputPaths } from './analyze.js'

const path = (id: string, key: string, p: string, extra: Record<string, unknown> = {}) => ({
  id,
  key,
  type: 'text',
  value: { source: 'path', path: p, ...extra },
  include: 'always'
})

describe('analyzeMapSpec', () => {
  it('names record paths and context lookups the body always sends', () => {
    const r = analyzeMapSpec({
      v: 1,
      fields: [
        path('a', 'ref', 'record.order_ref'),
        path('b', 'site', 'context.unit[0].name'),
        {
          id: 'c',
          key: 'fixed',
          type: 'text',
          value: { source: 'fixed', value: 'X' },
          include: 'always'
        }
      ]
    })
    expect(r.needed).toEqual([
      { kind: 'record', field: 'order_ref' },
      { kind: 'context', key: 'unit', rest: ['name'] }
    ])
  })

  it('skips values with a fallback, not_empty outputs and self-guarded values', () => {
    const r = analyzeMapSpec({
      v: 1,
      fields: [
        path('a', 'flag', 'record.ship_complete', {
          fallbacks: [{ source: 'fixed', value: false }]
        }),
        { ...path('b', 'note', 'record.note'), include: 'not_empty' },
        {
          ...path('c', 'pn', 'record.product_number'),
          include: { when: [{ field: 'record.product_number', op: 'nnull', value: null }] }
        },
        {
          id: 'd',
          key: 'project',
          type: 'text',
          value: {
            source: 'switch',
            cases: [
              {
                when: [{ field: 'context.project[0].project_id', op: 'nnull', value: null }],
                value: { source: 'path', path: 'context.project[0].project_id' }
              }
            ],
            else: { source: 'fixed', value: 'US' }
          },
          include: 'always'
        }
      ]
    })
    expect(r.needed).toEqual([])
  })

  it('a value guarded by a DIFFERENT path still counts', () => {
    const r = analyzeMapSpec({
      v: 1,
      fields: [
        {
          ...path('c', 'cifa', 'record.cifa_number'),
          include: { when: [{ field: 'record.product_number', op: 'null', value: null }] }
        }
      ]
    })
    expect(r.needed).toEqual([{ kind: 'record', field: 'cifa_number' }])
  })

  it('reads list items as lines of the list source, with its where rules', () => {
    const where = [{ field: 'material.quantity', op: 'gt', value: 0 }]
    const r = analyzeMapSpec({
      v: 1,
      fields: [
        {
          id: 'l',
          key: 'lines',
          type: 'list',
          list: { source: 'context.materials', item: 'material', where },
          include: 'always',
          children: [
            path('m', 'model', 'material.cifa_data.product_number'),
            path('q', 'qty', 'quantity'),
            path('n', 'no', 'number')
          ]
        }
      ]
    })
    expect(r.lists).toEqual([{ key: 'materials', alias: 'material', where }])
    expect(r.needed).toEqual([
      {
        kind: 'line',
        key: 'materials',
        rest: ['cifa_data', 'product_number'],
        where,
        alias: 'material'
      },
      { kind: 'line', key: 'materials', rest: ['quantity'], where, alias: '' }
    ])
  })

  it('formula outputs count unless defaulted or inside an if', () => {
    const r = analyzeMapSpec({
      v: 1,
      fields: [
        {
          id: 'f',
          key: 'desc',
          type: 'text',
          value: {
            source: 'formula',
            liquid:
              '{{ record.code }} {{ context.unit[0].sys | default: record.id }}{% if record.name %} {{ record.name }}{% endif %}'
          },
          include: 'always'
        }
      ]
    })
    expect(r.needed).toEqual([{ kind: 'record', field: 'code' }])
  })
})

describe('analyzeLiquid', () => {
  it('reads loops over context lists as lines and skips conditional output', () => {
    const r = analyzeLiquid(
      '{"po":"{{ record.po_number }}","lines":[{% for l in context.lines %}{"q":{{ l.qty }}}{% if l.note %},"n":"{{ l.note }}"{% endif %}{% endfor %}]{% comment %}{{ record.secret }}{% endcomment %}}'
    )
    expect(r.lists).toEqual([{ key: 'lines', alias: 'l', where: [] }])
    expect(r.needed).toEqual([
      { kind: 'record', field: 'po_number' },
      { kind: 'line', key: 'lines', rest: ['qty'], where: [], alias: 'l' }
    ])
  })

  it('liquidOutputPaths lists unconditional output paths', () => {
    expect(
      liquidOutputPaths('{{ record.a }}{{ record.b | default: 1 }}{{ "x" }}{{ true }}')
    ).toEqual(['record.a'])
  })
})
