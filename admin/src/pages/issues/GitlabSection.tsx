import {
  isLink,
  TrackerChip,
  TrackerLinkPanel,
  type TrackerSyncLike,
  useCreateWait
} from '@nivaro/shared'
import { Gitlab, Sparkles } from 'lucide-react'
import { useCallback } from 'react'
import { connectionLabelsFor, type IssueTrackerFields, useIssueGitlab } from './gitlab'
import { Section } from './section'
import type { Issue } from './types'

type GitlabIssue = Issue & IssueTrackerFields

/**
 * The issue detail panel's GitLab section — administrators only, and only while GitLab sync is on
 * with at least one active connection that takes issue-log entries (useIssueGitlab). Everyone else
 * sees the chip in the header and the comment notice/badges. The panel itself is the shared one
 * support tickets and records use (@nivaro/shared TrackerLinkPanel).
 */
export function IssueGitlabSection({
  issue,
  onChanged
}: {
  issue: GitlabIssue
  onChanged: () => void
}) {
  const gate = useIssueGitlab()
  const fixedLabels = useCallback(
    (sync: TrackerSyncLike | undefined) =>
      connectionLabelsFor(issue, sync as Parameters<typeof connectionLabelsFor>[1]),
    [issue]
  )
  const link = isLink(issue.tracker) ? issue.tracker : null
  // A create was just asked for: show it as on its way until the issue comes back linked or
  // with its create queued, so Create can't be pressed twice before the refetch lands.
  const queued = (issue.tracker_pending ?? []).some((p) => p.op === 'create' && p.status !== 'dead')
  const wait = useCreateWait(!!issue.tracker || queued, onChanged)
  if (!gate.adminTools) return null
  const connections = gate.connections
  const conn = (link && connections.find((c) => c.id === link.connection)) || connections[0]
  return (
    <Section
      title={
        <>
          <Gitlab className='h-3.5 w-3.5 text-orange-600 dark:text-orange-400' aria-hidden />
          GitLab
        </>
      }
      action={
        connections.length > 1 && conn ? (
          <span className='text-[11px] text-muted-foreground'>{conn.name}</span>
        ) : undefined
      }
      data-issue-gitlab={link ? 'linked' : 'unlinked'}
    >
      {/* The detail panel is keyed by issue: a new issue starts idle. */}
      <TrackerLinkPanel
        source={{ kind: 'issue', id: String(issue.id) }}
        admin
        connections={connections}
        link={link}
        members={issue.tracker_members}
        membersTotal={issue.tracker_members_total}
        pending={issue.tracker_pending ?? []}
        suggestedRule={issue.tracker_suggested_rule ?? null}
        fixedLabels={fixedLabels}
        sourceTitle={issue.title}
        creating={wait.creating}
        slow={wait.stalled}
        onCheckAgain={wait.checkAgain}
        onCreated={wait.markCreating}
        onChanged={onChanged}
      />
    </Section>
  )
}

/**
 * The issue-log row's GitLab slot: the chip when linked, "Suggested" when a rule in suggest mode
 * picked it (the server sends `tracker_suggested_rule` to administrators only). A fixed width
 * while GitLab sync is on, so the time column lines up whether a row has a chip or not.
 */
export function IssueRowGitlab({ issue, on }: { issue: GitlabIssue; on: boolean }) {
  if (!on && !issue.tracker) return null
  return (
    <span className='flex w-[7.25rem] shrink-0 justify-end pt-0.5' data-issue-gitlab-slot>
      {issue.tracker ? (
        <TrackerChip tracker={issue.tracker} />
      ) : issue.tracker_suggested_rule != null ? (
        <SuggestedChip />
      ) : null}
    </span>
  )
}

/** "Suggested": a GitLab rule in suggest mode picked this issue and it is not linked yet. */
export function SuggestedChip() {
  return (
    <span
      data-gitlab-suggested-chip
      data-tip='A rule suggests sending this to GitLab. Open it to create the issue.'
      className='inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-nvr-cyan/30 bg-nvr-cyan/[0.06] px-1.5 text-[10.5px] font-medium text-nvr-navy dark:border-nvr-cyan/30 dark:bg-nvr-cyan/10 dark:text-nvr-cyan'
    >
      <Sparkles className='h-3 w-3 shrink-0' aria-hidden />
      Suggested
    </span>
  )
}
