import { describe, expect, it } from 'vitest'
import type { RuleDraft } from './api'
import {
  appliesToChoices,
  explainName,
  formatDuration,
  isValidMatchKey,
  moveRule,
  newRule,
  outcomeLabel,
  parseIssueRef,
  ruleBody,
  ruleSentence,
  sentenceParts,
  withActionPatch,
  withAppliesTo,
  withConnection
} from './rule-sentence'

const crashRule = (over: Partial<RuleDraft> = {}): RuleDraft => {
  const r = newRule(3, 'issue')
  return {
    ...r,
    name: 'Crashes',
    mode: 'create',
    match: { sources: ['crash'], severity_min: 'high' },
    threshold: {
      hits: { n: 20, window_minutes: 60 },
      people: { n: 3, window_minutes: 60 }
    },
    action: { ...r.action, labels: ['bug', 'sev::high'] },
    ...over
  }
}

describe('ruleSentence', () => {
  it('reads an issue-log rule as one sentence', () => {
    expect(ruleSentence(crashRule(), { projectPath: 'group/proj' })).toBe(
      'When a crash with severity ≥ high is seen 20 times by 3 people within 1 hour, open an issue in group/proj labelled bug, sev::high'
    )
  })

  it('says "a support ticket" for a ticket rule', () => {
    const t = newRule(3, 'ticket')
    expect(
      ruleSentence(
        {
          ...t,
          mode: 'create',
          match: { priorities: ['urgent'] },
          threshold: { open_minutes: 120 },
          action: { ...t.action, labels: ['support'] }
        },
        { projectPath: 'group/proj' }
      )
    ).toBe(
      'When a support ticket with priority urgent stays open 2 hours, open an issue in group/proj labelled support'
    )
    expect(ruleSentence(t, { projectPath: 'g/p' })).toBe(
      'When a support ticket is raised, suggest an issue in g/p'
    )
  })

  it('covers the other wordings', () => {
    expect(
      ruleSentence(
        crashRule({
          mode: 'suggest',
          match: {},
          threshold: { hits: { n: 5, window_minutes: 30 } },
          action: { ...crashRule().action, labels: [], issue_type: 'incident' }
        }),
        {}
      )
    ).toBe(
      'When an issue is seen 5 times within 30 minutes, suggest an incident in the default project'
    )
    expect(
      ruleSentence(
        crashRule({
          match: {
            sources: ['client', 'server'],
            text: { op: 'any', terms: ['x'], in: ['title'] }
          },
          threshold: { people: { n: 2, window_minutes: 1440 }, recurrences: 3 }
        }),
        { projectPath: 'g/p' }
      )
    ).toBe(
      'When a client or server issue matching 1 more condition is seen by 2 people within 1 day and comes back 3 times, open an issue in g/p labelled bug, sev::high'
    )
  })

  it('marks the editable parts', () => {
    const parts = sentenceParts(crashRule(), { projectPath: 'group/proj' })
    expect(parts.filter((p) => p.part).map((p) => p.part)).toEqual([
      'subject',
      'severity',
      'threshold',
      'action',
      'project',
      'labels'
    ])
  })
})

