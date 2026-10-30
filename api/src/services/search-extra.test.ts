import type { FastifyRequest } from 'fastify'
import knexFactory from 'knex'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: {} }))
vi.mock('../lib/column-probe.js', () => ({ hasColumn: async () => true }))

import type { User } from '../types.js'
import {
  type CommandDeps,
  collectionAliases,
  defaultCommandDeps,
  encodePrefill,
  holdActionMatches,
  labelMatchesVerb,
  parseCommand,
  searchCommands
} from './search-commands.js'
import {
  type ExtraDeps,
  type ExtraHit,
  searchChatHits,
  searchExtra,
  searchFileHits,
  searchTextHits
} from './search-extra.js'
import {
  facetPeopleQuery,
  matchRoles,
  type PeopleDeps,
  parsePeopleFacets,
  searchPeopleExtras,
  singular
} from './search-people.js'

const user = { id: 'U1', role: 'R1' } as unknown as User
const req = { user, isAdmin: false } as unknown as FastifyRequest

// ─── Intent parsing ─────────────────────────────────────────────────────────

describe('parseCommand', () => {
  it('reads holds and remove-holds in their usual phrasings', () => {
    expect(parseCommand('hold 372779')).toEqual({ kind: 'hold', on: true, ref: '372779' })
    expect(parseCommand('put 372779 on hold')).toEqual({ kind: 'hold', on: true, ref: '372779' })
    expect(parseCommand('Remove hold 372779')).toEqual({ kind: 'hold', on: false, ref: '372779' })
    expect(parseCommand('remove the hold on CR26-76773')).toEqual({
      kind: 'hold',
      on: false,
      ref: 'CR26-76773'
    })
    expect(parseCommand('take 372779 off hold')).toEqual({ kind: 'hold', on: false, ref: '372779' })
    expect(parseCommand('release hold #4512')).toEqual({ kind: 'hold', on: false, ref: '4512' })
  })

  it('reads assign with a person', () => {
    expect(parseCommand('assign 372779 to sam')).toEqual({
      kind: 'assign',
      ref: '372779',
      person: 'sam'
    })
    expect(parseCommand('reassign 372779 to Sam Pat')).toMatchObject({ person: 'Sam Pat' })
  })

  it('reads create with and without a for-clause', () => {
    expect(parseCommand('new ir for project 1234')).toEqual({
      kind: 'create',
      thing: 'ir',
      forField: 'project',
      forValue: '1234'
    })
    expect(parseCommand('new purchase order')).toEqual({
      kind: 'create',
      thing: 'purchase order',
      forField: null,
      forValue: null
    })
    expect(parseCommand('create a vendor')).toMatchObject({ kind: 'create', thing: 'vendor' })
  })

  it('reads "<label> <ref>" as a transition', () => {
    expect(parseCommand('approve 372779')).toEqual({
      kind: 'transition',
      verb: 'approve',
      ref: '372779'
    })
    expect(parseCommand('send back CR26-76773')).toEqual({
      kind: 'transition',
      verb: 'send back',
      ref: 'CR26-76773'
    })
  })

  it('leaves ordinary searches alone', () => {
    expect(parseCommand('jane doe')).toBeNull()
    expect(parseCommand('372779')).toBeNull()
    expect(parseCommand('new 372779')).toBeNull()
    expect(parseCommand('hold')).toBeNull()
    expect(parseCommand('xy')).toBeNull()
  })
})

describe('command matching helpers', () => {
  it('matches transition labels on whole words only', () => {
    expect(labelMatchesVerb('Approve', 'approve')).toBe(true)
    expect(labelMatchesVerb('Send back to Planner', 'send back')).toBe(true)
    expect(labelMatchesVerb('Approved', 'approve')).toBe(false)
    expect(labelMatchesVerb('Approve', 'ap')).toBe(false)
  })

  it('tells a hold from a remove-hold', () => {
    expect(holdActionMatches({ key: 'on-hold', label: 'Put on hold' }, true)).toBe(true)
    expect(holdActionMatches({ key: 'on-hold', label: 'Put on hold' }, false)).toBe(false)
    expect(holdActionMatches({ key: 'remove-hold', label: 'Remove hold' }, false)).toBe(true)
    expect(holdActionMatches({ key: 'remove-hold', label: 'Remove hold' }, true)).toBe(false)
    expect(holdActionMatches({ key: 'archive', label: 'Archive' }, true)).toBe(false)
  })

  it('names collections by key, display name and singular', () => {
    expect(collectionAliases('purchase_orders', 'Purchase Orders')).toEqual(
      expect.arrayContaining(['purchase orders', 'purchase order'])
    )
    expect(collectionAliases('inventory_request', null)).toContain('inventory request')
  })

  it('encodes prefill the way the apps decode it', () => {
    const enc = encodePrefill({ project: 7, note: 'é' })
    const json = Buffer.from(decodeURIComponent(enc), 'base64').toString('utf8')
    expect(JSON.parse(json)).toEqual({ project: 7, note: 'é' })
  })
})

