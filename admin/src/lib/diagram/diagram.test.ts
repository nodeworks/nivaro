import { describe, expect, it } from 'vitest'
import { buildFlowDiagram, describeOperation, describeTrigger } from './flow-diagram'
import { type DiagramEdgeIn, type DiagramNodeIn, layoutGraph, wrapText } from './layout'
import {
  ANY_NODE_ID,
  buildPipelineDiagram,
  describeSkip,
  describeWho,
  type PipelineDiagramInput
} from './pipeline-diagram'
import { diagramToSvg } from './svg'

const n = (id: string): DiagramNodeIn => ({ id, title: id })
const e = (from: string, to: string, extra: Partial<DiagramEdgeIn> = {}): DiagramEdgeIn => ({
  id: `${from}>${to}`,
  from,
  to,
  ...extra
})

describe('layoutGraph', () => {
  it('places a chain left to right in layers', () => {
    const d = layoutGraph([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c')])
    const x = (id: string) => d.nodes.find((q) => q.id === id)?.x as number
    expect(x('a')).toBeLessThan(x('b'))
    expect(x('b')).toBeLessThan(x('c'))
    expect(d.edges.every((q) => !q.back)).toBe(true)
  })

  it('is deterministic for the same input', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map(n)
    const edges = [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd'), e('d', 'a'), e('d', 'e')]
    expect(JSON.stringify(layoutGraph(nodes, edges))).toBe(
      JSON.stringify(layoutGraph(nodes, edges))
    )
  })

  it('draws a cycle edge as a back-edge below the graph', () => {
    const d = layoutGraph([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c'), e('c', 'a')])
    const back = d.edges.find((q) => q.id === 'c>a')
    expect(back?.back).toBe(true)
    const bottom = Math.max(...d.nodes.map((q) => q.y + q.h))
    expect(back?.labelY).toBeGreaterThan(bottom - 1)
    expect(d.height).toBeGreaterThan(bottom)
    // still a DAG for layering: a is first
    expect(d.nodes.find((q) => q.id === 'a')?.layer).toBe(0)
  })

  it('stacks branches in the same layer without overlap', () => {
    const d = layoutGraph([n('a'), n('b'), n('c')], [e('a', 'b'), e('a', 'c')])
    const [b, c] = ['b', 'c'].map((id) => d.nodes.find((q) => q.id === id))
    expect(b?.layer).toBe(c?.layer)
    expect((c?.y as number) >= (b?.y as number) + (b?.h as number)).toBe(true)
  })

  it('handles self loops and ignores edges to unknown nodes', () => {
    const d = layoutGraph([n('a')], [e('a', 'a'), e('a', 'zzz')])
    expect(d.edges).toHaveLength(1)
    expect(d.edges[0].back).toBe(true)
    expect(Math.min(...d.edges.map((q) => q.labelY))).toBeGreaterThanOrEqual(0)
  })

  it('wraps long text', () => {
    expect(wrapText('one two three four', 8)).toEqual(['one two', 'three', 'four'])
    expect(wrapText('supercalifragilistic', 8)[0]).toMatch(/…$/)
  })
})

const state = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  key: id.toUpperCase(),
  label: `State ${id}`,
  color: '#3b82f6',
  is_initial: false,
  is_terminal: false,
  ...extra
})

describe('pipeline diagram', () => {
  const input: PipelineDiagramInput = {
    states: [
      state('s1', { is_initial: true, sort: 0 }),
      state('s2', {
        sort: 1,
        skip_criteria: { mode: 'any', conditions: [{ type: 'no_owners' }] }
      }),
      state('s3', { is_terminal: true, sort: 2 }),
      state('s4', { sort: 3 })
    ],
    transitions: [
      {
        id: 't1',
        from_state: 's1',
        to_state: 's2',
        label: 'Submit',
        required_roles: null,
        sort: 0
      },
      {
        id: 't2',
        from_state: 's2',
        to_state: 's3',
        label: 'Approve',
        required_roles: ['r1'],
        sort: 1
      },
      {
        id: 't3',
        from_state: 's2',
        to_state: 's1',
        label: 'Send back',
        required_roles: null,
        require_owner: true,
        allow_creator: true,
        sort: 2
      },
      { id: 't4', from_state: null, to_state: 's3', label: 'Cancel', required_roles: null, sort: 3 }
    ],
    roleNames: { r1: 'Finance' }
  }

  it('marks start and end, notes skips, and draws the send-back as a back arrow', () => {
    const d = buildPipelineDiagram(input)
    const byId = (id: string) => d.nodes.find((q) => q.id === id)
    expect(byId('s1')?.tags).toContain('Start')
    expect(byId('s3')?.tags).toContain('End')
    expect(byId('s2')?.noteLines.join(' ')).toContain('nobody owns this step')
    const back = d.edges.find((q) => q.from === 's2' && q.to === 's1')
    expect(back?.back).toBe(true)
    expect(back?.lines).toEqual(['Send back', 'Owner or creator'])
    expect(d.edges.find((q) => q.id === 't:s2>s3')?.lines?.[1]).toBe('Finance only')
    expect(byId(ANY_NODE_ID)?.role).toBe('virtual')
  })

  it('is deterministic', () => {
    expect(JSON.stringify(buildPipelineDiagram(input))).toBe(
      JSON.stringify(buildPipelineDiagram(input))
    )
  })

  it('shows parallel branches through a split node', () => {
    const d = buildPipelineDiagram({
      ...input,
      transitions: input.transitions.filter((t) => t.id !== 't4'),
      splits: [
        {
          id: 'sp',
          label: 'Review',
          branch_states: ['S2', 'S4'],
          join_state: 'S3',
          from_state: 'S1'
        }
      ]
    })
    const fork = d.nodes.find((q) => q.role === 'fork')
    expect(fork?.title).toBe('Split: Review')
    expect(d.nodes.find((q) => q.id === 's4')?.tags).toContain('Parallel branch')
    expect(d.edges.filter((q) => q.from === fork?.id)).toHaveLength(2)
  })

  it('words who may run a move', () => {
    const base = { id: 'x', from_state: null, to_state: 'y', label: 'L', required_roles: null }
    expect(describeWho(base)).toBe('Anyone who can edit')
    expect(describeWho({ ...base, auto_trigger: true })).toBe('Happens automatically')
    expect(describeWho({ ...base, require_owner: true })).toBe('Owner')
    expect(describeWho({ ...base, required_roles: ['a', 'b'] }, { a: 'Ops', b: 'Finance' })).toBe(
      'Ops or Finance only'
    )
    expect(describeSkip(null)).toBeNull()
    expect(
      describeSkip({
        mode: 'all',
        conditions: [{ type: 'field_compare', field: 'a.total_amount', op: 'lt', value: 100 }]
      })
    ).toBe('Skipped when total amount is less than 100')
  })
})

describe('flow diagram', () => {
  const ops = [
    {
      id: 'o1',
      name: 'Big order?',
      type: 'condition',
      options: { field: 'payload.amount', operator: 'gt', value: '1000' },
      resolve: 'o2',
      reject: 'o3'
    },
    {
      id: 'o2',
      name: 'Create PO',
      type: 'external-api',
      options: { api_id: 4, endpoint: 'Create PO' },
      resolve: null,
      reject: 'o3'
    },
    {
      id: 'o3',
      name: 'Tell owner',
      type: 'mail',
      options: { to: 'the record owner' },
      resolve: null,
      reject: null
    }
  ]

  it('chains trigger -> steps with dashed failed paths', () => {
    const d = buildFlowDiagram({
      trigger: 'event',
      trigger_options: { types: ['create'], collections: ['orders'] },
      operations: ops,
      apiNames: { '4': 'Fusion' }
    })
    expect(d.nodes[0].title).toBe('When a record is created in orders')
    expect(d.edges.find((q) => q.id === 'start:o1')).toBeTruthy()
    expect(d.edges.find((q) => q.id === 'ok:o1')?.lines).toEqual(['Yes'])
    const fail = d.edges.find((q) => q.id === 'no:o2')
    expect(fail?.dashed).toBe(true)
    expect(d.nodes.find((q) => q.id === 'o2')?.noteLines.join(' ')).toContain('Call Fusion')
    const x = (id: string) => d.nodes.find((q) => q.id === id)?.x as number
    expect(x('o1')).toBeGreaterThan(x('__trigger__'))
  })

  it('describes steps and triggers in plain words', () => {
    expect(describeTrigger('schedule', { cron: '0 9 * * *' })).toBe('On a schedule (0 9 * * *)')
    expect(describeOperation(ops[0])).toBe('Check whether amount is more than 1000')
    expect(describeOperation(ops[2])).toBe('Send email to the record owner')
  })
})

describe('svg', () => {
  it('escapes config text and includes every node', () => {
    const d = layoutGraph([{ id: 'a', title: '<script>alert(1)</script>' }, n('b')], [e('a', 'b')])
    const svg = diagramToSvg(d, 'dark', 'T & T')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg.match(/data-node=/g)).toHaveLength(2)
    expect(diagramToSvg(d, 'light')).not.toBe(svg)
  })
})
