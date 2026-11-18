import { isLink, TrackerLinkPanel, type TrackerSyncLike } from '@nivaro/shared'
import { Gitlab } from 'lucide-react'
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
  if (!gate.adminTools) return null
  const connections = gate.connections
  const link = isLink(issue.tracker) ? issue.tracker : null
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
        onChanged={onChanged}
      />
    </Section>
  )
}
