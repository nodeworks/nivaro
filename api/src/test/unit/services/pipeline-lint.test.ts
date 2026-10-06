import { describe, expect, it } from 'vitest'
import {
  impossibleReason,
  type LintState,
  type LintTransition,
  lintTemplate
} from '../../../services/pipeline-lint.js'

const st = (id: string, sort: number, extra: Partial<LintState> = {}): LintState => ({
  id,
  label: id,
  sort,
  is_initial: false,
  is_terminal: false,
  ...extra
})
let n = 0
const tx = (
  from: string | null,
  to: string,
  extra: Partial<LintTransition> = {}
): LintTransition => ({
  id: `t${++n}`,
  from_state: from,
  to_state: to,
  label: `${from ?? 'any'}→${to}`,
  ...extra
})
const rules = (r: unknown[]) => JSON.stringify(r)
const codes = (r: ReturnType<typeof lintTemplate>) => r.findings.map((f) => f.code)

describe('impossibleReason', () => {
  it('passes satisfiable and single-rule sets', () => {
    expect(impossibleReason(null)).toBeNull()
    expect(impossibleReason(rules([{ field: 'a', op: 'eq', value: 1 }]))).toBeNull()
    expect(
      impossibleReason(
        rules([
          { field: 'a', op: 'eq', value: 1 },
          { field: 'b', op: 'eq', value: 2 }
        ])
      )
    ).toBeNull()
    expect(
      impossibleReason(
        rules([
          { field: 'a', op: 'gte', value: 5 },
          { field: 'a', op: 'lte', value: 5 }
        ])
      )
    ).toBeNull()
  })

  it('catches eq A and eq B, eq X and neq X', () => {
    expect(
      impossibleReason([
        { field: 'type', op: 'eq', value: 2 },
        { field: 'type', op: 'eq', value: 3 }
      ])
    ).toMatch(/must equal both/)
    expect(
      impossibleReason([
        { field: 'type', op: 'eq', value: '2' },
        { field: 'type', op: 'eq', value: 2 }
      ])
    ).toBeNull()
    expect(
      impossibleReason([
        { field: 'type', op: 'eq', value: 2 },
        { field: 'type', op: 'neq', value: '2' }
      ])
    ).toMatch(/not equal/)
  })

  it('catches eq outside an in list and disjoint in lists', () => {
    expect(
      impossibleReason([
        { field: 'w', op: 'eq', value: 3 },
        { field: 'w', op: 'in', value: '1,2' }
      ])
    ).toMatch(/not in its "in" list/)
    expect(
      impossibleReason([
        { field: 'w', op: 'in', value: '1,2' },
        { field: 'w', op: 'in', value: '3, 4' }
      ])
    ).toMatch(/share no value/)
    expect(
      impossibleReason([
        { field: 'w', op: 'in', value: '1,2' },
        { field: 'w', op: 'in', value: '2,3' }
      ])
    ).toBeNull()
  })

  it('catches null vs nnull, null vs a value, empty numeric ranges', () => {
    expect(
      impossibleReason([
        { field: 'po', op: 'null' },
        { field: 'po', op: 'nnull' }
      ])
    ).toMatch(/empty and filled/)
    expect(
      impossibleReason([
        { field: 'po', op: 'null' },
        { field: 'po', op: 'gt', value: 1 }
      ])
    ).toMatch(/needs a value/)
    expect(
      impossibleReason([
        { field: 'amt', op: 'gt', value: 10 },
        { field: 'amt', op: 'lt', value: 5 }
      ])
    ).toMatch(/no value between/)
    expect(
      impossibleReason([
        { field: 'amt', op: 'gt', value: 5 },
        { field: 'amt', op: 'lte', value: 5 }
      ])
    ).toMatch(/no value between/)
    expect(
      impossibleReason([
        { field: 'd', op: 'within_days', value: 30 },
        { field: 'd', op: 'beyond_days', value: 45 }
      ])
    ).toMatch(/within 30 days/)
  })

  it('catches related_some with related_none on the same relation', () => {
    expect(
      impossibleReason([
        { field: 'lines:workflow', op: 'related_some' },
        { field: 'lines:workflow', op: 'related_none' }
      ])
    ).toMatch(/related_some/)
    expect(
      impossibleReason([
        { field: 'lines:workflow', op: 'related_some' },
        { field: 'lines:workflow', op: 'related_none', value: '{"req":{"_null":true}}' }
      ])
    ).toBeNull()
  })
})

