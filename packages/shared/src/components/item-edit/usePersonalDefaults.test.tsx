// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import type { SavedDefault } from '../../lib/personal-defaults'
import type { CascadeRule } from './helpers'
import {
  linksBeyond,
  type PersonalDefaultsApi,
  sameDefaultValue,
  type UsePersonalDefaultsResult,
  usePersonalDefaults
} from './usePersonalDefaults'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Zone → Region → Ship-to cascade (Ship-to options filtered by Region, Region by Zone),
// plus an M2M `tags` alias with no parents.
const RULES: Record<string, CascadeRule[]> = {
  region: [{ parent_field: 'zone', filter_column: 'zone' }],
  ship_to: [{ parent_field: 'region', filter_column: 'region' }]
}
const LABELS: Record<string, string> = {
  zone: 'Zone',
  region: 'Region',
  ship_to: 'Ship-to',
  tags: 'Tags'
}
const VALUE_LABELS: Record<string, string> = {
  '2': 'North',
  '5': 'South',
  '10': 'Boston',
  '20': 'Denver',
  '100': 'Cambridge',
  '200': 'Aurora'
}

let seq = 0
function d(field: string, value: unknown, context: Record<string, unknown> = {}): SavedDefault {
  seq += 1
  return {
    id: seq,
    field,
    value,
    context,
    updated_at: `2026-10-${String(10 + seq).padStart(2, '0')}`
  }
}

type Calls = { set: Array<[string, unknown, unknown]>; auto: string[]; after: string[] }

type HarnessOpts = {
  defaults: SavedDefault[]
  initial?: Record<string, unknown>
  allowed?: string[]
  canFill?: (f: string, touched: Set<string>) => boolean
  replaceable?: (f: string, cur: unknown) => boolean
  invalid?: Set<string>
  disabled?: boolean
  rules?: Record<string, CascadeRule[]>
  revalidate?: (f: string, v: unknown) => Promise<boolean | null>
  valueLabel?: (f: string, v: unknown) => string | null
  isNew?: boolean
  resetKey?: string
  fieldType?: (f: string) => string | null
  /** GET /field-defaults/mine fails. */
  getFails?: boolean
}

let root: Root
let host: HTMLDivElement
let api: UsePersonalDefaultsResult
let form: {
  draftRef: { current: Record<string, unknown> }
  staged: { current: Record<string, string[]> }
  touched: Set<string>
  // The person edits a field (handleFieldChange): draft write + onPersonChange.
  personEdit: (f: string, v: unknown) => void
  // A rule / cascade writes a field: no onPersonChange.
  ruleWrite: (f: string, v: unknown) => void
  rerender: () => void
}
let calls: Calls
let requests: Array<{ _method?: string; _path: string; _params?: unknown; _body?: unknown }>

