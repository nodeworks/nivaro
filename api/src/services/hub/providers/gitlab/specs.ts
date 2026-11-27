import {
  type DesiredResource,
  type FieldSpec,
  type PlannedOp,
  type ResourceCapabilities,
  type ResourceTypeSpec,
  type RiskFlag,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import { gitlabEstimate } from './pricing.js'

/**
 * GitLab resource types (Task 18). External ids:
 *  group = group id · project = project id · protected_branch = `<project>/<branch>` ·
 *  environment = `<project>/<environment id>` · protected_environment = `<project>/<name>` ·
 *  ci_variable = `project:<id>:<key>:<scope>` | `group:<id>:<key>:<scope>` ·
 *  deploy_token = `project:<id>:<token id>` | `group:<id>:<token id>` · deploy_key =
 *  `<project>/<key id>` · webhook = `<project>/<hook id>` · pipeline_schedule =
 *  `<project>/<schedule id>` · runner = runner id.
 */

export const T = {
  group: 'gitlab.group',
  project: 'gitlab.project',
  protectedBranch: 'gitlab.protected_branch',
  environment: 'gitlab.environment',
  protectedEnvironment: 'gitlab.protected_environment',
  ciVariable: 'gitlab.ci_variable',
  deployToken: 'gitlab.deploy_token',
  deployKey: 'gitlab.deploy_key',
  webhook: 'gitlab.webhook',
  pipelineSchedule: 'gitlab.pipeline_schedule',
  runner: 'gitlab.runner'
} as const

const caps = (over: Partial<ResourceCapabilities> = {}): ResourceCapabilities => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false,
  ...over
})

const projectRef: FieldSpec = {
  key: 'project',
  label: 'Project',
  kind: 'ref',
  refType: T.project,
  required: true,
  replaceOnChange: true
}

const optionalProjectRef: FieldSpec = {
  key: 'project',
  label: 'Project',
  kind: 'ref',
  refType: T.project,
  replaceOnChange: true,
  help: 'Set a project or a group, not both.'
}

const optionalGroupRef: FieldSpec = {
  key: 'group',
  label: 'Group',
  kind: 'ref',
  refType: T.group,
  replaceOnChange: true,
  help: 'Set a project or a group, not both.'
}

const ROLE_OPTIONS = [
  { value: 'maintainers', label: 'Maintainers' },
  { value: 'developers', label: 'Developers and Maintainers' },
  { value: 'no_one', label: 'No one' }
]

const rotateField: FieldSpec = {
  key: ROTATE_OUTPUTS_FIELD,
  label: 'Make a new token now',
  kind: 'boolean',
  trigger: true,
  help: 'GitLab shows the token once. This makes a new one, replaces the old one and hands the new one to what is bound to it.'
}

export const DEPLOY_TOKEN_SCOPES = [
  'read_repository',
  'read_registry',
  'write_registry',
  'read_package_registry',
  'write_package_registry'
]

export const WEBHOOK_EVENTS = [
  'push_events',
  'tag_push_events',
  'merge_requests_events',
  'issues_events',
  'confidential_issues_events',
  'note_events',
  'confidential_note_events',
  'pipeline_events',
  'job_events',
  'deployment_events',
  'releases_events'
]

const touches = (op: PlannedOp, field: string) =>
  op.kind === 'create' || op.changes.some((c) => c.field === field)

function projectRisk(op: PlannedOp, desired: DesiredResource | null): RiskFlag[] {
  if (op.action === 'destroy') return ['destructive', 'data_loss']
  if (op.kind === 'delete') return [] // archive: reversible, nothing lost
  if (touches(op, 'visibility') && desired?.fields.visibility === 'public')
    return ['public_exposure']
  return []
}

const deleteRisk = (op: PlannedOp): RiskFlag[] =>
  op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : []

function tokenRisk(op: PlannedOp): RiskFlag[] {
  const out: RiskFlag[] = []
  if (op.kind === 'delete') out.push('destructive')
  // The old token stops working at once; what uses it breaks until the new one is applied.
  if (op.kind === 'replace' || op.action === 'rotate') out.push('downtime')
  return out
}