describe('lintTemplate', () => {
  it('a clean linear template has no findings', () => {
    const r = lintTemplate(
      [st('a', 1, { is_initial: true }), st('b', 2), st('c', 3, { is_terminal: true })],
      [tx('a', 'b'), tx('b', 'c'), tx('b', 'a')]
    )
    expect(r.findings).toEqual([])
    expect(r.reachable).toBe(3)
  })

  it('flags never-entered and unreachable states and their dead transitions', () => {
    const r = lintTemplate(
      [
        st('a', 1, { is_initial: true }),
        st('b', 2),
        st('orphan', 3),
        st('island', 4),
        st('z', 5, { is_terminal: true })
      ],
      [tx('a', 'b'), tx('b', 'z'), tx('orphan', 'island'), tx('island', 'z')]
    )
    expect(codes(r)).toContain('never_entered')
    expect(r.findings.find((f) => f.code === 'unreachable')?.state_id).toBe('island')
    expect(r.findings.filter((f) => f.code === 'dead_transition').length).toBe(2)
  })

  it('a send-back makes its target reachable; any-state transitions reach their target', () => {
    const r = lintTemplate(
      [
        st('a', 1, { is_initial: true }),
        st('revise', 2),
        st('b', 3),
        st('canceled', 9, { is_terminal: true }),
        st('done', 10, { is_terminal: true })
      ],
      [tx('a', 'b'), tx('b', 'revise'), tx('revise', 'b'), tx('b', 'done'), tx(null, 'canceled')]
    )
    expect(r.findings).toEqual([])
    expect(r.reachable).toBe(5)
  })

  it('an impossible transition is not an edge and its target is reported', () => {
    const r = lintTemplate(
      [st('a', 1, { is_initial: true }), st('b', 2, { is_terminal: true })],
      [
        tx('a', 'b', {
          condition_rules: rules([
            { field: 't', op: 'eq', value: 1 },
            { field: 't', op: 'eq', value: 2 }
          ])
        })
      ]
    )
    expect(codes(r)).toEqual(['unreachable', 'dead_end', 'impossible_conditions'])
  })

  it('terminal exits are info; dead ends and shadowing autos are warnings', () => {
    const r = lintTemplate(
      [
        st('a', 1, { is_initial: true }),
        st('stuck', 2),
        st('wait', 3),
        st('canceled', 8, { is_terminal: true }),
        st('done', 9, { is_terminal: true })
      ],
      [
        tx('a', 'stuck'),
        tx('a', 'wait'),
        tx('wait', 'done', { auto_trigger: true }),
        tx('wait', 'a', { label: 'Send back' }),
        tx('a', 'canceled'),
        tx('canceled', 'a', { label: 'Uncancel' })
      ]
    )
    const byCode = Object.fromEntries(r.findings.map((f) => [f.code, f]))
    expect(byCode.dead_end.state_id).toBe('stuck')
    expect(byCode.auto_shadows_manual.state_id).toBe('wait')
    expect(byCode.terminal_exit.severity).toBe('info')
    expect(r.warnings).toBe(2)
  })

  it('a conditioned auto beside manual exits is fine; an unconditioned any-state auto is not', () => {
    const r = lintTemplate(
      [st('a', 1, { is_initial: true }), st('b', 2, { is_terminal: true })],
      [
        tx('a', 'b', { auto_trigger: 1, condition_rules: rules([{ field: 'x', op: 'nnull' }]) }),
        tx('a', 'b', { label: 'Approve' }),
        tx(null, 'b', { auto_trigger: true })
      ]
    )
    expect(codes(r)).toEqual(['any_state_auto'])
  })

  it('reports a template without an initial state', () => {
    expect(codes(lintTemplate([st('a', 1)], []))).toContain('no_initial')
  })
})
