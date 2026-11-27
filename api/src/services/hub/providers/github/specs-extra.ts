import {
  type DesiredResource,
  type FieldSpec,
  type ResourceCapabilities,
  type ResourceTypeSpec,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import {
  environmentChangeIsTightening,
  isAllowListedPath,
  rulesetChangeIsTightening
} from './weakening.js'

/**
 * Task 19: the resource types added to the GitHub adapter (full coverage). External ids, every
 * one naming the account first:
 *   github.team                    org#team-slug                (shared)
 *   github.team_repo_access        owner/repo#team-slug
 *   github.ruleset                 owner/repo#<id>  or  org#<id>
 *   github.environment_secret      owner/repo@environment#NAME
 *   github.environment_variable    owner/repo@environment#NAME
 *   github.environment_protection  owner/repo#environment       (the object github.environment makes)
 *   github.org_secret / _variable  org#NAME                     (shared)
 *   github.dependabot_secret       owner/repo#NAME
 *   github.runner_group            org#<id>                     (shared)
 *   github.pages                   owner/repo#pages
 *   github.repo_file               owner/repo@branch#path
 */

const caps = (): ResourceCapabilities => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false
})

const str = (d: DesiredResource | null, key: string): unknown => d?.fields?.[key]
const secretNamePattern = '^[A-Za-z_][A-Za-z0-9_]*$'

const repositoryRef: FieldSpec = {
  key: 'repository',
  label: 'Repository',
  kind: 'ref',
  refType: 'github.repository',
  required: true
}
const repoRefs = [{ field: 'repository', type: 'github.repository' }]
const environmentRef: FieldSpec = {
  key: 'environment',
  label: 'Environment',
  kind: 'ref',
  refType: 'github.environment',
  required: true
}
const environmentRefs = [{ field: 'environment', type: 'github.environment' }]
const valueSecret: FieldSpec = { key: 'value', label: 'Value', kind: 'secret', required: true }
const secretName: FieldSpec = {
  key: 'name',
  label: 'Name',
  kind: 'string',
  required: true,
  createOnly: true,
  replaceOnChange: true,
  pattern: secretNamePattern
}
const orgVisibility = [
  { value: 'private', label: 'Private repositories' },
  { value: 'all', label: 'All repositories' },
  { value: 'selected', label: 'Selected repositories' }
]
const repoNames = (help: string): FieldSpec => ({
  key: 'repositories',
  label: 'Repositories',
  kind: 'list',
  items: { key: 'repository_name', label: 'Repository', kind: 'string' },
  help
})

/**
 * Every repository file write needs a Hub administrator unless the path is on the narrow
 * allow-list (README*, docs/**, *.md outside .github/): workflows, actions, scripts, Dockerfiles,
 * package manifests and CODEOWNERS all run code or decide who reviews.
 */
export function isSensitivePath(path: string): boolean {
  return !isAllowListedPath(path)
}