// ─── Command permission gates ───────────────────────────────────────────────

function commandDeps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    transitionLabels: async () => ['Approve'],
    findTargets: async () => [{ collection: 'workflows', id: '9', label: 'WF 372779' }],
    bulkActions: async () => [
      {
        key: 'on-hold',
        label: 'Put on hold',
        source: 'db',
        kind: 'update_fields',
        require_reason: true,
        confirm_text: null,
        guard: [{ field: 'is_on_hold', op: 'neq', value: true }]
      }
    ],
    canUpdate: async () => true,
    readRecord: async () => ({ id: 9, is_on_hold: false }),
    transitions: async () => [
      {
        id: 'T1',
        label: 'Approve',
        to_label: 'Approved',
        needs_comment: false,
        has_requirements: false
      }
    ],
    ownerStep: async () => ({ state: 'S1', state_label: 'Review' }),
    findPeople: async () => [{ id: 'P1', name: 'Sam Pat' }],
    creatable: async () => [{ collection: 'inventory_request', display_name: 'Inventory Request' }],
    prefillFor: async () => ({ field: 'project', id: '55', label: 'Project 1234' }),
    ...over
  }
}

const run = (q: string, deps: CommandDeps, hits = []) =>
  searchCommands(user, q, hits, { isAdmin: false, req, deps })

describe('searchCommands gates', () => {
  it('offers a hold the caller may run, with the bulk-run request', async () => {
    const [c] = await run('hold 372779', commandDeps())
    expect(c).toMatchObject({
      kind: 'hold',
      collection: 'workflows',
      item: '9',
      payload: {
        method: 'POST',
        path: '/bulk-actions/run',
        body: { collection: 'workflows', key: 'on-hold', ids: ['9'] },
        require_reason: true
      }
    })
    expect(c.confirm).toContain('WF 372779')
  })

  it('hides a hold when the caller cannot update the record', async () => {
    expect(await run('hold 372779', commandDeps({ canUpdate: async () => false }))).toEqual([])
  })

  it('hides a hold when no action is available to the caller', async () => {
    expect(await run('hold 372779', commandDeps({ bulkActions: async () => [] }))).toEqual([])
  })

  it('hides a hold when the guard says it is already on hold', async () => {
    const deps = commandDeps({ readRecord: async () => ({ id: 9, is_on_hold: true }) })
    expect(await run('hold 372779', deps)).toEqual([])
  })

  it('hides a hold when the record is not readable', async () => {
    expect(await run('hold 372779', commandDeps({ readRecord: async () => null }))).toEqual([])
    expect(await run('hold 372779', commandDeps({ findTargets: async () => [] }))).toEqual([])
  })

  it('offers a transition through the instance transition route', async () => {
    const [c] = await run('approve 372779', commandDeps())
    expect(c.payload).toEqual({
      method: 'POST',
      path: '/pipelines/instance/workflows/9/transition',
      body: { transition_id: 'T1' },
      needs_comment: false,
      has_requirements: false
    })
    expect(c.confirm).toContain('Approved')
  })

  it('hides a transition the gate chain refuses', async () => {
    expect(await run('approve 372779', commandDeps({ transitions: async () => [] }))).toEqual([])
  })

  it('never looks for a record when no transition label matches the verb', async () => {
    const findTargets = vi.fn(async () => [])
    const out = await run('zone 3', commandDeps({ findTargets }))
    expect(out).toEqual([])
    expect(findTargets).not.toHaveBeenCalled()
  })

  it('offers assign only when the caller may hand off the current step', async () => {
    const [c] = await run('assign 372779 to sam', commandDeps())
    expect(c.payload).toEqual({
      method: 'POST',
      path: '/pipelines/instance/workflows/9/owners',
      body: { user: 'P1', state: 'S1' }
    })
    expect(await run('assign 372779 to sam', commandDeps({ ownerStep: async () => null }))).toEqual(
      []
    )
  })

  it('offers create only on creatable collections, prefilled when the value is certain', async () => {
    const [c] = await run('new ir for project 1234', commandDeps())
    expect(c.kind).toBe('create')
    const nav = (c.payload as { navigate: { href: string; admin_href: string } }).navigate
    expect(nav.href).toMatch(/^\/records\/inventory_request\/new\?prefill=/)
    expect(nav.admin_href).toMatch(/^\/collections\/inventory_request\/new\?prefill=/)
    expect((c.payload as { prefill: unknown }).prefill).toEqual({ project: '55' })
    expect(await run('new ir', commandDeps({ creatable: async () => [] }))).toEqual([])
  })

  it('takes the target from a search hit (already read as the caller) before any lookup', async () => {
    const targets = await defaultCommandDeps.findTargets(user, '372779', [
      { collection: 'workflows', id: 9, label: 'WF', snippet: '372779' },
      { collection: 'units', id: 4, label: 'Other', snippet: 'x' }
    ])
    expect(targets).toEqual([{ collection: 'workflows', id: '9', label: 'WF' }])
  })
})

