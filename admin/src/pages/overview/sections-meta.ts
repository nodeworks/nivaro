/**
 * The Overview page's sections as DATA (no components — registry.ts adds those), so the layout
 * rules can be tested without React. Every key a person or a role starter layout may name is
 * listed here; a key whose component has not been mounted yet renders nothing.
 */

export type OverviewColumn = 'main' | 'side'

export interface OverviewSectionMeta {
  key: string
  title: string
  /** One line for the Customize list. */
  hint: string
  column: OverviewColumn
  adminOnly?: boolean
  defaultOrder: number
  defaultVisible: boolean
  /** Shown first on a phone, wherever it sits in the order (the "needs you" slot). */
  phoneFirst?: boolean
}

export const SECTION_META: OverviewSectionMeta[] = [
  // ── Main column ──
  {
    key: 'needs-you',
    title: 'Needs you',
    hint: 'Approvals, tasks and questions waiting on you',
    column: 'main',
    defaultOrder: 0,
    defaultVisible: true,
    phoneFirst: true
  },
  {
    key: 'health',
    title: 'Health',
    hint: 'One line on how the instance is doing',
    column: 'main',
    adminOnly: true,
    defaultOrder: 5,
    defaultVisible: true
  },
  {
    key: 'stats',
    title: 'Today',
    hint: 'Records changed, people active, failed jobs, open issues',
    column: 'main',
    defaultOrder: 10,
    defaultVisible: true
  },
  {
    key: 'quick-actions',
    title: 'Quick actions',
    hint: 'The screens you open most, plus the ones you pinned',
    column: 'main',
    defaultOrder: 20,
    defaultVisible: true
  },
  {
    key: 'timeline',
    title: 'Today’s timeline',
    hint: 'What is scheduled and what already happened today',
    column: 'main',
    defaultOrder: 25,
    defaultVisible: true
  },
  {
    key: 'problems',
    title: 'Problems',
    hint: 'Failures and errors worth a look',
    column: 'main',
    adminOnly: true,
    defaultOrder: 30,
    defaultVisible: true
  },
  {
    key: 'pinned-widgets',
    title: 'Pinned widgets',
    hint: 'Dashboard widgets you pinned to this page',
    column: 'main',
    defaultOrder: 35,
    defaultVisible: true
  },
  {
    key: 'recent',
    title: 'Recently viewed',
    hint: 'Records you opened lately, with their state',
    column: 'main',
    defaultOrder: 40,
    defaultVisible: true
  },
  {
    key: 'following',
    title: 'Following',
    hint: 'Changes on records you follow',
    column: 'main',
    defaultOrder: 45,
    defaultVisible: true
  },
  {
    key: 'activity',
    title: 'Recent activity',
    hint: 'What changed, by everyone, by you, or on your records',
    column: 'main',
    defaultOrder: 50,
    defaultVisible: true
  },
  // ── Side column ──
  {
    key: 'your-work',
    title: 'Your work',
    hint: 'What is waiting on you and which tasks are due',
    column: 'side',
    defaultOrder: 100,
    defaultVisible: true
  },
  {
    key: 'people-waiting',
    title: 'People waiting',
    hint: 'Access requests and new people waiting for a decision',
    column: 'side',
    adminOnly: true,
    defaultOrder: 110,
    defaultVisible: true
  },
  {
    key: 'config-changes',
    title: 'Configuration changes',
    hint: 'Recent changes to collections, pipelines and settings',
    column: 'side',
    adminOnly: true,
    defaultOrder: 120,
    defaultVisible: true
  },
  {
    key: 'usage',
    title: 'Usage pulse',
    hint: 'How much the instance is used today',
    column: 'side',
    adminOnly: true,
    defaultOrder: 130,
    defaultVisible: true
  },
  {
    key: 'instance',
    title: 'This instance',
    hint: 'Version, environment, database, extensions, who is online',
    column: 'side',
    adminOnly: true,
    defaultOrder: 140,
    defaultVisible: true
  }
]

/** The keys agent-built sections mount under (components land in ./sections/). */
export const EXTERNAL_SECTION_KEYS = [
  'needs-you',
  'health',
  'timeline',
  'problems',
  'config-changes',
  'people-waiting',
  'usage',
  'following'
] as const