export const EXTRA_TYPES: ResourceTypeSpec[] = [
  {
    key: 'github.team',
    label: 'GitHub team',
    scope: 'shared',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true },
      { key: 'slug', label: 'Slug', kind: 'string', readOnly: true },
      { key: 'description', label: 'Description', kind: 'string' },
      {
        key: 'privacy',
        label: 'Visibility',
        kind: 'enum',
        default: 'closed',
        options: [
          { value: 'closed', label: 'Visible to every member of the organisation' },
          { value: 'secret', label: 'Only its members' }
        ]
      },
      { key: 'parent', label: 'Parent team (slug)', kind: 'string' }
    ],
    capabilities: caps(),
    reversible: true,
    refs: [],
    // Deleting a team takes the repository access it grants with it.
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
  },
  {
    key: 'github.team_repo_access',
    label: 'Team access to a repository',
    scope: 'app',
    nameField: 'permission',
    fields: [
      repositoryRef,
      { key: 'team', label: 'Team', kind: 'ref', refType: 'github.team', required: true },
      {
        key: 'permission',
        label: 'Permission',
        kind: 'enum',
        default: 'pull',
        options: [
          { value: 'pull', label: 'Read' },
          { value: 'triage', label: 'Triage' },
          { value: 'push', label: 'Write' },
          { value: 'maintain', label: 'Maintain' },
          { value: 'admin', label: 'Admin' }
        ]
      }
    ],
    capabilities: caps(),
    reversible: true,
    refs: [...repoRefs, { field: 'team', type: 'github.team' }],
    risk(op, desired) {
      if (op.kind === 'delete') return ['destructive']
      // Admin on a repository can change its settings, secrets and visibility.
      if (str(desired, 'permission') === 'admin') return ['public_exposure']
      return []
    }
  },
  {
    key: 'github.ruleset',
    label: 'Ruleset',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'repository',
        label: 'Repository',
        kind: 'ref',
        refType: 'github.repository',
        help: 'Leave empty for an organisation ruleset.'
      },
      { key: 'name', label: 'Name', kind: 'string', required: true },
      {
        key: 'target',
        label: 'Applies to',
        kind: 'enum',
        default: 'branch',
        options: [
          { value: 'branch', label: 'Branches' },
          { value: 'tag', label: 'Tags' }
        ]
      },
      {
        key: 'enforcement',
        label: 'Enforcement',
        kind: 'enum',
        default: 'active',
        options: [
          { value: 'active', label: 'Active' },
          { value: 'evaluate', label: 'Evaluate (log only)' },
          { value: 'disabled', label: 'Disabled' }
        ]
      },
      {
        key: 'include',
        label: 'Include refs',
        kind: 'list',
        items: { key: 'ref', label: 'Ref pattern', kind: 'string' },
        default: ['~DEFAULT_BRANCH'],
        help: '~DEFAULT_BRANCH, ~ALL, or a pattern such as refs/heads/release/*.'
      },
      {
        key: 'exclude',
        label: 'Exclude refs',
        kind: 'list',
        items: { key: 'ref', label: 'Ref pattern', kind: 'string' }
      },
      {
        key: 'repositories',
        label: 'Repositories (organisation ruleset)',
        kind: 'list',
        items: { key: 'repository_name', label: 'Repository', kind: 'string' },
        help: 'Names or patterns; empty means all repositories.'
      },
      {
        key: 'required_reviews',
        label: 'Required approving reviews',
        kind: 'number',
        min: 0,
        max: 10,
        default: 0,
        help: '0 adds no pull request rule.'
      },
      { key: 'dismiss_stale_reviews', label: 'Dismiss stale reviews', kind: 'boolean' },
      { key: 'require_code_owner_review', label: 'Require code owner review', kind: 'boolean' },
      {
        key: 'require_conversation_resolution',
        label: 'Resolve conversations before merging',
        kind: 'boolean'
      },
      {
        key: 'required_status_checks',
        label: 'Required status checks',
        kind: 'list',
        items: { key: 'check', label: 'Check', kind: 'string' }
      },
      { key: 'strict_status_checks', label: 'Branch must be up to date', kind: 'boolean' },
      { key: 'block_deletions', label: 'Block deleting the ref', kind: 'boolean' },
      { key: 'block_force_pushes', label: 'Block force pushes', kind: 'boolean' },
      { key: 'require_linear_history', label: 'Linear history', kind: 'boolean' },
      { key: 'require_signatures', label: 'Require signed commits', kind: 'boolean' }
    ],
    capabilities: caps(),
    reversible: true,
    refs: [{ field: 'repository', type: 'github.repository', required: false }],
    risk(op, desired) {
      // Anything that is not provably a tightening needs a Hub administrator.
      if (op.kind === 'delete') return ['destructive', 'public_exposure']
      if (str(desired, 'enforcement') !== undefined && str(desired, 'enforcement') !== 'active')
        return ['public_exposure']
      if (op.kind === 'create' || op.kind === 'noop') return []
      return op.changes.every(rulesetChangeIsTightening) ? [] : ['public_exposure']
    }
  },
  {
    key: 'github.environment_secret',
    label: 'Environment secret',
    scope: 'app',
    nameField: 'name',
    fields: [environmentRef, secretName, valueSecret],
    capabilities: caps(),
    reversible: (field) => field !== 'value',
    refs: environmentRefs,
    risk: (op) => (op.kind === 'delete' ? ['destructive', 'data_loss'] : [])
  },
  {
    key: 'github.environment_variable',
    label: 'Environment variable',
    scope: 'app',
    nameField: 'name',
    fields: [
      environmentRef,
      secretName,
      { key: 'value', label: 'Value', kind: 'string', required: true }
    ],
    capabilities: caps(),
    reversible: true,
    refs: environmentRefs,
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
  },
  {
    key: 'github.environment_protection',
    label: 'Environment protection',
    scope: 'app',
    nameField: 'environment',
    fields: [
      environmentRef,
      {
        key: 'reviewers',
        label: 'Required reviewers',
        kind: 'list',
        items: { key: 'reviewer', label: 'Reviewer', kind: 'string' },
        help: 'user:login or team:slug, at most 6. A deployment waits for one of them.'
      },
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
          { value: 'selected', label: 'Selected branches' }
        ]
      },
      {
        key: 'branch_patterns',
        label: 'Branch patterns',
        kind: 'list',
        items: { key: 'pattern', label: 'Pattern', kind: 'string' },
        help: 'Used when the deployment branches are "Selected branches".'
      }
    ],
    capabilities: caps(),
    reversible: true,
    refs: environmentRefs,
    risk(op) {
      // Deleting protection removes the gate; any change that is not provably tighter weakens it.
      if (op.kind === 'delete') return ['destructive', 'public_exposure']
      if (op.kind !== 'update' && op.kind !== 'replace') return []
      return op.changes.every(environmentChangeIsTightening) ? [] : ['public_exposure']
    }
  },
  {
    key: 'github.org_secret',
    label: 'Organisation secret',
    scope: 'shared',
    nameField: 'name',
    fields: [
      secretName,
      valueSecret,
      {
        key: 'visibility',
        label: 'Available to',
        kind: 'enum',
        default: 'private',
        options: orgVisibility
      },
      repoNames('When available to selected repositories.')
    ],
    capabilities: caps(),
    reversible: (field) => field !== 'value',
    refs: [],
    risk(op, desired) {
      if (op.kind === 'delete') return ['destructive', 'data_loss']
      return str(desired, 'visibility') === 'all' ? ['public_exposure'] : []
    }
  },
  {
    key: 'github.org_variable',
    label: 'Organisation variable',
    scope: 'shared',
    nameField: 'name',
    fields: [
      secretName,
      { key: 'value', label: 'Value', kind: 'string', required: true },
      {
        key: 'visibility',
        label: 'Available to',
        kind: 'enum',
        default: 'private',
        options: orgVisibility
      },
      repoNames('When available to selected repositories.')
    ],
    capabilities: caps(),
    reversible: true,
    refs: [],
    risk(op, desired) {
      if (op.kind === 'delete') return ['destructive']
      return str(desired, 'visibility') === 'all' ? ['public_exposure'] : []
    }
  },
  {
    key: 'github.dependabot_secret',
    label: 'Dependabot secret',
    scope: 'app',
    nameField: 'name',
    fields: [repositoryRef, secretName, valueSecret],
    capabilities: caps(),
    reversible: (field) => field !== 'value',
    refs: repoRefs,
    risk: (op) => (op.kind === 'delete' ? ['destructive', 'data_loss'] : [])
  },
  {
    key: 'github.runner_group',
    label: 'Runner group',
    scope: 'shared',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true },
      {
        key: 'visibility',
        label: 'Available to',
        kind: 'enum',
        default: 'private',
        options: orgVisibility
      },
      repoNames('When available to selected repositories.'),
      {
        key: 'allows_public_repositories',
        label: 'Public repositories may use it',
        kind: 'boolean',
        help: 'A self-hosted runner that runs code from a public repository runs anyone’s code.'
      },
      {
        key: 'register_runner',
        label: 'New registration token',
        kind: 'boolean',
        trigger: true,
        help: 'Makes a runner registration token on the next apply. GitHub shows it once.'
      },
      {
        key: ROTATE_OUTPUTS_FIELD,
        label: 'Rotate the registration token',
        kind: 'boolean',
        trigger: true
      }
    ],
    outputs: [
      {
        key: 'registration_token',
        label: 'Runner registration token',
        secret: true,
        onceOnly: true
      }
    ],
    capabilities: caps(),
    // A token cannot be taken back; the group's own settings can.
    reversible: (field) => field !== 'register_runner' && field !== ROTATE_OUTPUTS_FIELD,
    refs: [],
    risk(op, desired) {
      if (op.kind === 'delete') return ['destructive']
      if (op.action === 'register_runner') return []
      return str(desired, 'allows_public_repositories') === true ? ['public_exposure'] : []
    }
  },
  {
    key: 'github.pages',
    label: 'GitHub Pages',
    scope: 'app',
    nameField: 'repository',
    fields: [
      repositoryRef,
      {
        key: 'build_type',
        label: 'Build from',
        kind: 'enum',
        default: 'workflow',
        options: [
          { value: 'workflow', label: 'A GitHub Actions workflow' },
          { value: 'legacy', label: 'A branch' }
        ]
      },
      { key: 'source_branch', label: 'Branch', kind: 'string', help: 'When built from a branch.' },
      {
        key: 'source_path',
        label: 'Folder',
        kind: 'enum',
        default: '/',
        options: [
          { value: '/', label: '/ (root)' },
          { value: '/docs', label: '/docs' }
        ]
      },
      { key: 'cname', label: 'Custom domain', kind: 'string' },
      { key: 'https_enforced', label: 'Require HTTPS', kind: 'boolean', default: true }
    ],
    capabilities: caps(),
    reversible: true,
    refs: repoRefs,
    // A Pages site is public on the internet.
    risk(op) {
      if (op.kind === 'create') return ['public_exposure']
      if (op.kind === 'delete') return ['destructive']
      return []
    }
  },
  {
    key: 'github.repo_file',
    label: 'Repository file',
    scope: 'app',
    nameField: 'path',
    fields: [
      repositoryRef,
      {
        key: 'path',
        label: 'Path',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        help: 'For example CODEOWNERS or .github/workflows/deploy.yml.'
      },
      {
        key: 'branch',
        label: 'Branch',
        kind: 'string',
        createOnly: true,
        replaceOnChange: true,
        help: 'Empty = the default branch.'
      },
      {
        key: 'content',
        label: 'Content',
        kind: 'string',
        required: true,
        help: 'Plain text, at most 1 MB. Never put a secret in a file.'
      },
      {
        key: 'message',
        label: 'Commit message',
        kind: 'string',
        help: 'Used for the next commit only.'
      }
    ],
    capabilities: caps(),
    reversible: true,
    refs: repoRefs,
    risk(op, desired) {
      // A delete does not know the path (no desired values): it is admin-only too.
      if (op.kind === 'delete') return ['destructive', 'public_exposure']
      return isSensitivePath(String(str(desired, 'path') ?? '')) ? ['public_exposure'] : []
    }
  }
]