// ─── Extra hits gates ───────────────────────────────────────────────────────

function extraDeps(over: Partial<ExtraDeps> = {}): ExtraDeps {
  return {
    commentRows: async () => [
      {
        id: 'C1',
        collection: 'workflows',
        item: '9',
        text: '<p>wrong cifa on line 7</p>',
        kind: 'comment'
      },
      { id: 'C2', collection: 'workflows', item: '10', text: 'wrong cifa again', kind: 'comment' }
    ],
    noteRows: async () => [
      { id: 'history:5', collection: 'workflows', item: '9', text: 'wrong cifa', kind: 'note' }
    ],
    visibleIds: async (_u, _c, ids) => ids.filter((i) => i === '9'),
    recordLabels: async () => ({ 'workflows:9': 'WF 372779' }),
    displayNames: async () => new Map([['workflows', 'Workflows']]),
    fileRows: async () => [
      { id: 'F1', filename_download: 'quote.pdf', title: null, uploaded_by: null },
      { id: 'F2', filename_download: 'secret.pdf', title: null, uploaded_by: null }
    ],
    readableFiles: async () => new Set(['f1']),
    fileRefs: async () => new Map([['f1', [{ collection: 'workflows', id: '10' }]]]),
    videos: async () => [
      { kind: 'video', id: 'V1', label: 'Video', href: '/help/videos?watch=v1' }
    ],
    docs: async () => [{ kind: 'doc', id: 'D1', label: 'Docs', href: '/docs?section=d1' }],
    channelRows: async () => [
      { key: 'ops', name: 'Ops', topic: null },
      { key: 'secret', name: 'Secret', topic: null }
    ],
    canSeeRoom: async (_u, room) => room === 'ch:ops',
    configHits: async (_p, _c, isAdmin) =>
      isAdmin ? [{ kind: 'flow', id: '1', label: 'Wrong cifa flow', href: '/flows/1' }] : [],
    ...over
  }
}

describe('extra hits are judged as the caller', () => {
  it('keeps comments and notes only on records the caller can open', async () => {
    const hits = await searchTextHits(user, 'wrong cifa', false, extraDeps())
    expect(hits.map((h) => h.id)).toEqual(['C1', 'history:5'])
    expect(hits[0]).toMatchObject({
      kind: 'comment',
      label: 'WF 372779',
      href: '/records/workflows/9?comment=C1',
      admin_href: '/collections/workflows/9?comment=C1',
      collection: 'workflows',
      item: '9'
    })
    expect(hits[0].snippet).toBe('wrong cifa on line 7')
    expect(hits[1].kind).toBe('note')
  })

  it('drops every comment when the parent gate fails', async () => {
    const deps = extraDeps({ visibleIds: async () => [] })
    expect(await searchTextHits(user, 'wrong cifa', false, deps)).toEqual([])
  })

  it('keeps only readable files and links a record only the caller can open', async () => {
    const hits = await searchFileHits(user, 'pdf', req, extraDeps())
    expect(hits.map((h) => h.id)).toEqual(['F1'])
    // The record using it (10) is not visible: no record link.
    expect(hits[0].href).toBe('/api/files/F1')
    expect(hits[0].collection).toBeUndefined()
    const linked = await searchFileHits(
      user,
      'pdf',
      req,
      extraDeps({ visibleIds: async (_u, _c, ids) => ids })
    )
    expect(linked[0].href).toBe('/records/workflows/10?file=F1')
  })

  it('lists only chat channels whose room the caller can see', async () => {
    const hits = await searchChatHits(user, 'op', extraDeps())
    expect(hits.map((h: ExtraHit) => h.id)).toEqual(['ch:ops'])
    expect(hits[0].href).toBe('/chat?room=ch%3Aops')
  })

  it('answers config for administrators only', async () => {
    const asUser = await searchExtra(user, 'wrong cifa', { isAdmin: false, req, deps: extraDeps() })
    expect(asUser.config).toBeUndefined()
    expect(asUser.comments?.length).toBe(2)
    expect(asUser.videos?.length).toBe(1)
    const asAdmin = await searchExtra(user, 'wrong cifa', {
      isAdmin: true,
      req: { ...req, isAdmin: true } as FastifyRequest,
      deps: extraDeps()
    })
    expect(asAdmin.config?.[0].kind).toBe('flow')
  })

  it('passes the caller admin flag to the docs audience', async () => {
    const docs = vi.fn(async () => [] as ExtraHit[])
    await searchExtra(user, 'layouts', { isAdmin: false, req, deps: extraDeps({ docs }) })
    expect(docs).toHaveBeenCalledWith('layouts', false, 5)
  })

  it('skips the scans for short queries and survives a failing kind', async () => {
    expect(await searchExtra(user, 'ab', { isAdmin: false, req, deps: extraDeps() })).toEqual({})
    const out = await searchExtra(user, 'wrong cifa', {
      isAdmin: false,
      req,
      deps: extraDeps({
        videos: async () => {
          throw new Error('down')
        }
      })
    })
    expect(out.videos).toBeUndefined()
    expect(out.comments).toBeDefined()
  })

  it('under a search budget: a kind still running at the deadline is left out and named', async () => {
    const { SearchBudget } = await import('./search-budget.js')
    const budget = new SearchBudget(60)
    const out = await searchExtra(user, 'wrong cifa', {
      isAdmin: false,
      req,
      budget,
      deps: extraDeps({ fileRows: () => new Promise(() => {}) })
    })
    budget.finish()
    expect(out.files).toBeUndefined()
    expect(out.comments).toBeDefined()
    expect([...budget.timedOut]).toEqual(['files'])
  })
})

