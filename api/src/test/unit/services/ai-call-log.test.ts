import { describe, expect, it } from 'vitest'
import { parsePartialJson } from '../../../services/ai-call-log/partial-json.js'
import {
  csvCell,
  describeCallLogFilter,
  likeContains,
  parseCallLogFilter,
  parseSort
} from '../../../services/ai-call-log/query.js'
import { rebuildThread, turnFigures } from '../../../services/ai-call-log/thread.js'
import {
  buildTranscript,
  flatInput,
  questionFromMessages,
  questionOf,
  rawView,
  summarizeToolResult,
  toolsFromBlocks,
  traceFromRequest
} from '../../../services/ai-call-log/transcript.js'
import {
  assignToCentroids,
  centroidOf,
  dailyCounts,
  draftCoverage,
  topCollections
} from '../../../services/ai-topic-map.js'
import { fingerprintScore, matchFingerprint } from '../../../services/ai-topic-overrides.js'

const SYSTEM = 'You are the data assistant. '.repeat(2000)

function request(messages: unknown[], opts: { systemFirst?: boolean } = {}) {
  const body = opts.systemFirst
    ? { system: SYSTEM, tools: ['query_items', 'aggregate'], messages }
    : { messages, tools: ['query_items', 'aggregate'], system: SYSTEM }
  return JSON.stringify(body)
}

const loop = [
  { role: 'user', content: 'how many open invoices?' },
  { role: 'assistant', content: 'There are 12 open invoices.' },
  { role: 'user', content: 'and for vendor Acme?' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look.' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'query_items',
        input: { collection: 'invoices', filter: { vendor: { _eq: 'Acme' } }, api_key: 'sk-123' }
      }
    ]
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content:
          '<data source="tool:query_items">\n{"$cols":["id","total"],"$rows":[[1,10],[2,20]],"total":2}'
      }
    ]
  }
]

describe('parsePartialJson', () => {
  it('parses whole JSON untouched', () => {
    expect(parsePartialJson('{"a":[1,2]}')).toEqual({ value: { a: [1, 2] }, cut: false })
  })
  it('closes a body cut inside a string', () => {
    const r = parsePartialJson('{"messages":[{"role":"user","content":"hello wor…')
    expect(r.cut).toBe(true)
    expect(r.value).toEqual({ messages: [{ role: 'user', content: 'hello wor' }] })
  })
  it('drops a dangling key', () => {
    expect(parsePartialJson('{"a":1,"b":').value).toEqual({ a: 1 })
    expect(parsePartialJson('{"a":1,"bc').value).toEqual({ a: 1 })
  })
  it('backs off a cut number or literal', () => {
    expect(parsePartialJson('[1,2,tru').value).toEqual([1, 2])
  })
  it('returns null for text that is not JSON', () => {
    expect(parsePartialJson('plain text').value).toBeNull()
  })
})

describe('buildTranscript', () => {
  it('shows the latest question, earlier turns, tool steps and hides the system prompt', () => {
    const res = JSON.stringify([{ type: 'text', text: 'Acme has 2 open invoices.' }])
    const t = buildTranscript(request(loop), res, { stopReason: 'end_turn' })
    expect(t.earlier.map((e) => e.role)).toEqual(['user', 'assistant'])
    expect(t.steps[0]).toMatchObject({ kind: 'question', text: 'and for vendor Acme?' })
    const tool = t.steps.find((s) => s.kind === 'tool')
    expect(tool).toMatchObject({ name: 'query_items', from_this_call: false })
    if (tool?.kind !== 'tool') throw new Error('no tool')
    expect(tool.result?.rows).toBe(2)
    expect(tool.result?.columns).toEqual(['id', 'total'])
    // A credential-looking input is masked.
    expect(tool.input.find(([k]) => k === 'api_key')?.[1]).toBe('••••••')
    expect(t.steps.at(-1)).toMatchObject({ kind: 'answer', final: true })
    expect(t.hidden.system_chars).toBe(SYSTEM.length)
    expect(t.hidden.tool_definitions).toBe(2)
    expect(JSON.stringify(t)).not.toContain('You are the data assistant')
  })

  it('still finds the question in an OLD row cut inside the system prompt? no — it says unreadable', () => {
    const cut = `${request(loop, { systemFirst: true }).slice(0, 30_000)}…`
    const t = buildTranscript(cut, null)
    expect(t.unreadable).toBe(true)
    expect(t.cut.request).toBe(true)
  })

  it('reads a NEW row (messages first) cut at the cap', () => {
    const cut = `${request(loop).slice(0, 3000)}…`
    const t = buildTranscript(cut, null)
    expect(t.steps[0]).toMatchObject({ kind: 'question', text: 'and for vendor Acme?' })
  })

  it("lists the response's own tool calls as waiting for the next call", () => {
    const res = JSON.stringify([
      { type: 'tool_use', id: 't2', name: 'aggregate', input: { collection: 'invoices' } }
    ])
    const t = buildTranscript(request(loop.slice(0, 3)), res, { stopReason: 'tool_use' })
    const last = t.steps.at(-1)
    expect(last).toMatchObject({
      kind: 'tool',
      name: 'aggregate',
      from_this_call: true,
      result: null
    })
  })

  it('reduces attachments to a note', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'A'.repeat(4096) }
          },
          { type: 'text', text: 'fill this in' }
        ]
      }
    ]
    const t = buildTranscript(request(msgs), null)
    expect(t.steps[0]).toMatchObject({
      kind: 'question',
      attachments: [{ type: 'document', media_type: 'application/pdf', size_kb: 3 }]
    })
  })
})

