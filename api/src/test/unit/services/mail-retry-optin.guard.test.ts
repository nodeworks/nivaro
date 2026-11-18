import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Migration 536: automatic mail retry is OPT-IN. Only senders with no retry of their own pass
// `autoRetry: true`; a sender that re-sends by itself (notification outbox, escalation cron, flow
// dead letters, report / digest Send now, test sends) must never — the email would go twice.
// Adding a sender here is a decision: check it has no retry of its own first.

const SRC = join(import.meta.dirname, '../../..')

const OPTED_IN: Record<string, number> = {
  'hooks/alerts.ts': 1,
  'hooks/notification-subscriptions.ts': 2,
  'routes/announcements.ts': 1, // broadcast email (not the test send)
  'routes/notifications.ts': 2, // bulk message + message stakeholders
  'routes/submission-forms.ts': 1,
  'services/anomaly-detect.ts': 1,
  'services/chat-send.ts': 1,
  'services/delegate-coverage.ts': 1,
  'services/metric-alerts.ts': 1, // immediate alert only — the digest stays off
  'services/view-subscriptions.ts': 1,
  'services/watch-list/digest.ts': 1
}

const MUST_STAY_OFF = [
  'services/notification-channels.ts',
  'services/notification-escalation.ts',
  'services/flow-executor.ts',
  'routes/flows.ts',
  'services/scheduled-reports.ts',
  'services/report-studio-jobs.ts',
  'routes/report-studio.ts',
  'services/api-key-usage-statements.ts',
  'services/daily-digest.ts',
  'services/activity-views.ts',
  'routes/alerts.ts',
  'routes/mail.ts',
  'routes/settings.ts',
  'routes/mail-templates.ts',
  'services/mail-types.ts',
  'services/mail-retry.ts'
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'test' || name === 'node_modules' || name.endsWith('.test.ts')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

const OPT_IN = /autoRetry:\s*true\b/g

describe('automatic mail retry opt-in', () => {
  const found: Record<string, number> = {}
  for (const f of walk(SRC)) {
    const n = (readFileSync(f, 'utf8').match(OPT_IN) ?? []).length
    if (n) found[relative(SRC, f)] = n
  }

  it('exactly the reviewed senders opt in', () => {
    expect(found).toEqual(OPTED_IN)
  })

  it('senders with their own retry, and test sends, never opt in', () => {
    for (const f of MUST_STAY_OFF) expect(found[f] ?? 0, f).toBe(0)
  })

  it('announcements: the test send stays off', () => {
    const src = readFileSync(join(SRC, 'routes/announcements.ts'), 'utf8')
    const test = src.lastIndexOf('await sendRawMail(')
    expect(test).toBeGreaterThan(0)
    expect(src.slice(test, test + 600)).not.toMatch(OPT_IN)
  })
})