export const TYPES: ResourceTypeSpec[] = [
  {
    key: T.group,
    label: 'GitLab group',
    scope: 'shared',
    nameField: 'fullPath',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', readOnly: true },
      { key: 'path', label: 'Path', kind: 'string', readOnly: true },
      { key: 'fullPath', label: 'Full path', kind: 'string', readOnly: true },
      { key: 'visibility', label: 'Visibility', kind: 'string', readOnly: true },
      { key: 'description', label: 'Description', kind: 'string', readOnly: true }
    ],
    // Groups are shared: the Hub reads and adopts them, it never creates or removes one.
    capabilities: caps({ create: false, update: false, delete: false }),
    reversible: false,
    refs: [],
    risk: () => [],
    costClass: () => 'none',
    estimate: gitlabEstimate('group')
  },
  {
    key: T.project,
    label: 'GitLab project',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'namespace',
        label: 'Group',
        kind: 'ref',
        refType: T.group,
        createOnly: true,
        help: 'The group (or subgroup) to create it in. Empty: the connection’s pinned group.'
      },
      { key: 'name', label: 'Name', kind: 'string', required: true },
      {
        key: 'path',
        label: 'URL path',
        kind: 'string',
        createOnly: true,
        pattern: '^[A-Za-z0-9_.-]+$',
        help: 'Empty: made from the name.'
      },
      { key: 'description', label: 'Description', kind: 'string' },
      {
        key: 'visibility',
        label: 'Visibility',
        kind: 'enum',
        default: 'private',
        options: [
          { value: 'private', label: 'Private' },
          { value: 'internal', label: 'Internal' },
          { value: 'public', label: 'Public' }
        ]
      },
      { key: 'defaultBranch', label: 'Default branch', kind: 'string' },
      {
        key: 'templateName',
        label: 'Built-in template',
        kind: 'string',
        createOnly: true,
        help: 'A GitLab project template name, e.g. rails. Create only.'
      },
      {
        key: 'templateProject',
        label: 'Template project id',
        kind: 'string',
        createOnly: true,
        pattern: '^\\d{1,18}$',
        help: 'The id of a project in this group to copy. Create only.'
      },
      { key: 'fullPath', label: 'Full path', kind: 'string', readOnly: true },
      {
        key: 'archived',
        label: 'Archived',
        kind: 'boolean',
        help: 'An archived project is read-only. Removing the resource archives it.'
      },
      {
        key: 'destroy',
        label: 'Delete permanently when removed',
        kind: 'boolean',
        help: 'Off (default): removing archives the project. On: the next apply deletes it for good, with its issues and history.'
      }
    ],
    capabilities: caps(),
    reversible: (field) => field !== 'destroy' && field !== 'templateName',
    refs: [{ field: 'namespace', type: T.group, required: false }],
    risk: projectRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('project')
  },
  {
    key: T.protectedBranch,
    label: 'Protected branch',
    scope: 'app',
    nameField: 'name',
    fields: [
      projectRef,
      {
        key: 'name',
        label: 'Branch',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        help: 'A branch name or a wildcard such as release/*.'
      },
      {
        key: 'pushAccess',
        label: 'Who may push',
        kind: 'enum',
        default: 'maintainers',
        options: ROLE_OPTIONS
      },
      {
        key: 'mergeAccess',
        label: 'Who may merge',
        kind: 'enum',
        default: 'maintainers',
        options: ROLE_OPTIONS
      },
      { key: 'allowForcePush', label: 'Allow force push', kind: 'boolean', default: false },
      {
        key: 'codeOwnerApprovalRequired',
        label: 'Code owner approval required',
        kind: 'boolean',
        default: false
      }
    ],
    capabilities: caps(),
    reversible: true,
    refs: [{ field: 'project', type: T.project, required: true }],
    risk: deleteRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('config')
  },
  {
    key: T.environment,
    label: 'GitLab environment',
    scope: 'app',
    nameField: 'name',
    fields: [
      projectRef,
      { key: 'name', label: 'Name', kind: 'string', required: true, replaceOnChange: true },
      { key: 'externalUrl', label: 'Address', kind: 'string', help: 'Where the environment runs.' },
      {
        key: 'tier',
        label: 'Tier',
        kind: 'enum',
        options: [
          { value: 'production', label: 'Production' },
          { value: 'staging', label: 'Staging' },
          { value: 'testing', label: 'Testing' },
          { value: 'development', label: 'Development' },
          { value: 'other', label: 'Other' }
        ]
      },
      { key: 'state', label: 'State', kind: 'string', readOnly: true }
    ],
    capabilities: caps(),
    reversible: true,
    refs: [{ field: 'project', type: T.project, required: true }],
    risk: deleteRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('config')
  },
  {
    key: T.protectedEnvironment,
    label: 'Protected environment',
    scope: 'app',
    nameField: 'environment',
    fields: [
      projectRef,
      {
        key: 'environment',
        label: 'Environment',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        help: 'The environment name (or tier for premium wildcards).'
      },
      {
        key: 'deployAccess',
        label: 'Who may deploy',
        kind: 'enum',
        default: 'maintainers',
        options: ROLE_OPTIONS
      },
      {
        key: 'approverRole',
        label: 'Who approves a deployment',
        kind: 'enum',
        default: 'maintainers',
        options: ROLE_OPTIONS.filter((o) => o.value !== 'no_one'),
        help: 'Used only when approvals are required (a Premium feature).'
      },
      {
        key: 'requiredApprovals',
        label: 'Approvals required',
        kind: 'number',
        min: 0,
        max: 10,
        default: 0
      }
    ],
    capabilities: caps(),
    reversible: true,
    refs: [{ field: 'project', type: T.project, required: true }],
    risk: deleteRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('config')
  },
  {
    key: T.ciVariable,
    label: 'CI/CD variable',
    scope: 'app',
    nameField: 'key',
    fields: [
      optionalProjectRef,
      optionalGroupRef,
      {
        key: 'key',
        label: 'Name',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z0-9_]{1,255}$'
      },
      {
        key: 'value',
        label: 'Value',
        kind: 'secret',
        required: true,
        help: 'Write-only: the Hub never shows it and compares by fingerprint.'
      },
      {
        key: 'variableType',
        label: 'Kind',
        kind: 'enum',
        default: 'env_var',
        options: [
          { value: 'env_var', label: 'Variable' },
          { value: 'file', label: 'File' }
        ]
      },
      { key: 'masked', label: 'Masked in job logs', kind: 'boolean', default: true },
      {
        key: 'protected',
        label: 'Protected branches and tags only',
        kind: 'boolean',
        default: false
      },
      { key: 'raw', label: 'Do not expand $references', kind: 'boolean', default: false },
      {
        key: 'environmentScope',
        label: 'Environment scope',
        kind: 'string',
        default: '*',
        replaceOnChange: true,
        help: '* = every environment.'
      }
    ],
    capabilities: caps(),
    // The value cannot be read, so a value change has no before-state to restore.
    reversible: (field) => field !== 'value',
    refs: [
      { field: 'project', type: T.project, required: false },
      { field: 'group', type: T.group, required: false }
    ],
    risk: deleteRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('config')
  },
  {
    key: T.deployToken,
    label: 'Deploy token',
    scope: 'app',
    nameField: 'name',
    fields: [
      optionalProjectRef,
      optionalGroupRef,
      { key: 'name', label: 'Name', kind: 'string', required: true, replaceOnChange: true },
      {
        key: 'scopes',
        label: 'Scopes',
        kind: 'list',
        required: true,
        replaceOnChange: true,
        items: {
          key: 'scope',
          label: 'Scope',
          kind: 'enum',
          options: DEPLOY_TOKEN_SCOPES.map((v) => ({ value: v, label: v }))
        }
      },
      {
        key: 'expiresAt',
        label: 'Expires',
        kind: 'string',
        replaceOnChange: true,
        help: 'An ISO date or time. Empty: never.'
      },
      {
        key: 'username',
        label: 'User name',
        kind: 'string',
        replaceOnChange: true,
        help: 'Empty: GitLab picks gitlab+deploy-token-N.'
      },
      rotateField
    ],
    capabilities: caps({ update: true }),
    reversible: false,
    refs: [
      { field: 'project', type: T.project, required: false },
      { field: 'group', type: T.group, required: false }
    ],
    outputs: [
      { key: 'token', label: 'Deploy token', secret: true, onceOnly: true },
      { key: 'username', label: 'Deploy token user name', secret: false }
    ],
    risk: tokenRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('token')
  },
  {
    key: T.deployKey,
    label: 'Deploy key',
    scope: 'app',
    nameField: 'title',
    fields: [
      projectRef,
      { key: 'title', label: 'Title', kind: 'string', required: true },
      {
        key: 'key',
        label: 'Public key',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        help: 'The public half only (ssh-ed25519 AAAA…).'
      },
      { key: 'canPush', label: 'May push', kind: 'boolean', default: false }
    ],
    capabilities: caps(),
    reversible: true,
    refs: [{ field: 'project', type: T.project, required: true }],
    risk: deleteRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('config')
  },
  {
    key: T.webhook,
    label: 'Project webhook',
    scope: 'app',
    nameField: 'url',
    fields: [
      projectRef,
      {
        key: 'url',
        label: 'Address',
        kind: 'string',
        required: true,
        pattern: '^https://\\S+$'
      },
      {
        key: 'token',
        label: 'Secret token',
        kind: 'secret',
        help: 'Write-only: GitLab never gives it back, so it is compared by fingerprint.'
      },
      {
        key: 'events',
        label: 'Events',
        kind: 'list',
        items: {
          key: 'event',
          label: 'Event',
          kind: 'enum',
          options: WEBHOOK_EVENTS.map((v) => ({ value: v, label: v }))
        }
      },
      {
        key: 'enableSslVerification',
        label: 'Verify the certificate',
        kind: 'boolean',
        default: true
      },
      { key: 'alertStatus', label: 'Delivery status', kind: 'string', readOnly: true }
    ],
    capabilities: caps(),
    reversible: (field) => field !== 'token',
    refs: [{ field: 'project', type: T.project, required: true }],
    risk: deleteRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('config')
  },
  {
    key: T.pipelineSchedule,
    label: 'Pipeline schedule',
    scope: 'app',
    nameField: 'description',
    fields: [
      projectRef,
      { key: 'description', label: 'Description', kind: 'string', required: true },
      { key: 'ref', label: 'Branch or tag', kind: 'string', required: true },
      {
        key: 'cron',
        label: 'Schedule (cron)',
        kind: 'string',
        required: true,
        help: 'Five fields, e.g. 0 3 * * *.'
      },
      { key: 'cronTimezone', label: 'Time zone', kind: 'string', default: 'UTC' },
      { key: 'active', label: 'Active', kind: 'boolean', default: true }
    ],
    capabilities: caps(),
    reversible: true,
    refs: [{ field: 'project', type: T.project, required: true }],
    risk: () => [],
    costClass: () => 'none',
    estimate: gitlabEstimate('config')
  },
  {
    key: T.runner,
    label: 'GitLab runner',
    scope: 'app',
    nameField: 'description',
    fields: [
      {
        key: 'project',
        label: 'Project',
        kind: 'ref',
        refType: T.project,
        createOnly: true,
        help: 'A project runner. Set a project or a group, not both. Create only.'
      },
      {
        key: 'group',
        label: 'Group',
        kind: 'ref',
        refType: T.group,
        createOnly: true,
        help: 'A group runner. Create only.'
      },
      { key: 'description', label: 'Description', kind: 'string', required: true },
      {
        key: 'tagList',
        label: 'Tags',
        kind: 'list',
        items: { key: 'tag', label: 'Tag', kind: 'string' }
      },
      { key: 'runUntagged', label: 'Run untagged jobs', kind: 'boolean', default: true },
      { key: 'locked', label: 'Locked to its project', kind: 'boolean', default: false },
      {
        key: 'accessLevel',
        label: 'Runs',
        kind: 'enum',
        default: 'not_protected',
        options: [
          { value: 'not_protected', label: 'Any branch' },
          { value: 'ref_protected', label: 'Protected branches only' }
        ]
      },
      { key: 'paused', label: 'Paused', kind: 'boolean', default: false },
      { key: 'maximumTimeout', label: 'Longest job (seconds)', kind: 'number', min: 600 },
      { key: 'runnerType', label: 'Type', kind: 'string', readOnly: true },
      { key: 'online', label: 'Online', kind: 'boolean', readOnly: true },
      rotateField
    ],
    capabilities: caps(),
    reversible: false,
    refs: [
      { field: 'project', type: T.project, required: false },
      { field: 'group', type: T.group, required: false }
    ],
    outputs: [{ key: 'token', label: 'Runner authentication token', secret: true, onceOnly: true }],
    risk: tokenRisk,
    costClass: () => 'none',
    estimate: gitlabEstimate('runner')
  }
]

export const specOf = (type: string): ResourceTypeSpec | undefined =>
  TYPES.find((t) => t.key === type)
