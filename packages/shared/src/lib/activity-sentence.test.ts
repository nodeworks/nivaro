import { describe, expect, it } from 'vitest'
import {
  type ActivityEntryInput,
  type ActivityLabels,
  actionParts,
  activityLabelRefs,
  activityWhy,
  actorName,
  actorOf,
  collectionNouns,
  groupActivity,
  HIDDEN_RECORD,
  parseTransitionComment,
  renderActivityGroupSentence,
  renderActivitySentence
} from './activity-sentence'

const PAT = 'aaaaaaaa-0000-0000-0000-000000000001'
const ROB = 'aaaaaaaa-0000-0000-0000-000000000002'

const labels: ActivityLabels = {
  users: { [PAT.toUpperCase()]: 'Pat Lee', [ROB.toUpperCase()]: 'Rob Lee' },
  records: {
    'purchase_orders:4471': 'PO 4471',
    'workflows:85607': '85607',
    'invoices:9': null,
    'nivaro_api_keys:3': 'Partner sync'
  },
  collections: {
    purchase_orders: { singular: 'PO', plural: 'POs' },
    workflows: { singular: 'Workflow', plural: 'Workflows' },
    invoices: { singular: 'Invoice', plural: 'Invoices' }
  },
  fields: { 'workflows.vendor': 'Vendor', 'workflows.status': 'Status' },
  choices: { 'workflows.status': { on_hold: 'On Hold' } },
  links: { 'workflows.vendor': 'vendors' }
}

const base = (over: Partial<ActivityEntryInput>): ActivityEntryInput => ({
  id: 1,
  action: 'update',
  user: PAT,
  first_name: 'Pat',
  last_name: 'Lee',
  timestamp: '2026-10-29T12:00:00Z',
  ...over
})

describe('renderActivitySentence', () => {
  it('reads a transition from its stored comment', () => {
    expect(
      renderActivitySentence(
        base({
          action: 'pipeline-transition',
          collection: 'purchase_orders',
          item: '4471',
          comment: 'Draft → Approved via Approve — "looks good"'
        }),
        labels
      )
    ).toBe('Pat Lee moved PO 4471 from Draft to Approved')
  })

  it('reads a folded-in history event', () => {
    expect(
      renderActivitySentence(
        base({
          action: 'transition',
          collection: 'purchase_orders',
          item: '4471',
          event: { kind: 'transition', from_label: 'Draft', to_label: 'Approved' }
        }),
        labels
      )
    ).toBe('Pat Lee moved PO 4471 from Draft to Approved')
  })

  it('covers create / update / delete / restore', () => {
    const w = { collection: 'workflows', item: '85607' }
    expect(renderActivitySentence(base({ ...w, action: 'create' }), labels)).toBe(
      'Pat Lee created Workflow 85607'
    )
    expect(
      renderActivitySentence(
        base({ ...w, user: ROB, changes: [{ field: 'vendor', value: 12 }] }),
        labels
      )
    ).toBe('Rob Lee changed Vendor on Workflow 85607')
    expect(
      renderActivitySentence(
        base({ ...w, changes: [{ field: 'status', value: 'on_hold' }] }),
        labels
      )
    ).toBe('Pat Lee set Status to On Hold on Workflow 85607')
    expect(renderActivitySentence(base({ ...w }), labels)).toBe('Pat Lee updated Workflow 85607')
    expect(renderActivitySentence(base({ ...w, action: 'delete' }), labels)).toBe(
      'Pat Lee deleted Workflow 85607'
    )
    expect(renderActivitySentence(base({ ...w, action: 'restore' }), labels)).toBe(
      'Pat Lee restored Workflow 85607'
    )
  })

  it('never names a record the reader cannot see', () => {
    const s = renderActivitySentence(
      base({ action: 'delete', collection: 'invoices', item: '9' }),
      labels
    )
    expect(s).toBe(`Pat Lee deleted ${HIDDEN_RECORD}`)
    expect(s).not.toContain('9')
  })

  it('falls back to the collection and id before labels arrive', () => {
    expect(
      renderActivitySentence(base({ action: 'create', collection: 'vendor_sites', item: '12' }))
    ).toBe('Pat Lee created Vendor Site 12')
  })

  it('covers sign-in, export, view-as, tokens, keys, settings, roles, imports, bulk', () => {
    expect(renderActivitySentence(base({ action: 'login' }), labels)).toBe('Pat Lee signed in')
    expect(renderActivitySentence(base({ action: 'logout' }), labels)).toBe('Pat Lee signed out')
    expect(
      renderActivitySentence(
        base({ action: 'export', collection: 'invoices', comment: 'csv · 120 rows' }),
        labels
      )
    ).toBe('Pat Lee exported 120 invoices to CSV')
    expect(
      renderActivitySentence(
        base({ action: 'masquerade-start', user: ROB, collection: 'nivaro_users', item: PAT }),
        labels
      )
    ).toBe('Rob Lee started viewing as Pat Lee')
    expect(
      renderActivitySentence(
        base({ action: 'token.generate', user: ROB, collection: 'nivaro_users', item: PAT }),
        labels
      )
    ).toBe('Rob Lee generated a static token for Pat Lee')
    expect(
      renderActivitySentence(
        base({ action: 'api_key_revoked', collection: 'nivaro_api_keys', item: '3' }),
        labels
      )
    ).toBe('Pat Lee revoked API key Partner sync')
    expect(
      renderActivitySentence(
        base({
          action: 'update',
          collection: 'nivaro_settings',
          item: '1',
          changed_fields: ['smtp_host']
        }),
        labels
      )
    ).toBe('Pat Lee changed the Smtp Host setting')
    expect(
      renderActivitySentence(
        base({ action: 'set_role', collection: 'nivaro_users', item: ROB }),
        labels
      )
    ).toBe('Pat Lee changed the role of Rob Lee')
    expect(
      renderActivitySentence(base({ action: 'update', collection: 'nivaro_policies', item: '7' }))
    ).toBe('Pat Lee updated Policy 7')
    expect(
      renderActivitySentence(
        base({ action: 'import-create', collection: 'invoices', item: '5' }),
        labels
      )
    ).toBe('Pat Lee started an import into invoices')
    expect(
      renderActivitySentence(
        base({
          action: 'bulk-action-execute',
          collection: 'invoices',
          comment: 'Hold (hold) on 40 item(s): 40 done, 0 skipped, 0 failed'
        }),
        labels
      )
    ).toBe('Pat Lee ran “Hold” on 40 invoices')
    expect(
      renderActivitySentence(
        base({
          action: 'pipeline-start',
          collection: 'purchase_orders',
          item: '4471',
          comment: 'Started pipeline — initial state: Draft'
        }),
        labels
      )
    ).toBe('Pat Lee started PO 4471 in Draft')
  })

  it('reads other actions from their own words', () => {
    expect(renderActivitySentence(base({ action: 'layout-schedule-cancel' }))).toBe(
      'Pat Lee cancelled the layout schedule'
    )
    expect(renderActivitySentence(base({ action: 'sql-checks-run' }))).toBe(
      'Pat Lee ran SQL checks'
    )
    expect(renderActivitySentence(base({ action: 'session-replay-share-create' }))).toBe(
      'Pat Lee created a session replay share'
    )
    expect(renderActivitySentence(base({ action: 'tuning-settings' }))).toBe(
      'Pat Lee changed the tuning settings'
    )
    expect(renderActivitySentence(base({ action: 'flow-replay' }))).toBe(
      'Pat Lee replayed the flow'
    )
  })

  it('falls back to a readable title for an unknown action', () => {
    expect(renderActivitySentence(base({ action: 'team-kudos' }))).toBe(
      'Pat Lee recorded “Team kudos”'
    )
    expect(renderActivitySentence(base({ action: 'x', user: null }))).toBe('System recorded “X”')
  })
})