describe('column helpers', () => {
  it('questionFromMessages / questionOf / toolsFromBlocks', () => {
    expect(questionFromMessages(loop)).toBe('and for vendor Acme?')
    expect(questionOf(request(loop))).toBe('and for vendor Acme?')
    expect(
      toolsFromBlocks([
        { type: 'tool_use', name: 'a' },
        { type: 'tool_use', name: 'b' },
        { type: 'tool_use', name: 'a' }
      ])
    ).toBe(',a,b,')
    expect(toolsFromBlocks([{ type: 'text', text: 'x' }])).toBe('')
  })
  it('traceFromRequest pairs results and marks errors', () => {
    const msgs = [
      ...loop,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't3', name: 'aggregate', input: { collection: 'x' } }]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't3',
            content: 'Error: Unknown field',
            is_error: true
          }
        ]
      }
    ]
    const tr = traceFromRequest(request(msgs))
    expect(tr.map((x) => x.tool)).toEqual(['query_items', 'aggregate'])
    expect(tr[0].summary).toBe('2 of 2 rows'.replace('2 of 2 rows', '2 rows'))
    expect(tr[1].summary.startsWith('error:')).toBe(true)
  })
  it('flatInput flattens one level', () => {
    expect(flatInput({ a: 1, b: { c: 2 } })).toEqual([
      ['a', '1'],
      ['b', '{"c":2}']
    ])
  })
  it('summarizeToolResult reads totals and errors', () => {
    expect(summarizeToolResult('{"rows":[{"a":1}],"total":40}', false).text).toBe('1 of 40 rows')
    expect(summarizeToolResult('Error: nope', false).error).toBe(true)
  })
  it('rawView masks secrets and drops base64', () => {
    const r = rawView(
      JSON.stringify({ password: 'hunter2', source: { type: 'base64', data: 'A'.repeat(2048) } })
    )
    expect(JSON.stringify(r.value)).not.toContain('hunter2')
    expect(JSON.stringify(r.value)).toContain('KB of base64 left out')
    const cut = rawView('{"token":"abc","x":"…')
    expect(JSON.stringify(cut)).not.toContain('"abc"')
  })
})

describe('call-log filter', () => {
  const now = new Date('2026-11-18T12:00:00Z')
  it('parses a window, lists and ranges; drops junk', () => {
    const f = parseCallLogFilter(
      {
        hours: '24',
        feature: 'chat,brief',
        result: 'error,bogus,max_tokens',
        cost_min: '0.01',
        ms_max: '-4',
        tool: 'query_items%',
        feedback: 'down'
      },
      now
    )
    expect(f.hours).toBe(24)
    expect(f.features).toEqual(['chat', 'brief'])
    expect(f.results).toEqual(['error', 'max_tokens'])
    expect(f.cost_min).toBe(0.01)
    expect(f.ms_max).toBeNull()
    expect(f.tool).toBe('query_items')
    expect(f.feedback).toBe('down')
  })
  it('a from/to range is capped at 90 days and never past now', () => {
    const f = parseCallLogFilter({ from: '2026-01-01', to: '2027-01-01' }, now)
    expect(f.to.getTime()).toBe(now.getTime())
    expect(f.hours).toBe(24 * 90)
  })
  it('a bare to-date covers that whole day', () => {
    const f = parseCallLogFilter({ from: '2026-11-10', to: '2026-11-11' }, now)
    expect(f.to.toISOString()).toBe('2026-11-12T00:00:00.000Z')
  })
  it('parseSort keeps to the fixed list', () => {
    expect(parseSort('-cost')).toEqual({ key: 'cost', dir: 'desc' })
    expect(parseSort('+time')).toEqual({ key: 'time', dir: 'asc' })
    expect(parseSort('drop table')).toEqual({ key: 'when', dir: 'desc' })
  })
  it('likeContains escapes the specials', () => {
    expect(likeContains('50%_[x]')).toBe('%50\\%\\_\\[x]%')
  })
  it('describe says what was looked at', () => {
    const f = parseCallLogFilter({ hours: '1', q: 'invoices', user: 'system' }, now)
    expect(describeCallLogFilter(f)).toContain('text "invoices"')
  })
  it('csvCell quotes and neutralises formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('=cmd()')).toBe("'=cmd()")
    expect(csvCell(null)).toBe('')
  })
})

