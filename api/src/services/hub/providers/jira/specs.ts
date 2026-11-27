import type { FieldSpec, ResourceTypeSpec } from '../types.js'

export const PROJECT = 'jira.project'
export const COMPONENT = 'jira.component'
export const VERSION = 'jira.version'
export const WEBHOOK = 'jira.webhook'
export const RULE = 'jira.issue_link_rule'

const FULL = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: false }

export const DEFAULT_WEBHOOK_EVENTS = ['jira:issue_created', 'jira:issue_updated']

const projectRef: FieldSpec = {
  key: 'project',
  label: 'Project',
  kind: 'ref',
  refType: PROJECT,
  required: true,
  replaceOnChange: true
}

export const JIRA_TYPES: ResourceTypeSpec[] = [
  {
    key: PROJECT,
    label: 'Jira project',
    scope: 'shared',
    fields: [
      { key: 'key', label: 'Project key', kind: 'string', required: true, readOnly: true },
      { key: 'name', label: 'Name', kind: 'string', readOnly: true },
      { key: 'project_type', label: 'Project type', kind: 'string', readOnly: true }
    ],
    capabilities: {
      create: false,
      update: false,
      delete: false,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [],
    nameField: 'key',
    risk: () => []
  },
  {
    key: COMPONENT,
    label: 'Jira component',
    scope: 'app',
    fields: [
      projectRef,
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 255 },
      { key: 'description', label: 'Description', kind: 'string', max: 1000 }
    ],
    capabilities: FULL,
    reversible: (field) => field !== 'project',
    refs: [{ field: 'project', type: PROJECT, required: true }],
    nameField: 'name',
    risk: (op) => (op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : [])
  },
  {
    key: VERSION,
    label: 'Jira version',
    scope: 'app',
    fields: [
      projectRef,
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 255 },
      { key: 'description', label: 'Description', kind: 'string', max: 1000 },
      {
        key: 'release_date',
        label: 'Release date',
        kind: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        help: 'YYYY-MM-DD. Left empty, releasing the version sets today.'
      },
      { key: 'archived', label: 'Archived', kind: 'boolean', default: false },
      { key: 'released', label: 'Released', kind: 'boolean', readOnly: true },
      {
        key: 'release',
        label: 'Mark released',
        kind: 'boolean',
        trigger: true,
        help: 'Releases the version once (the Hub does it when a build is promoted to production).'
      }
    ],
    capabilities: FULL,
    reversible: (field) => field !== 'project' && field !== 'release',
    refs: [{ field: 'project', type: PROJECT, required: true }],
    nameField: 'name',
    risk: (op) => (op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : [])
  },
  {
    key: WEBHOOK,
    label: 'Jira webhook',
    scope: 'app',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 255 },
      {
        key: 'url',
        label: 'Address',
        kind: 'string',
        required: true,
        pattern: '^https://',
        help: 'An https address without a login or query string: put the shared secret in the Secret field.'
      },
      {
        key: 'events',
        label: 'Events',
        kind: 'list',
        items: { key: 'event', label: 'Event', kind: 'string' },
        default: DEFAULT_WEBHOOK_EVENTS
      },
      {
        key: 'jql',
        label: 'Only issues matching (JQL)',
        kind: 'string',
        help: 'Required when the connection is limited to some projects, for example project = ABC.'
      },
      {
        key: 'secret',
        label: 'Secret',
        kind: 'secret',
        help: 'Sent to Jira Data Center and kept sealed here.'
      },
      { key: 'enabled', label: 'Enabled', kind: 'boolean', default: true }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [],
    nameField: 'name',
    risk: () => []
  },
  {
    key: RULE,
    label: 'Jira issue rule',
    scope: 'app',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 120 },
      { ...projectRef, replaceOnChange: false },
      {
        key: 'component',
        label: 'Component',
        kind: 'ref',
        refType: COMPONENT,
        help: 'The app’s component: issues the Hub opens carry it.'
      },
      {
        key: 'issue_type',
        label: 'Issue type',
        kind: 'string',
        required: true,
        default: 'Task',
        max: 60,
        help: 'The name of an issue type the project has (Task, Bug…).'
      },
      {
        key: 'labels',
        label: 'Extra labels',
        kind: 'list',
        items: { key: 'label', label: 'Label', kind: 'string' },
        help: 'Added to nivaro-hub and app:<key>. No spaces.'
      },
      { key: 'priority_info', label: 'Priority for info', kind: 'string', max: 60 },
      { key: 'priority_warning', label: 'Priority for warnings', kind: 'string', max: 60 },
      { key: 'priority_critical', label: 'Priority for critical', kind: 'string', max: 60 }
    ],
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: false,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [
      { field: 'project', type: PROJECT, required: true },
      { field: 'component', type: COMPONENT, required: false }
    ],
    nameField: 'name',
    sends: true,
    risk: () => []
  }
]

export const specOf = (type: string) => JIRA_TYPES.find((t) => t.key === type)
