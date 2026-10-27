import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// No DB: overrides and branding reads fail and the stock chrome stands in.
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ select: () => Promise.reject(new Error('no db in test')) }))
}))

import {
  buildMailEngine,
  mailOutputEscapeEnabled,
  renderMailTemplate,
  SafeHtml,
  safeHtml
} from '../../../services/mail.js'

const ROOT = fileURLToPath(new URL('../../../../templates/mail', import.meta.url))
const TEMPLATES = readdirSync(ROOT)
  .filter((f) => f.endsWith('.liquid'))
  .map((f) => f.replace(/\.liquid$/, ''))

const AT = '2026-10-01T12:00:00Z'
const URL_ = 'https://app.example.com/r/1'
const steps = [
  { status: 'done', label: 'Submit', by: 'Sam Park', at: AT },
  { status: 'current', label: 'Manager', owners: ['Kim Lee', 'Jo Ray'] },
  { status: 'upcoming', label: 'Finance', owners: ['Ana Diaz'] },
  { status: 'skipped', label: 'Legal', skip_reason: 'Under limit' }
]

// Safe values only: no & < > " ' — the parity guarantee is for text that needs no escaping.
const SAFE: Record<string, unknown> = {
  subject: 'Weekly report ready',
  message: 'Your report is ready to view',
  first_name: 'Kim',
  category: 'system',
  action_url: URL_,
  action_label: 'Open it',
  record_card: {
    title: 'CR26-0001',
    collection_label: 'Change requests',
    url: URL_,
    fields: [
      { label: 'Status', value: 'Open' },
      { label: 'Owner', value: 'Kim Lee' }
    ]
  },
  decision: 'granted',
  applied: ['role Editor', 'scope East'],
  target_label: 'Change request 1',
  record_url: URL_,
  days: 7,
  requester_name: 'Sam Park',
  requester_email: 'sam@example.com',
  note: 'Need this for the audit',
  reasons: ['Not in scope', 'Role is Viewer'],
  manage_url: URL_,
  kind: 'requested',
  rule_name: 'Budget over',
  widget_title: 'Spend',
  conditions: [{ label: 'Total', now: '12' }],
  report_url: URL_,
  metric_name: 'Spend',
  metric_value: '1200',
  operator: 'over',
  threshold_value: '1000',
  detail: 'Spend went up',
  frequency: 'daily',
  alert_count: 2,
  alerts: [
    {
      rule_name: 'A',
      metric_name: 'm',
      metric_value: '1',
      operator: 'over',
      threshold_value: '0'
    }
  ],
  chain_name: 'Purchase approval',
  step_label: 'Manager',
  requested_by: 'Sam Park',
  actor_name: 'Kim Lee',
  comment: 'Looks good to me',
  approvals_url: URL_,
  steps,
  friendly_id: 'CR26-0001',
  count: 3,
  field_label: 'Serial',
  channel_wide: false,
  sender_name: 'Kim Lee',
  room_label: 'General',
  excerpt: 'Can you check this',
  chat_url: URL_,
  queue_name: 'Intake',
  items: [{ url: URL_, label: 'Item 1' }],
  queue_url: URL_,
  event: 'update',
  changes: [{ label: 'Status', old: 'Open', new: 'Closed' }],
  tier: 2,
  state_label: 'Review',
  days_past: 3,
  hours_past: 72,
  subscription_label: 'Following',
  collection: 'change_requests',
  item: '1',
  task_title: 'Check serials',
  assigned_by: 'Kim Lee',
  due_label: 'Oct 30',
  task_description: 'Count them all',
  tasks_url: URL_,
  tasks: [{ url: URL_, title: 'Task A', due_label: 'Oct 30' }],
  from_name: 'Jo Ray',
  project_name: 'Acme',
  login_url: URL_,
  actor_self_name: 'Kim Lee',
  actor_email: 'kim@example.com',
  on_behalf_of: { name: 'Jo Ray' },
  transitioned_at: AT,
  from_state: { label: 'Draft' },
  to_state: { label: 'Review', is_terminal: false },
  comment_is_human: true,
  approval_chain: steps,
  latest_comment: { text: 'Latest note here', author_name: 'Ana Diaz', at: AT },
  transition_label: 'Submit',
  transition_text: 'Sent for review',
  source: 'manual',
  days_in_previous_state: 3,
  owners: [{ first_name: 'Kim', last_name: 'Lee' }],
  brief: {
    field_changes: [{ label: 'Qty', old: '1', new: '2' }],
    changed_total: 3,
    comments: 2,
    addendums: { count: 1, cost_impact: 12.5 }
  },
  why: 'you own this record',
  rules_url: 'https://app.example.com/profile',
  eyebrow: 'Report',
  eyebrow_tone: 'warn',
  heading: 'Nightly check',
  lead: 'All checks ran',
  facts: [
    { label: 'Checked', value: '12' },
    { label: 'Failed', value: '1', tone: 'danger' }
  ],
  quote: 'Disk at 91 percent',
  quote_label: 'Detail',
  secondary_url: URL_,
  secondary_label: 'Runbook',
  footnote: 'Runs nightly',
  title: 'Daily summary'
}