describe('thread', () => {
  it('rebuilds a thread from one call', () => {
    const turns = rebuildThread(
      {
        request: request(loop),
        response: JSON.stringify([{ type: 'text', text: 'Two.' }]),
        stop_reason: 'end_turn'
      },
      'r1',
      'Pat'
    )
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      question: 'how many open invoices?',
      answer: 'There are 12 open invoices.'
    })
    expect(turns[1]).toMatchObject({
      question: 'and for vendor Acme?',
      answer: 'Two.',
      request_id: 'r1'
    })
    expect(turns[1].trace[0]).toMatchObject({ tool: 'query_items', error: false })
  })
  it('turnFigures sums calls', () => {
    const f = turnFigures([
      { cost_usd: 0.5, input_tokens: 10, output_tokens: 5, latency_ms: 100 } as never,
      { cost_usd: null, input_tokens: null, output_tokens: 1, latency_ms: 50 } as never
    ])
    expect(f).toEqual({ cost_usd: 0.5, tokens: 16, latency_ms: 150 })
  })
})

describe('topic map helpers', () => {
  it('dailyCounts buckets by day from the window start', () => {
    const from = new Date('2026-11-01T00:00:00Z')
    expect(
      dailyCounts(
        [
          { at: '2026-11-01T05:00:00Z' },
          { at: '2026-11-03T01:00:00Z' },
          { at: '2026-11-03T02:00:00Z' }
        ],
        from,
        4
      )
    ).toEqual([1, 0, 2, 0])
  })
  it('assignToCentroids counts the nearest centre above the bar', () => {
    expect(
      assignToCentroids(
        [
          [1, 0],
          [0, 1],
          [0.7, 0.7]
        ],
        [[1, 0]],
        0.9
      )
    ).toEqual([1])
  })
  it('centroidOf normalises', () => {
    const c = centroidOf([
      [1, 0],
      [1, 0]
    ])
    expect(c).toEqual([1, 0])
  })
  it('topCollections ranks', () => {
    expect(topCollections([{ collections: ['a', 'b'] }, { collections: ['b'] }])).toEqual([
      'b',
      'a'
    ])
  })
  it('draftCoverage judges a term against the questions', () => {
    expect(
      draftCoverage(['which invoices are held', 'open POs'], {
        kind: 'glossary',
        term: 'held',
        aliases: []
      })
    ).toEqual([true, false])
  })
})

describe('topic overrides', () => {
  const fp = { members: ['a', 'b', 'c'], centroid: [1, 0], provider: 'voyage', name: 'Invoices' }
  it('re-attaches by shared questions', () => {
    expect(
      fingerprintScore(fp, { members: ['b', 'c', 'x', 'y'], centroid: [0, 1], provider: 'local' })
    ).toBeGreaterThan(1)
  })
  it('falls back to meaning under the same provider only', () => {
    expect(
      fingerprintScore(fp, { members: ['z'], centroid: [0.99, 0.05], provider: 'voyage' })
    ).toBeGreaterThan(0.9)
    expect(
      fingerprintScore(fp, { members: ['z'], centroid: [0.99, 0.05], provider: 'local' })
    ).toBe(0)
  })
  it('matchFingerprint picks the best topic', () => {
    expect(
      matchFingerprint(fp, [
        { members: ['q'], centroid: [0, 1], provider: 'voyage' },
        { members: ['a', 'b'], centroid: [0, 1], provider: 'voyage' }
      ])
    ).toBe(1)
  })
})
