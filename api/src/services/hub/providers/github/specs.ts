import type {
  ConnectionSpec,
  DesiredResource,
  FieldSpec,
  PlannedOp,
  ResourceCapabilities,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'

/**
 * The GitHub adapter's connection form and resource type specs. External ids:
 *   github.repository          owner/repo
 *   github.branch_protection   owner/repo#branch
 *   github.environment         owner/repo#environment
 *   github.actions_secret      owner/repo#NAME   or   owner/repo@environment#NAME
 *   github.actions_variable    owner/repo#NAME   or   owner/repo@environment#NAME
 *   github.workflow            owner/repo#workflow-file.yml
 *   github.deploy_key          owner/repo#<key id>
 *   github.webhook             owner/repo#<hook id>
 */

export const GITHUB_HOST = 'api.github.com'

export const connection: ConnectionSpec = {
  fields: [
    {
      key: 'auth_method',
      label: 'Sign in with',
      kind: 'enum',
      required: true,
      default: 'app',
      options: [
        { value: 'app', label: 'GitHub App (recommended)' },
        { value: 'pat', label: 'Personal access token' }
      ]
    },
    {
      key: 'owner',
      label: 'Organisation or user',
      kind: 'string',
      required: true,
      help: 'The account whose repositories this connection manages.',
      placeholder: 'acme'
    },
    { key: 'app_id', label: 'GitHub App id', kind: 'string', help: 'GitHub App only.' },
    {
      key: 'installation_id',
      label: 'Installation id',
      kind: 'string',
      help: 'GitHub App only: the installation on the account above.'
    },
    {
      key: 'private_key',
      label: 'App private key (PEM)',
      kind: 'text',
      secret: true,
      help: 'GitHub App only. Upload a new key here when you rotate it.'
    },
    {
      key: 'token',
      label: 'Personal access token',
      kind: 'string',
      secret: true,
      help: 'Personal access token only: repo + workflow scopes (or a fine-grained token).'
    }
  ],
  hosts: () => [GITHUB_HOST],
  describe: (c) =>
    `GitHub ${String(c.owner ?? '?')} · ${c.auth_method === 'pat' ? 'access token' : 'GitHub App'}`,
  validate(config, secrets) {
    const problems: string[] = []
    if (!String(config.owner ?? '').trim()) problems.push('The organisation or user is required.')
    if (config.auth_method === 'pat') {
      if (!(secrets.token ?? '').trim()) problems.push('The personal access token is required.')
    } else {
      if (!String(config.app_id ?? '').trim()) problems.push('The GitHub App id is required.')
      if (!String(config.installation_id ?? '').trim())
        problems.push('The installation id is required.')
      if (!(secrets.private_key ?? '').includes('PRIVATE KEY'))
        problems.push('The app private key (PEM) is required.')
    }
    return problems
  }
}

const repositoryRef: FieldSpec = {
  key: 'repository',
  label: 'Repository',
  kind: 'ref',
  refType: 'github.repository',
  required: true
}
const repoRefs = [{ field: 'repository', type: 'github.repository' }]
const NO_CREATE_CAPS: ResourceCapabilities = {
  create: false,
  update: true,
  delete: false,
  adopt: true,
  snapshot: false,
  tag: false
}
const caps = (over: Partial<ResourceCapabilities> = {}): ResourceCapabilities => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false,
  ...over
})

const str = (d: DesiredResource | null, key: string): unknown => d?.fields?.[key]

/** Risk flags of the repository: public exposure and permanent deletion. */
function repositoryRisk(op: PlannedOp, desired: DesiredResource | null): RiskFlag[] {
  const flags: RiskFlag[] = []
  if (op.action === 'destroy') return ['destructive', 'data_loss']
  if (op.kind === 'delete') return flags // archive: reversible, nothing lost
  const touchesVisibility = op.kind === 'create' || op.changes.some((c) => c.field === 'visibility')
  if (touchesVisibility && str(desired, 'visibility') === 'public') flags.push('public_exposure')
  return flags
}

const secretNamePattern = '^[A-Za-z_][A-Za-z0-9_]*$'