describe('actor', () => {
  it('prefers the stored actor', () => {
    const e = base({ actor: JSON.stringify({ kind: 'view_as', id: ROB, on_behalf_of: PAT }) })
    expect(actorOf(e).kind).toBe('view_as')
    expect(actorName(e, labels)).toBe('Rob Lee as Pat Lee')
  })

  it('derives old rows from their columns', () => {
    expect(actorName(base({ mcp_conn: 'oabc', via_app: 'Claude' }), labels)).toBe(
      'Claude for Pat Lee'
    )
    expect(
      actorName(
        base({ auth_method: 'api_key', api_key_id: 3, api_key_name: 'Partner sync' }),
        labels
      )
    ).toBe('API key “Partner sync”')
    expect(actorOf(base({ auth_method: 'masquerade' })).kind).toBe('view_as')
    expect(actorName(base({ user: null, chain_parent: 'cron:vendor-sync' }), labels)).toBe(
      'Scheduled job “vendor-sync”'
    )
    expect(actorOf(base({ chain_parent: 'import_run:12' }))).toMatchObject({
      kind: 'import',
      id: '12'
    })
    expect(actorOf(base({ chain_parent: 'flow_run:abc' }))).toMatchObject({
      kind: 'flow',
      id: 'abc'
    })
    expect(actorName(base({ action: 'create', comment: 'import:vendors:file.csv' }), labels)).toBe(
      'Import “vendors”'
    )
    expect(actorOf(base({ user: null })).kind).toBe('system')
    expect(actorName(base({}), labels)).toBe('Pat Lee')
  })

  it('names a flow and an import from the stored actor', () => {
    expect(actorName(base({ actor: { kind: 'flow', id: 'f1', name: 'Notify owners' } }))).toBe(
      'Flow “Notify owners”'
    )
    expect(actorName(base({ actor: { kind: 'import', id: 'po', name: 'PO lines' } }))).toBe(
      'Import “PO lines”'
    )
  })
})