function Harness({ o }: { o: HarnessOpts }) {
  const draftRef = useRef<Record<string, unknown>>({ ...(o.initial ?? {}) })
  const staged = useRef<Record<string, string[]>>({})
  const touched = useRef(new Set<string>()).current
  const [, setDraft] = useState<Record<string, unknown>>(draftRef.current)
  const [, setTick] = useState(0)
  const allowed = new Set(o.allowed ?? ['zone', 'region', 'ship_to', 'tags'])
  const rules = o.rules ?? RULES
  const rulesFor = (f: string) => rules[f] ?? []
  const result = usePersonalDefaults({
    collection: 'orders',
    isNew: o.isNew ?? true,
    resetKey: o.resetKey,
    layoutAllows: (f) => allowed.has(f),
    draftRef,
    setFieldValue: (f, v, prev) => {
      calls.set.push([f, v, prev])
      if (f === 'tags') {
        // Alias: unstage what `prev` staged, stage the new ids.
        const drop = new Set(Array.isArray(prev) ? prev.map(String) : [])
        const keep = (staged.current.tags ?? []).filter((x) => !drop.has(x))
        const want = Array.isArray(v) ? v.map(String) : []
        staged.current = { ...staged.current, tags: [...new Set([...keep, ...want])] }
        setTick((t) => t + 1)
        return
      }
      draftRef.current = { ...draftRef.current, [f]: v }
      setDraft(draftRef.current)
    },
    markAutoFilled: (fs) => calls.auto.push(...fs),
    revalidate: o.revalidate ?? (async (f) => !o.invalid?.has(f)),
    disabled: !!o.disabled,
    rulesFor,
    readValue: (f) => (f === 'tags' ? (staged.current.tags ?? []) : undefined),
    canFill: (f) => (o.canFill ? o.canFill(f, touched) : !touched.has(f)),
    replaceable: o.replaceable,
    fieldLabel: (f) => LABELS[f] ?? f,
    valueLabel: o.valueLabel ?? ((_f, v) => VALUE_LABELS[String(v)] ?? String(v)),
    afterApply: (f) => calls.after.push(f),
    fieldType: o.fieldType
  })
  api = result
  form = {
    draftRef,
    staged,
    touched,
    personEdit: (f, v) => {
      // handleFieldChange: the edit, plus clear_on_parent_change children nulled in the same write.
      touched.add(f)
      const next: Record<string, unknown> = { ...draftRef.current, [f]: v }
      for (const [child, rs] of Object.entries(rules))
        if (rs.some((r) => r.parent_field === f && r.clear_on_parent_change)) next[child] = null
      draftRef.current = next
      setDraft(next)
      result.onPersonChange(f)
    },
    ruleWrite: (f, v) => {
      draftRef.current = { ...draftRef.current, [f]: v }
      setDraft(draftRef.current)
    },
    rerender: () => setTick((t) => t + 1)
  }
  return null
}

async function flush(n = 10) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

let failField: string | null = null
let renderWith: (o: HarnessOpts) => Promise<void>