describe('rule drafts', () => {
  it('new rules start off and in suggest mode', () => {
    const r = newRule(9, 'issue')
    expect(r.enabled).toBe(false)
    expect(r.mode).toBe('suggest')
    expect(r.action.connection).toBe(9)
    expect(r.guards).toMatchObject({ per_hour: 5, per_day: 20 })
  })

  it('offers only kinds whose source is switched on', () => {
    expect(appliesToChoices({ issue: true, ticket: false, record: true })).toEqual(['issue'])
    expect(appliesToChoices({ issue: true, ticket: true, record: false })).toEqual([
      'issue',
      'ticket'
    ])
  })

  it('switching to tickets drops the issue-only conditions and counts', () => {
    const t = withAppliesTo(
      crashRule({
        match: { severity_min: 'high', statuses: ['open'], routes: ['/x'] },
        threshold: { hits: { n: 2, window_minutes: 60 }, open_minutes: 30 }
      }),
      'ticket'
    )
    expect(t.applies_to).toBe('ticket')
    expect(t.match).toEqual({ statuses: ['open'] })
    expect(t.threshold).toEqual({ open_minutes: 30 })
    expect(t.action.title_template).toBe('')
    expect(isValidMatchKey('ticket', 'priorities')).toBe(true)
    expect(isValidMatchKey('ticket', 'severity_min')).toBe(false)
    expect(isValidMatchKey('issue', 'categories')).toBe(false)
  })

  it('switching kind keeps only the statuses the new kind has', () => {
    const issueRule = crashRule({ match: { statuses: ['resolved'] } })
    expect(withAppliesTo(issueRule, 'ticket').match).not.toHaveProperty('statuses')
    expect(
      withAppliesTo(
        crashRule({ match: { statuses: ['resolved', 'open', 'in_progress'] } }),
        'ticket'
      ).match.statuses
    ).toEqual(['open', 'in_progress'])
    const ticketRule = { ...newRule(3, 'ticket'), match: { statuses: ['done', 'open'] } }
    expect(withAppliesTo(ticketRule, 'issue').match.statuses).toEqual(['open'])
  })

  it('the body leaves out what the list shows', () => {
    const body = ruleBody({
      ...crashRule(),
      // view-only fields a stored rule carries
      ...({ id: 4, fired_count: 3, valid: true, sort: 10 } as object)
    } as RuleDraft)
    expect(body).not.toHaveProperty('id')
    expect(body).not.toHaveProperty('fired_count')
    expect(body).not.toHaveProperty('sort')
    expect(body).toMatchObject({ name: 'Crashes', applies_to: 'issue', mode: 'create' })
  })
})

describe('small helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(60)).toBe('1 hour')
    expect(formatDuration(90)).toBe('90 minutes')
    expect(formatDuration(1)).toBe('1 minute')
    expect(formatDuration(2880)).toBe('2 days')
    expect(formatDuration(180)).toBe('3 hours')
  })

  it('reads an issue reference', () => {
    expect(parseIssueRef('#123')).toBe(123)
    expect(parseIssueRef(' 45 ')).toBe(45)
    expect(parseIssueRef('abc')).toBeNull()
    expect(parseIssueRef('0')).toBeNull()
  })

  it('names explain rows, flow-made decisions included', () => {
    expect(explainName({ rule: -1, name: 'Flow' })).toBe('Flow')
    expect(explainName({ rule: -1, name: '' })).toBe('Flow')
    expect(explainName({ rule: 0, name: '' })).toBe('GitLab sync')
    expect(explainName({ rule: 7, name: 'Crashes' })).toBe('Crashes')
    expect(outcomeLabel('no_match')).toBe('Did not match')
    expect(outcomeLabel('would_fire')).toBe('Would act')
    expect(outcomeLabel('something_new')).toBe('something new')
  })
})

describe('moveRule', () => {
  it('moves a dragged rule onto the slot it was dropped on', () => {
    expect(moveRule([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3])
    expect(moveRule([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4])
    expect(moveRule([1, 2, 3], 2, 2)).toBeNull()
    expect(moveRule([1, 2, 3], 9, 2)).toBeNull()
  })
})

describe('moving a rule to another GitLab / project', () => {
  const rich = (): RuleDraft => {
    const r = crashRule()
    return {
      ...r,
      action: {
        ...r.action,
        project_id: 44,
        milestone_id: 7,
        assignee_ids: [11, 12],
        labels: ['bug']
      }
    }
  }
  it('another connection drops the project, milestone, assignees and labels of the old GitLab', () => {
    const next = withConnection(rich(), 9)
    expect(next.action.connection).toBe(9)
    expect(next.action.project_id).toBeUndefined()
    expect(next.action.milestone_id).toBeUndefined()
    expect(next.action.assignee_ids).toEqual([])
    expect(next.action.labels).toEqual([])
    expect('milestone_id' in next.action).toBe(false)
  })
  it('the same connection changes nothing', () => {
    const r = rich()
    expect(withConnection(r, r.action.connection)).toBe(r)
  })
  it("another project drops the old project's milestone; the same project keeps it", () => {
    const moved = withActionPatch(rich().action, { project_id: 45 })
    expect(moved.project_id).toBe(45)
    expect('milestone_id' in moved).toBe(false)
    expect(withActionPatch(rich().action, { project_id: 44 }).milestone_id).toBe(7)
    // back to the default project
    const back = withActionPatch(rich().action, { project_id: undefined })
    expect('project_id' in back).toBe(false)
    expect('milestone_id' in back).toBe(false)
  })
})
