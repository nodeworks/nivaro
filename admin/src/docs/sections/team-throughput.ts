import type { DocSection } from '../types.js'

export const teamThroughputGuide: DocSection = {
  id: 'team-throughput',
  label: 'Team Throughput',
  content: [
    { type: 'h1', id: 'team-throughput', text: 'Team Throughput' },
    {
      type: 'p',
      text: 'Team Throughput is an admin-only report showing how each user is moving work through a workflow-bound collection over time — transitions performed, completions, send-backs, and average time to act.'
    },
    { type: 'h2', id: 'team-throughput-metrics', text: 'Metrics' },
    {
      type: 'ul',
      items: [
        'Transitions — state changes performed by the user.',
        'Completions — transitions into a terminal state other than canceled.',
        'Send-backs — transitions to a state earlier in the state order.',
        'Avg time to action — how long items sat in a state before this user moved them (wall-clock).'
      ]
    },
    {
      type: 'note',
      text: 'Computed live from `nivaro_workflow_history` — fully retroactive, including imported legacy history. Per-owner backlog trends (My Items sparklines) accumulate daily from the snapshot cron and are not retroactive.'
    }
  ]
}