async function mount(o: HarnessOpts) {
  const client = {
    request: vi.fn(async (cmd: { _method?: string; _path: string }) => {
      requests.push(cmd)
      if (failField && (cmd as { _body?: { field?: string } })._body?.field === failField)
        throw new Error('refused')
      if (cmd._path === '/field-defaults/mine' && (cmd._method ?? 'GET') === 'GET') {
        if (o.getFails) throw new Error('offline')
        return { data: o.defaults }
      }
      return { data: null }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  renderWith = async (next: HarnessOpts) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <Harness o={next} />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await flush()
  }
  await renderWith(o)
  return { qc }
}

const draft = () => form.draftRef.current

beforeEach(() => {
  seq = 0
  calls = { set: [], auto: [], after: [] }
  requests = []
  failField = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('usePersonalDefaults: applying on a new record', () => {
  it('applies parent then child, as auto-fills, once', async () => {
    await mount({
      defaults: [
        d('ship_to', '100', { zone: '2', region: '10' }),
        d('region', '10', { zone: '2' }),
        d('zone', '2')
      ]
    })
    expect(calls.set.map((c) => c[0])).toEqual(['zone', 'region', 'ship_to'])
    expect(draft()).toMatchObject({ zone: '2', region: '10', ship_to: '100' })
    expect(calls.auto).toEqual(['zone', 'region', 'ship_to'])
    expect([...api.ledger.keys()]).toEqual(['zone', 'region', 'ship_to'])
    // Rules / cross-record defaults run after the whole pass, never in between.
    expect(calls.after).toEqual(['zone', 'region', 'ship_to'])
    expect(requests.filter((r) => r._path === '/field-defaults/mine')).toHaveLength(1)
    form.rerender()
    await flush()
    expect(calls.set).toHaveLength(3)
  })

  it('never overwrites a field that already has a value', async () => {
    await mount({
      defaults: [d('zone', '2'), d('ship_to', '100', { zone: '2' })],
      initial: { ship_to: '999' }
    })
    expect(draft().ship_to).toBe('999')
    expect(draft().zone).toBe('2')
    expect(api.ledger.has('ship_to')).toBe(false)
  })

  it('replaces a layout default the person never touched (personal beats layout)', async () => {
    await mount({
      defaults: [d('zone', '2')],
      initial: { zone: '9' },
      replaceable: (f, cur) => f === 'zone' && cur === '9'
    })
    expect(draft().zone).toBe('2')
    expect(api.ledger.get('zone')).toBe('2')
  })

  it('a parent holding another value: no child value, a quiet hint', async () => {
    await mount({
      defaults: [d('region', '10', { zone: '2' })],
      initial: { zone: '5' },
      canFill: (f) => f !== 'zone'
    })
    expect(draft().region).toBeUndefined()
    expect(api.hintFor('region')).toBe('Your default is for Zone “North”')
    expect(api.ledger.size).toBe(0)
  })

  it('empty parents are filled from the same saved set first', async () => {
    await mount({ defaults: [d('ship_to', '100', { zone: '2', region: '10' })] })
    expect(calls.set.map((c) => c[0])).toEqual(['zone', 'region', 'ship_to'])
    expect(draft()).toMatchObject({ zone: '2', region: '10', ship_to: '100' })
    expect(api.ledger.has('zone') && api.ledger.has('region')).toBe(true)
  })

  it('an empty parent this form cannot fill skips the child with the hint', async () => {
    await mount({
      defaults: [d('ship_to', '100', { region: '10' })],
      allowed: ['ship_to']
    })
    expect(draft().ship_to).toBeUndefined()
    expect(api.hintFor('ship_to')).toBe('Your default is for Region “Boston”')
  })

  it('a value no longer available is skipped with a hint (Review Focus 3)', async () => {
    await mount({
      defaults: [d('zone', '2'), d('ship_to', '100', { zone: '2' })],
      invalid: new Set(['ship_to'])
    })
    expect(draft().ship_to).toBeUndefined()
    expect(draft().zone).toBe('2')
    expect(api.hintFor('ship_to')).toBe('Your default "Cambridge" is no longer available')
    expect(calls.auto).toEqual(['zone'])
  })

  it('a restored draft wins outright: nothing is applied', async () => {
    await mount({ defaults: [d('zone', '2')], disabled: true })
    expect(calls.set).toEqual([])
    expect(api.ledger.size).toBe(0)
  })
})

describe('usePersonalDefaults: later parent changes', () => {
  const defaults = () => [
    d('zone', '2'),
    d('region', '10', { zone: '2' }),
    d('region', '20', { zone: '5' }),
    d('ship_to', '100', { zone: '2', region: '10' })
  ]

  it('the person changes Zone: the untouched child is cleared and re-picked', async () => {
    await mount({ defaults: defaults() })
    expect(draft()).toMatchObject({ zone: '2', region: '10', ship_to: '100' })
    await act(async () => form.personEdit('zone', '5'))
    await flush()
    expect(draft().region).toBe('20')
    expect(api.ledger.get('region')).toBe('20')
    expect(api.ledger.has('zone')).toBe(false)
    // Ship-to's only default is for Boston: cleared, not re-filled.
    expect(draft().ship_to).toBeNull()
    expect(api.ledger.has('ship_to')).toBe(false)
  })

  it('a rule-filled parent change keeps the child (Review Focus 2)', async () => {
    await mount({ defaults: defaults() })
    await act(async () => form.ruleWrite('zone', '5'))
    await flush()
    expect(draft().region).toBe('10')
    expect(api.ledger.get('region')).toBe('10')
    // Zone no longer holds the default: its pill goes.
    expect(api.ledger.has('zone')).toBe(false)
  })

  it('a child the person picked is never cleared by a parent change', async () => {
    await mount({ defaults: defaults() })
    await act(async () => form.personEdit('region', '11'))
    await act(async () => form.personEdit('zone', '5'))
    await flush()
    expect(draft().region).toBe('11')
  })

  it('undo also takes back the parents its default filled on the way in', async () => {
    // Only Ship-to has a default; its saved set brings Zone and Region with it.
    await mount({ defaults: [d('ship_to', '100', { zone: '2', region: '10' })] })
    expect(draft()).toMatchObject({ zone: '2', region: '10', ship_to: '100' })
    await act(async () => api.undo('ship_to'))
    await flush()
    expect(draft()).toMatchObject({ zone: null, region: null, ship_to: null })
    expect(api.ledger.size).toBe(0)
  })

  it('undo keeps a filled parent another applied default still sits on', async () => {
    const rules = { ...RULES, dock: [{ parent_field: 'zone', filter_column: 'zone' }] }
    await mount({
      rules,
      allowed: ['zone', 'region', 'ship_to', 'dock'],
      defaults: [d('ship_to', '100', { zone: '2', region: '10' }), d('dock', '7', { zone: '2' })]
    })
    expect(draft()).toMatchObject({ zone: '2', region: '10', ship_to: '100', dock: '7' })
    await act(async () => api.undo('ship_to'))
    await flush()
    // Region was Ship-to's alone; Zone still carries Dock's default.
    expect(draft()).toMatchObject({ zone: '2', region: null, ship_to: null, dock: '7' })
  })

  it('undo leaves a parent the person set since', async () => {
    await mount({ defaults: [d('ship_to', '100', { zone: '2', region: '10' })] })
    await act(async () => form.personEdit('zone', '2'))
    await act(async () => api.undo('ship_to'))
    await flush()
    expect(draft().ship_to).toBeNull()
    expect(draft().zone).toBe('2')
  })

  it('undo clears the field and its auto-filled children', async () => {
    await mount({ defaults: defaults() })
    await act(async () => api.undo('zone'))
    await flush()
    expect(draft()).toMatchObject({ zone: null, region: null, ship_to: null })
    expect(api.ledger.size).toBe(0)
  })
})

describe('usePersonalDefaults: M2M (Review Focus 1)', () => {
  it('stages the default links and undo unstages only those', async () => {
    await mount({ defaults: [d('tags', ['7', '8'])] })
    expect(form.staged.current.tags).toEqual(['7', '8'])
    expect(api.ledger.get('tags')).toEqual(['7', '8'])
    await act(async () => api.undo('tags'))
    await flush()
    expect(calls.set.at(-1)).toEqual(['tags', null, ['7', '8']])
    expect(form.staged.current.tags).toEqual([])
    expect(api.ledger.has('tags')).toBe(false)
  })

  it('the default links are not unsaved work', () => {
    const links = new Map<string, unknown[]>([
      ['tags', ['7', '8', 9]],
      ['other', ['1']]
    ])
    const quiet = new Map([['tags', new Set(['7', '8'])]])
    expect(linksBeyond(links, quiet)).toBe(2)
    expect(linksBeyond(new Map([['tags', ['7', '8']]]), quiet)).toBe(0)
  })
})

describe('PersonalDefaultsContext value', () => {
  it('save stores the field with its context, and allowed parents in the same action', async () => {
    const { qc } = await mount({
      defaults: [],
      initial: { zone: '2', region: '10', ship_to: '100' }
    })
    const ctx: PersonalDefaultsApi = api.context
    const inval = vi.spyOn(qc, 'invalidateQueries')
    await act(async () => ctx.save('ship_to'))
    const puts = requests.filter((r) => r._method === 'PUT').map((r) => r._body)
    expect(puts).toEqual([
      {
        collection: 'orders',
        field: 'ship_to',
        value: '100',
        context: { region: '10', zone: '2' }
      },
      { collection: 'orders', field: 'zone', value: '2', context: {} },
      { collection: 'orders', field: 'region', value: '10', context: { zone: '2' } }
    ])
    expect(inval).toHaveBeenCalledWith({ queryKey: ['field-defaults', 'orders'] })
    expect(ctx.allowed('ship_to')).toBe(true)
  })

  it('a refused field saves no parents and still refreshes the cache', async () => {
    const { qc } = await mount({
      defaults: [],
      initial: { zone: '2', region: '10', ship_to: '100' }
    })
    const inval = vi.spyOn(qc, 'invalidateQueries')
    failField = 'ship_to'
    await expect(act(async () => api.context.save('ship_to'))).rejects.toThrow('refused')
    expect(requests.filter((r) => r._method === 'PUT')).toHaveLength(1)
    await vi.waitFor(() =>
      expect(inval).toHaveBeenCalledWith({ queryKey: ['field-defaults', 'orders'] })
    )
  })

  it('defaultFor answers the default for the current context; clear deletes it', async () => {
    await mount({
      defaults: [d('region', '10', { zone: '2' }), d('region', '20', { zone: '5' })],
      initial: { zone: '5', region: '20' },
      canFill: () => false
    })
    expect(api.context.defaultFor('region')?.value).toBe('20')
    await act(async () => api.context.clear('region'))
    expect(
      requests.some((r) => r._method === 'DELETE' && r._path === '/field-defaults/mine/2')
    ).toBe(true)
  })
})

describe('usePersonalDefaults: fix round 1', () => {
  it('clear_on_parent_change: the nulled child is still picked again for the new parent', async () => {
    const rules = {
      region: [{ parent_field: 'zone', filter_column: 'zone', clear_on_parent_change: true }]
    }
    await mount({
      rules,
      defaults: [d('zone', '2'), d('region', '10', { zone: '2' }), d('region', '20', { zone: '5' })]
    })
    expect(draft().region).toBe('10')
    await act(async () => form.personEdit('zone', '5'))
    await flush()
    expect(draft().region).toBe('20')
    expect(api.ledger.get('region')).toBe('20')
  })

  it('a parent that moves while the check runs: the child is picked for the new context', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    await mount({
      initial: { zone: '2' },
      canFill: (f) => f !== 'zone',
      defaults: [d('region', '10', { zone: '2' }), d('region', '20', { zone: '5' })],
      revalidate: async (f) => {
        if (f === 'region' && first) {
          first = false
          await gate
        }
        return true
      }
    })
    await act(async () => form.ruleWrite('zone', '5'))
    await act(async () => release())
    await flush()
    expect(draft().region).toBe('20')
    expect(api.ledger.get('region')).toBe('20')
  })

  it('a check that could not run skips quietly (no "no longer available")', async () => {
    await mount({ defaults: [d('zone', '2')], revalidate: async () => null })
    expect(draft().zone).toBeUndefined()
    expect(api.hintFor('zone')).toBeNull()
  })

  it('no label for the value: the hint never shows a raw id', async () => {
    await mount({
      defaults: [d('zone', '2'), d('ship_to', '100', { zone: '2' })],
      invalid: new Set(['ship_to']),
      valueLabel: () => null
    })
    expect(api.hintFor('ship_to')).toBe('Your saved default is no longer available')
  })

  it('no label for the parent value: "a different <Parent>"', async () => {
    await mount({
      defaults: [d('region', '10', { zone: '2' })],
      initial: { zone: '5' },
      canFill: (f) => f !== 'zone',
      valueLabel: () => null
    })
    expect(api.hintFor('region')).toBe('Your saved default is for a different Zone')
  })

  it('a create that stays on screen keeps no pills', async () => {
    const o: HarnessOpts = { defaults: [d('zone', '2')], resetKey: 'orders:new' }
    await mount(o)
    expect(api.ledger.has('zone')).toBe(true)
    await renderWith({ ...o, isNew: false, resetKey: 'orders:41' })
    expect(api.ledger.size).toBe(0)
    expect(api.context.applied('zone')).toBe(false)
  })

  it("an explicit fill (document autofill) replaces the default's M2M links", async () => {
    await mount({ defaults: [d('tags', ['7', '8'])] })
    expect(form.staged.current.tags).toEqual(['7', '8'])
    await act(async () => api.release('tags'))
    await flush()
    expect(form.staged.current.tags).toEqual([])
    expect(api.ledger.has('tags')).toBe(false)
  })
})

describe('usePersonalDefaults: fix round 2', () => {
  it('a pass still checking when the form moves to another record writes nothing', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const o: HarnessOpts = {
      defaults: [d('zone', '2')],
      resetKey: 'orders:new',
      revalidate: async () => {
        await gate
        return true
      }
    }
    await mount(o)
    expect(calls.set).toEqual([])
    // Create: the same form now shows the saved record.
    await renderWith({ ...o, isNew: false, resetKey: 'orders:41' })
    await act(async () => release())
    await flush()
    expect(calls.set).toEqual([])
    expect(draft().zone).toBeUndefined()
    expect(api.ledger.size).toBe(0)
    expect(calls.auto).toEqual([])
  })
})

describe('usePersonalDefaults: Make default fix round 1', () => {
  const defaults = () => [
    d('zone', '2'),
    d('region', '10', { zone: '2' }),
    d('region', '20', { zone: '5' })
  ]
  it('Clear default on a prefilled field takes it out of the ledger: a parent change keeps it', async () => {
    await mount({ defaults: defaults() })
    expect(api.ledger.get('region')).toBe('10')
    await act(async () => {
      await api.context.clear('region')
    })
    await flush()
    expect(api.ledger.has('region')).toBe(false)
    expect(api.context.applied('region')).toBe(false)
    await act(async () => form.personEdit('zone', '5'))
    await flush()
    // "This field keeps its value": no re-pick, no emptying.
    expect(draft().region).toBe('10')
  })

  it('a failed read still lets the form offer Make default (loaded + failed), never a stuck box', async () => {
    await mount({ defaults: [], getFails: true, initial: { zone: '2' }, canFill: () => false })
    expect(api.context.loaded).toBe(true)
    expect(api.context.failed).toBe(true)
    expect(api.context.defaultFor('zone')).toBeNull()
  })

  it('equal numbers and dates are the default whatever their spelling (field type)', async () => {
    const types: Record<string, string> = { zone: 'decimal', region: 'date', ship_to: 'timestamp' }
    await mount({
      defaults: [
        d('zone', '1.50'),
        d('region', '2026-10-28', { zone: 1.5 }),
        d('ship_to', '2026-10-28T09:00:00.000Z')
      ],
      initial: { zone: 1.5, region: '2026-10-28T00:00:00', ship_to: '2026-10-28T09:00:00Z' },
      canFill: () => false,
      fieldType: (f) => types[f] ?? null
    })
    expect(api.context.isDefault('zone')).toBe(true)
    expect(api.context.isDefault('region')).toBe(true)
    expect(api.context.isDefault('ship_to')).toBe(true)
  })

  it('sameDefaultValue: typed compare for numbers and dates, string compare otherwise', () => {
    expect(sameDefaultValue('1.50', 1.5, 'decimal')).toBe(true)
    expect(sameDefaultValue('1.50', 1.5, 'float')).toBe(true)
    expect(sameDefaultValue('2', 3, 'integer')).toBe(false)
    expect(sameDefaultValue('2026-10-28', '2026-10-28T00:00:00.000Z', 'date')).toBe(true)
    expect(sameDefaultValue('2026-10-28', '2026-10-29', 'date')).toBe(false)
    expect(sameDefaultValue('2026-10-28T09:00:00.000Z', '2026-10-28T09:00:00Z', 'dateTime')).toBe(
      true
    )
    expect(sameDefaultValue('1.50', 1.5)).toBe(false)
  })
})