describe('why', () => {
  it('splits the transition note and the change reason', () => {
    expect(
      activityWhy(
        base({
          action: 'pipeline-transition',
          comment: 'Draft → Approved via Approve — "ok by me"'
        })
      ).note
    ).toBe('ok by me')
    expect(activityWhy(base({ action: 'update', comment: 'vendor renamed' })).reason).toBe(
      'vendor renamed'
    )
    expect(activityWhy(base({ action: 'create', comment: 'import:x:y.csv' })).reason).toBeNull()
    expect(
      activityWhy(
        base({
          why: { approval: { decision: 'approved', chain: 'Capex', step: 2, comment: 'fine' } }
        })
      ).approval
    ).toBe('Approved · Capex · step 2 — “fine”')
  })

  it('parses every stored transition comment shape', () => {
    expect(parseTransitionComment('→ On Hold via Hold (bulk: Hold all) — "waiting"')).toMatchObject(
      {
        from: null,
        to: 'On Hold',
        via: 'Hold',
        note: 'waiting'
      }
    )
    expect(parseTransitionComment('bulk: Approve → Approved')).toMatchObject({
      to: 'Approved',
      via: 'Approve'
    })
    expect(parseTransitionComment('auto-transition "Escalate"')).toMatchObject({
      auto: true,
      via: 'Escalate'
    })
    expect(parseTransitionComment('Start → Draft via Begin')).toMatchObject({
      from: null,
      to: 'Draft'
    })
  })
})

describe('groupActivity', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 29, 12, 0, s)).toISOString()

  it('folds a group_key burst and renders one line', () => {
    const rows = [1, 2, 3].map((i) =>
      base({
        id: i,
        collection: 'workflows',
        item: String(100 + i),
        group_key: 'bulk:r1',
        changes: [{ field: 'status', value: 'on_hold' }],
        timestamp: t(i)
      })
    )
    const groups = groupActivity([...rows, base({ id: 9, action: 'login' })])
    expect(groups).toHaveLength(2)
    expect(groups[0].by).toBe('group_key')
    expect(renderActivityGroupSentence(groups[0].entries, labels)).toBe(
      'Pat Lee updated 3 workflows: Status → On Hold'
    )
  })

  it('falls back to same actor + collection + action within 60 s for old rows', () => {
    const rows = [
      base({ id: 1, action: 'delete', collection: 'invoices', item: '1', timestamp: t(50) }),
      base({ id: 2, action: 'delete', collection: 'invoices', item: '2', timestamp: t(20) }),
      base({ id: 3, action: 'delete', collection: 'invoices', item: '3', timestamp: t(0) })
    ]
    const groups = groupActivity(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0].by).toBe('time')
    expect(renderActivityGroupSentence(groups[0].entries, labels)).toBe(
      'Pat Lee deleted 3 invoices'
    )
  })

  it('does not fold different people, actions or gaps over the window', () => {
    const groups = groupActivity([
      base({ id: 1, action: 'delete', collection: 'invoices', item: '1', timestamp: t(59) }),
      base({
        id: 2,
        action: 'delete',
        collection: 'invoices',
        item: '2',
        user: ROB,
        timestamp: t(58)
      }),
      base({
        id: 3,
        action: 'update',
        collection: 'invoices',
        item: '3',
        user: ROB,
        timestamp: t(57)
      }),
      base({
        id: 4,
        action: 'update',
        collection: 'invoices',
        item: '4',
        user: ROB,
        timestamp: '2026-10-29T11:00:00Z'
      })
    ])
    expect(groups.map((g) => g.entries.length)).toEqual([1, 1, 1, 1])
  })

  it('a burst of transitions names the shared target state', () => {
    const rows = [1, 2].map((i) =>
      base({
        id: i,
        action: 'pipeline-transition',
        collection: 'purchase_orders',
        item: String(i),
        group_key: 'bulk:x',
        comment: `→ On Hold via Hold (bulk: Hold all)`
      })
    )
    expect(renderActivityGroupSentence(rows, labels)).toBe('Pat Lee moved 2 POs to On Hold')
  })
})

describe('helpers', () => {
  it('splits actions into verb and noun', () => {
    expect(actionParts('report-alert-create')).toMatchObject({
      past: 'created',
      noun: 'report alert'
    })
    expect(actionParts('pause_job')).toMatchObject({ past: 'paused', noun: 'job' })
    expect(actionParts('team-kudos').past).toBeNull()
  })

  it('names collections', () => {
    expect(collectionNouns('nivaro_api_keys')).toEqual({ singular: 'API key', plural: 'API keys' })
    expect(collectionNouns('categories')).toEqual({ singular: 'Category', plural: 'Categories' })
  })

  it('lists what to ask the labels endpoint for', () => {
    const req = activityLabelRefs([
      base({ collection: 'workflows', item: '1', changes: [{ field: 'status' }] }),
      base({ actor: { kind: 'view_as', id: ROB, on_behalf_of: PAT } })
    ])
    expect(req.refs).toEqual([{ collection: 'workflows', id: '1' }])
    expect(req.users.sort()).toEqual([PAT, ROB].sort())
    expect(req.fields).toEqual([{ collection: 'workflows', field: 'status' }])
  })
})