export const TYPES: ResourceTypeSpec[] = [
  {
    key: 'github.repository',
    label: 'GitHub repository',
    scope: 'app',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, pattern: '^[A-Za-z0-9._-]+$' },
      { key: 'description', label: 'Description', kind: 'string' },
      {
        key: 'visibility',
        label: 'Visibility',
        kind: 'enum',
        default: 'private',
        options: [
          { value: 'private', label: 'Private' },
          { value: 'internal', label: 'Internal (organisation)' },
          { value: 'public', label: 'Public' }
        ]
      },
      {
        key: 'template',
        label: 'Create from template',
        kind: 'string',
        createOnly: true,
        help: 'owner/repo of a template repository. Only used when the repository is created.',
        pattern: '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
      },
      { key: 'default_branch', label: 'Default branch', kind: 'string' },
      { key: 'has_issues', label: 'Issues enabled', kind: 'boolean' },
      { key: 'has_wiki', label: 'Wiki enabled', kind: 'boolean' },
      {
        key: 'topics',
        label: 'Topics',
        kind: 'list',
        items: { key: 'topic', label: 'Topic', kind: 'string' }
      },
      {
        key: 'archived',
        label: 'Archived',
        kind: 'boolean',
        help: 'An archived repository is read-only. Removing the resource archives it.'
      },
      {
        key: 'destroy',
        label: 'Delete permanently when removed',
        kind: 'boolean',
        help: 'Off (default): removing archives the repository. On: the next apply deletes it for good.'
      }
    ],
    capabilities: caps(),
    reversible: (field) => field !== 'destroy' && field !== 'template',
    refs: [],
    risk: repositoryRisk
  },
  {
    key: 'github.branch_protection',
    label: 'Branch protection',
    scope: 'app',
    nameField: 'branch',
    fields: [
      repositoryRef,
      { key: 'branch', label: 'Branch', kind: 'string', required: true, createOnly: true },
      {
        key: 'required_reviews',
        label: 'Required approving reviews',
        kind: 'number',
        min: 0,
        max: 6,
        default: 1
      },
      { key: 'dismiss_stale_reviews', label: 'Dismiss stale reviews', kind: 'boolean' },
      { key: 'require_code_owner_reviews', label: 'Require code owner review', kind: 'boolean' },
      {
        key: 'required_status_checks',
        label: 'Required status checks',
        kind: 'list',
        items: { key: 'check', label: 'Check', kind: 'string' }
      },
      { key: 'strict_status_checks', label: 'Branch must be up to date', kind: 'boolean' },
      { key: 'enforce_admins', label: 'Applies to administrators', kind: 'boolean' },
      { key: 'allow_force_pushes', label: 'Allow force pushes', kind: 'boolean' },
      { key: 'allow_deletions', label: 'Allow deleting the branch', kind: 'boolean' },
      { key: 'required_linear_history', label: 'Linear history', kind: 'boolean' },
      {
        key: 'required_conversation_resolution',
        label: 'Resolve conversations before merging',
        kind: 'boolean'
      }
    ],
    capabilities: caps(),
    reversible: true,
    refs: repoRefs,
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
  },
  {
    key: 'github.environment',
    label: 'Deployment environment',
    scope: 'app',
    nameField: 'name',
    fields: [
      repositoryRef,
      { key: 'name', label: 'Name', kind: 'string', required: true, createOnly: true },
      {
        key: 'wait_timer',
        label: 'Wait timer (minutes)',
        kind: 'number',
        min: 0,
        max: 43200,
        default: 0
      },
      { key: 'prevent_self_review', label: 'Prevent self-review', kind: 'boolean' },
      {
        key: 'deployment_branches',
        label: 'Deployment branches',
        kind: 'enum',
        default: 'all',
        options: [
          { value: 'all', label: 'Any branch' },
          { value: 'protected', label: 'Protected branches only' },
          { value: 'selected', label: 'Selected branches and tags' }
        ]
      }
    ],
    capabilities: caps(),
    reversible: true,
    refs: repoRefs,
    // Deleting an environment deletes the secrets and variables stored in it.
    risk: (op) => (op.kind === 'delete' ? ['destructive', 'data_loss'] : [])
  },
  {
    key: 'github.actions_secret',
    label: 'Actions secret',
    scope: 'app',
    nameField: 'name',
    fields: [
      repositoryRef,
      {
        key: 'environment',
        label: 'Environment',
        kind: 'string',
        createOnly: true,
        replaceOnChange: true,
        help: 'Leave empty for a repository-level secret.'
      },
      {
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: secretNamePattern
      },
      { key: 'value', label: 'Value', kind: 'secret', required: true }
    ],
    capabilities: caps(),
    // The value is write-only: the previous one cannot be read back to restore.
    reversible: (field) => field !== 'value',
    refs: repoRefs,
    risk: (op) => (op.kind === 'delete' ? ['destructive', 'data_loss'] : [])
  },
  {
    key: 'github.actions_variable',
    label: 'Actions variable',
    scope: 'app',
    nameField: 'name',
    fields: [
      repositoryRef,
      {
        key: 'environment',
        label: 'Environment',
        kind: 'string',
        createOnly: true,
        replaceOnChange: true,
        help: 'Leave empty for a repository-level variable.'
      },
      {
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: secretNamePattern
      },
      { key: 'value', label: 'Value', kind: 'string', required: true }
    ],
    capabilities: caps(),
    reversible: true,
    refs: repoRefs,
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
  },
  {
    key: 'github.workflow',
    label: 'Actions workflow',
    scope: 'app',
    nameField: 'workflow',
    fields: [
      repositoryRef,
      {
        key: 'workflow',
        label: 'Workflow file',
        kind: 'string',
        required: true,
        createOnly: true,
        help: 'The file name under .github/workflows, e.g. deploy.yml.'
      },
      { key: 'name', label: 'Name', kind: 'string', readOnly: true },
      { key: 'enabled', label: 'Enabled', kind: 'boolean', default: true },
      { key: 'ref', label: 'Run on branch or tag', kind: 'string', help: 'Used by Run now.' },
      {
        key: 'inputs',
        label: 'Run inputs (JSON)',
        kind: 'string',
        help: 'A JSON object of workflow_dispatch inputs.'
      },
      {
        key: 'dispatch',
        label: 'Run now',
        kind: 'boolean',
        help: 'Starts one workflow_dispatch run on the next apply.',
        trigger: true
      },
      {
        key: 'approve_environment',
        label: 'Approve deployments to',
        kind: 'string',
        help: 'The GitHub environment whose waiting deployment Approve now approves.'
      },
      {
        key: 'approve_run_id',
        label: 'Run to approve',
        kind: 'string',
        help: 'The id of the waiting workflow run a promotion approves (set by the promotion).'
      },
      {
        key: 'approve_sha',
        label: 'Commit of that run',
        kind: 'string',
        help: 'The head commit the run must be at; any other commit is not approved.'
      },
      {
        key: 'approve',
        label: 'Approve now',
        kind: 'boolean',
        help: 'Approves that run on that environment. Only a Hub promotion does this.',
        trigger: true
      }
    ],
    capabilities: NO_CREATE_CAPS,
    // Runs cannot be taken back; enabled/disabled can.
    reversible: (field) => field === 'enabled',
    refs: repoRefs,
    risk: () => []
  },
  {
    key: 'github.deploy_key',
    label: 'Deploy key',
    scope: 'app',
    nameField: 'title',
    fields: [
      repositoryRef,
      { key: 'title', label: 'Title', kind: 'string', required: true, replaceOnChange: true },
      {
        key: 'key',
        label: 'Public key',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        help: 'The SSH public key (ssh-ed25519 AAAA…). The private half stays with the deployer.'
      },
      {
        key: 'read_only',
        label: 'Read only',
        kind: 'boolean',
        default: true,
        replaceOnChange: true
      }
    ],
    capabilities: caps({ update: false }),
    reversible: true,
    refs: repoRefs,
    risk(op, desired) {
      if (op.kind === 'delete') return ['destructive']
      // A key that can push is public exposure of the repository's contents.
      if ((op.kind === 'create' || op.kind === 'replace') && str(desired, 'read_only') === false)
        return ['public_exposure']
      return []
    }
  },
  {
    key: 'github.webhook',
    label: 'Repository webhook',
    scope: 'app',
    nameField: 'url',
    fields: [
      repositoryRef,
      { key: 'url', label: 'Payload URL', kind: 'string', required: true },
      {
        key: 'content_type',
        label: 'Content type',
        kind: 'enum',
        default: 'json',
        options: [
          { value: 'json', label: 'application/json' },
          { value: 'form', label: 'application/x-www-form-urlencoded' }
        ]
      },
      { key: 'secret', label: 'Secret', kind: 'secret' },
      {
        key: 'events',
        label: 'Events',
        kind: 'list',
        items: { key: 'event', label: 'Event', kind: 'string' },
        default: ['push']
      },
      { key: 'active', label: 'Active', kind: 'boolean', default: true }
    ],
    capabilities: caps(),
    reversible: (field) => field !== 'secret',
    refs: repoRefs,
    risk(op, desired) {
      if (op.kind === 'delete') return ['destructive']
      const url = String(str(desired, 'url') ?? '')
      // Repository events sent over plain http, or without a secret to verify them, leave the
      // repository's activity open to anyone who can see the traffic.
      if (url && !url.startsWith('https://')) return ['public_exposure']
      return []
    }
  }
]

export function typeSpec(key: string): ResourceTypeSpec | undefined {
  return TYPES.find((t) => t.key === key)
}