// Variants so both branches of the bigger templates render.
const VARIANTS: Array<Record<string, unknown>> = [
  {},
  {
    kind: 'report',
    decision: 'declined',
    channel_wide: true,
    actor_name: null,
    source: 'auto',
    via_child: { collection_label: 'Lines', label: 'Line 2', event: 'update' }
  },
  { kind: 'rejected', decision: 'expired', days_past: 1, comment_is_human: false }
]

const BRAND = {
  logo: 'https://cdn.example.com/logo.png',
  sender_name: 'Acme Ops',
  footer: 'Acme Inc, 1 Main St',
  color: '#123456',
  workspace_id: null
}
const FRAGMENT = '<p style="margin:0">Hello <b>there</b></p>'

const legacyCtx = (v: Record<string, unknown>) => ({ ...SAFE, ...v, html: FRAGMENT, brand: BRAND })
const escapedCtx = (v: Record<string, unknown>) => ({
  ...SAFE,
  ...v,
  html: safeHtml(FRAGMENT),
  brand: {
    ...BRAND,
    logo: safeHtml(BRAND.logo),
    sender_name: safeHtml(BRAND.sender_name),
    footer: safeHtml(BRAND.footer)
  }
})

afterEach(() => {
  delete process.env.MAIL_OUTPUT_ESCAPE
})

describe('mail outputEscape (M27) — every core template renders safe values exactly as before', () => {
  const legacy = buildMailEngine([ROOT], false)
  const escaped = buildMailEngine([ROOT], true)

  it('finds the templates', () => {
    expect(TEMPLATES.length).toBeGreaterThan(15)
  })

  // The only difference: a template's own literal button label with a bare `&` is now printed
  // as `&amp;` — the same text in every mail client, and valid HTML.
  const KNOWN: Record<string, (s: string) => string> = {
    sla_escalation: (s) => s.replace('Open & acknowledge', 'Open &amp; acknowledge')
  }

  for (const name of TEMPLATES) {
    it(`${name}.liquid`, async () => {
      for (const v of VARIANTS) {
        const before = await legacy.renderFile(name, legacyCtx(v))
        const after = await escaped.renderFile(name, escapedCtx(v))
        expect(after).toBe((KNOWN[name] ?? ((s: string) => s))(before))
      }
    })
  }
})

describe('mail outputEscape (M27) — values cannot add markup', () => {
  const escaped = buildMailEngine([ROOT], true)
  const evil = '<img src=x onerror=alert(1)>'

  it('escapes record values, comments and names in the approver emails', async () => {
    const html = await escaped.renderFile('workflow_transition', {
      ...escapedCtx({}),
      friendly_id: evil,
      actor_name: `<a href="https://evil.example">Kim</a>`,
      comment: evil,
      latest_comment: { text: '<script>steal()</script>', author_name: 'x', at: AT },
      record_card: { title: evil, url: URL_, fields: [{ label: 'L', value: evil }] }
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>steal')
    expect(html).not.toContain('<a href="https://evil.example">')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('a quote in a value cannot leave an attribute', async () => {
    const html = await escaped.renderFile('queue_entry', {
      ...escapedCtx({}),
      items: [{ url: 'https://x.example/" onmouseover="alert(1)', label: 'i' }]
    })
    expect(html).not.toContain('" onmouseover="')
    expect(html).toContain('&#34; onmouseover=&#34;')
  })

  it('| escape is a single escape, not a double one', async () => {
    const html = await escaped.renderFile('notification', {
      ...escapedCtx({}),
      message: 'a < b & c'
    })
    expect(html).toContain('a &lt; b &amp; c')
    expect(html).not.toContain('&amp;lt;')
  })

  it('an app-built SafeHtml fragment prints as is in templates without | raw', async () => {
    const out = await escaped.parseAndRender('<div>{{ html }}</div><i>{{ text }}</i>', {
      html: safeHtml('<b>trusted</b>'),
      text: '<b>untrusted</b>'
    })
    expect(out).toBe('<div><b>trusted</b></div><i>&lt;b&gt;untrusted&lt;/b&gt;</i>')
  })
})

describe('mail outputEscape (M27) — the service', () => {
  it('is on by default; MAIL_OUTPUT_ESCAPE=off turns it off', () => {
    expect(mailOutputEscapeEnabled()).toBe(true)
    process.env.MAIL_OUTPUT_ESCAPE = 'off'
    expect(mailOutputEscapeEnabled()).toBe(false)
  })

  it('renderMailTemplate escapes data and keeps the brand chrome', async () => {
    const html = await renderMailTemplate('task_assigned', {
      task_title: '<b>Do it</b>',
      task_description: '<img src=x>',
      record_url: URL_
    })
    expect(html).toContain('&lt;b&gt;Do it&lt;/b&gt;')
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('<title>Nivaro</title>')
    expect(new SafeHtml('x').toString()).toBe('x')
  })
})