// ─── People ─────────────────────────────────────────────────────────────────

const roles = [
  { id: 'R-PLAN', name: 'Planner' },
  { id: 'R-BUY', name: 'Field Buyer' }
]

function peopleDeps(over: Partial<PeopleDeps> = {}): PeopleDeps {
  return {
    roles: async () => roles,
    zoneMatches: async (phrases) =>
      phrases.includes('zone 3') ? [{ dimension: 'zone', id: '3', label: 'Zone 3' }] : [],
    usersInZone: async () => ['U9'],
    facetPeople: async () => [
      { id: 'U9', first_name: 'Pat', last_name: 'Lee', email: 'p@x', title: 'Planner II' }
    ],
    roleNamesOf: async () => new Map([['U9', 'Planner']]),
    zonesOf: async () => new Map([['U9', ['Zone 3']]]),
    ...over
  }
}

describe('people extras', () => {
  it('singularises role words', () => {
    expect(singular('planners')).toBe('planner')
    expect(singular('boxes')).toBe('box')
    expect(singular('bus')).toBe('bus')
    expect(matchRoles(['buyers'], roles).ids).toEqual(['R-BUY'])
  })

  it('reads "planners zone 3" as role + zone facets', async () => {
    expect(await parsePeopleFacets('planners zone 3', peopleDeps())).toEqual({
      roleIds: ['R-PLAN'],
      zones: [{ dimension: 'zone', id: '3', label: 'Zone 3' }],
      terms: []
    })
    expect(await parsePeopleFacets('jane doe', peopleDeps())).toBeNull()
  })

  it('finds facet people first and decorates every person', async () => {
    const facetPeople = vi.fn(peopleDeps().facetPeople)
    const out = await searchPeopleExtras(
      user,
      'planners zone 3',
      [{ id: 'U2', first_name: 'A', last_name: 'B', email: null, title: null }],
      { isAdmin: false, deps: peopleDeps({ facetPeople }) }
    )
    expect(facetPeople).toHaveBeenCalledWith({
      roleIds: ['R-PLAN'],
      userIds: ['U9'],
      terms: [],
      isAdmin: false
    })
    expect(out.map((p) => p.id)).toEqual(['U9', 'U2'])
    expect(out[0]).toMatchObject({ role_name: 'Planner', zones: ['Zone 3'], title: 'Planner II' })
    expect(out[1]).toMatchObject({ role_name: null, title: null })
  })

  it('the facet query keeps a non-admin to the directory', () => {
    const k = knexFactory({ client: 'mssql' })
    const sql = facetPeopleQuery(k, {
      roleIds: ['R-PLAN'],
      userIds: null,
      terms: ['pat'],
      isAdmin: false
    })!
      .toSQL()
      .sql.toLowerCase()
    expect(sql).toContain('[account_kind] is null')
    expect(sql).toContain('[is_redacted]')
    expect(sql).not.toContain('[status], [account_kind]')
    expect(sql).toContain('[role] in')
    // No id readable → nobody.
    expect(
      facetPeopleQuery(k, { roleIds: null, userIds: ['U9'], terms: [], isAdmin: false }, [])
    ).toBeNull()
    // A zone with no holders → nobody.
    expect(
      facetPeopleQuery(k, { roleIds: null, userIds: [], terms: [], isAdmin: false })
    ).toBeNull()
  })
})
