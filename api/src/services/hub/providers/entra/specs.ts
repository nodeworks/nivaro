import {
  type FieldSpec,
  type PlannedOp,
  type ResourceTypeSpec,
  type RiskFlag,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import { riskyUrl, strs } from './shared.js'

/** The Entra resource type specs. Behaviour lives in application.ts, secret.ts and principals.ts. */

export const APP = 'entra.app_registration'
export const SECRET = 'entra.client_secret'
export const SP = 'entra.service_principal'
export const ROLE = 'entra.app_role'
export const ASSIGN = 'entra.group_role_assignment'
export const PERM = 'entra.api_permission'
export const GROUP = 'entra.group'

/** Microsoft Graph's own application id: the default API a permission request is for. */
export const GRAPH_RESOURCE_APP_ID = '00000003-0000-0000-c000-000000000000'
/** The role id Entra uses for "default access" (an assignment with no app role). */
export const DEFAULT_ACCESS_ROLE = '00000000-0000-0000-0000-000000000000'

const GUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

const textItem: FieldSpec = { key: 'item', label: 'Value', kind: 'string' }

const CAPS = {
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: true
}

const appFields: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', required: true },
  {
    key: 'sign_in_audience',
    label: 'Who can sign in',
    kind: 'enum',
    default: 'AzureADMyOrg',
    options: [
      { value: 'AzureADMyOrg', label: 'This organization only (single tenant)' },
      { value: 'AzureADMultipleOrgs', label: 'Any organization (multitenant)' },
      {
        value: 'AzureADandPersonalMicrosoftAccount',
        label: 'Any organization and personal Microsoft accounts'
      },
      { value: 'PersonalMicrosoftAccount', label: 'Personal Microsoft accounts only' }
    ]
  },
  {
    key: 'web_redirect_uris',
    label: 'Web redirect URIs',
    kind: 'list',
    items: textItem,
    help: 'Where Entra may send people after they sign in (a web app: `<address>/api/auth/callback`).'
  },
  {
    key: 'spa_redirect_uris',
    label: 'Single-page app redirect URIs',
    kind: 'list',
    items: textItem,
    help: 'Redirect addresses for a single-page app (PKCE sign-in).'
  },
  {
    key: 'logout_url',
    label: 'Sign-out URL',
    kind: 'string',
    help: 'Where Entra sends the sign-out request.'
  },
  { key: 'app_id', label: 'Application (client) ID', kind: 'string', readOnly: true }
]

const secretFields: FieldSpec[] = [
  {
    key: 'application',
    label: 'App registration',
    kind: 'ref',
    refType: APP,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'name',
    label: 'Secret name',
    kind: 'string',
    required: true,
    createOnly: true,
    help: 'Shown in Entra next to the secret. A rotation adds “(rotated …)” to it.'
  },
  {
    key: 'valid_months',
    label: 'Valid for (months)',
    kind: 'number',
    default: 12,
    min: 1,
    max: 24,
    createOnly: true,
    help: 'The secret stops working after this. The health check warns 30 days before.'
  },
  {
    key: ROTATE_OUTPUTS_FIELD,
    label: 'Rotate the secret',
    kind: 'boolean',
    trigger: true,
    help: 'Makes a new secret next to the current one. Bind it, apply the stack, then remove the older secrets.'
  },
  {
    key: 'remove_older',
    label: 'Remove older secrets',
    kind: 'boolean',
    trigger: true,
    help: 'After the stack applied the new secret: deletes the earlier secrets of this name on the app registration.'
  },
  { key: 'expires_at', label: 'Expires', kind: 'string', readOnly: true },
  { key: 'key_id', label: 'Key ID', kind: 'string', readOnly: true },
  {
    key: 'older_secrets',
    label: 'Older secrets still valid',
    kind: 'list',
    items: textItem,
    readOnly: true
  }
]

const spFields: FieldSpec[] = [
  {
    key: 'application',
    label: 'App registration',
    kind: 'ref',
    refType: APP,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'assignment_required',
    label: 'Require assignment',
    kind: 'boolean',
    default: false,
    help: 'Only people and groups assigned to the app can sign in.'
  },
  { key: 'enabled', label: 'Sign-in enabled', kind: 'boolean', default: true },
  { key: 'app_id', label: 'Application (client) ID', kind: 'string', readOnly: true }
]

const roleFields: FieldSpec[] = [
  {
    key: 'application',
    label: 'App registration',
    kind: 'ref',
    refType: APP,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'value',
    label: 'Role value',
    kind: 'string',
    required: true,
    pattern: '^\\S{1,120}$',
    help: 'The text the app reads in the sign-in token (for example `admin`). No spaces.'
  },
  { key: 'display_name', label: 'Display name', kind: 'string', required: true },
  { key: 'description', label: 'Description', kind: 'string', required: true },
  {
    key: 'allowed_member_types',
    label: 'Who can hold it',
    kind: 'list',
    items: {
      key: 'type',
      label: 'Member type',
      kind: 'enum',
      options: [
        { value: 'User', label: 'People and groups' },
        { value: 'Application', label: 'Applications' }
      ]
    },
    default: ['User']
  },
  { key: 'enabled', label: 'Enabled', kind: 'boolean', default: true }
]

const assignFields: FieldSpec[] = [
  {
    key: 'service_principal',
    label: 'Enterprise application',
    kind: 'ref',
    refType: SP,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'group',
    label: 'Group',
    kind: 'ref',
    refType: GROUP,
    required: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'An existing group, adopted into the Hub first. The Hub never creates or changes groups.'
  },
  {
    key: 'app_role',
    label: 'App role',
    kind: 'ref',
    refType: ROLE,
    createOnly: true,
    replaceOnChange: true,
    help: 'Empty = default access.'
  }
]

const permFields: FieldSpec[] = [
  {
    key: 'application',
    label: 'App registration',
    kind: 'ref',
    refType: APP,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'resource_app_id',
    label: 'API (application id)',
    kind: 'string',
    default: GRAPH_RESOURCE_APP_ID,
    createOnly: true,
    replaceOnChange: true,
    pattern: GUID_PATTERN,
    help: 'The API the permissions are for. Default: Microsoft Graph.'
  },
  {
    key: 'permissions',
    label: 'Requested permissions',
    kind: 'list',
    items: {
      key: 'permission',
      label: 'Permission',
      kind: 'object',
      fields: [
        {
          key: 'id',
          label: 'Permission id',
          kind: 'string',
          required: true,
          pattern: GUID_PATTERN,
          help: 'The permission’s GUID from the API’s documentation.'
        },
        {
          key: 'type',
          label: 'Type',
          kind: 'enum',
          required: true,
          options: [
            { value: 'Scope', label: 'Delegated (on behalf of a person)' },
            { value: 'Role', label: 'Application (the app itself)' }
          ]
        }
      ]
    },
    help: 'Requesting a permission does not grant it: a person gives admin consent in Entra. Health shows “consent needed” with the link.'
  }
]

const groupFields: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', readOnly: true },
  { key: 'description', label: 'Description', kind: 'string', readOnly: true },
  { key: 'security_enabled', label: 'Security group', kind: 'boolean', readOnly: true },
  { key: 'mail_enabled', label: 'Mail enabled', kind: 'boolean', readOnly: true },
  { key: 'membership', label: 'Membership', kind: 'string', readOnly: true }
]

const wantsRisky = (op: PlannedOp, fields: string[]): boolean =>
  op.changes.some((c) => {
    if (!fields.includes(c.field)) return false
    const before = new Set(strs(c.from))
    return strs(c.to).some((u) => !before.has(u) && riskyUrl(u))
  })

function riskApp(op: PlannedOp): RiskFlag[] {
  const flags = new Set<RiskFlag>()
  if (op.kind === 'delete' || op.kind === 'replace') {
    flags.add('destructive')
    flags.add('downtime')
  }
  if (
    op.changes.some(
      (c) => c.field === 'sign_in_audience' && c.to !== undefined && c.to !== 'AzureADMyOrg'
    )
  )
    flags.add('public_exposure')
  if (wantsRisky(op, ['web_redirect_uris', 'spa_redirect_uris'])) flags.add('public_exposure')
  return [...flags]
}

function riskSecret(op: PlannedOp): RiskFlag[] {
  if (op.kind === 'delete' || op.kind === 'replace') return ['destructive', 'downtime']
  // Removing the earlier secrets after a rotation ends everything still signed in with them.
  if (op.action === 'remove_older') return ['destructive']
  return []
}

function riskSp(op: PlannedOp): RiskFlag[] {
  const flags = new Set<RiskFlag>()
  if (op.kind === 'delete' || op.kind === 'replace') {
    flags.add('destructive')
    flags.add('downtime')
  }
  // Requiring assignment or switching sign-in off stops people who are not assigned.
  for (const c of op.changes) {
    if (c.field === 'assignment_required' && c.to === true) flags.add('downtime')
    if (c.field === 'enabled' && c.to === false) flags.add('downtime')
  }
  return [...flags]
}

function riskRole(op: PlannedOp): RiskFlag[] {
  const flags = new Set<RiskFlag>()
  if (op.kind === 'delete' || op.kind === 'replace') {
    flags.add('destructive')
    flags.add('downtime')
  }
  // Apps match a role by its value in the token: a new value or a switched-off role breaks them.
  for (const c of op.changes) {
    if (c.field === 'value') flags.add('downtime')
    if (c.field === 'enabled' && c.to === false) flags.add('downtime')
  }
  return [...flags]
}

function riskAssign(op: PlannedOp): RiskFlag[] {
  // Removing an assignment signs the group's members out of the app.
  return op.kind === 'delete' || op.kind === 'replace' ? ['downtime'] : []
}

function riskPerm(op: PlannedOp): RiskFlag[] {
  // An application permission (`Role`) is what the app can do on its own, tenant-wide: admins only.
  const before = new Set(
    (Array.isArray(op.changes.find((c) => c.field === 'permissions')?.from)
      ? (op.changes.find((c) => c.field === 'permissions')?.from as Array<Record<string, unknown>>)
      : []
    ).map((p) => `${p.type}:${p.id}`)
  )
  const added = op.changes.some(
    (c) =>
      c.field === 'permissions' &&
      Array.isArray(c.to) &&
      (c.to as Array<Record<string, unknown>>).some(
        (p) => p.type === 'Role' && !before.has(`${p.type}:${p.id}`)
      )
  )
  return added ? ['public_exposure'] : []
}

export const ENTRA_TYPES: ResourceTypeSpec[] = [
  {
    key: APP,
    label: 'Entra app registration',
    scope: 'app',
    fields: appFields,
    capabilities: CAPS,
    reversible: true,
    refs: [],
    outputs: [
      { key: 'client_id', label: 'Application (client) ID', secret: false },
      { key: 'tenant_id', label: 'Directory (tenant) ID', secret: false }
    ],
    risk: (op) => riskApp(op)
  },
  {
    key: SECRET,
    label: 'Entra client secret',
    scope: 'app',
    fields: secretFields,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    // A secret is shown once; undoing a delete would need a new one.
    reversible: false,
    refs: [{ field: 'application', type: APP, required: true }],
    outputs: [{ key: 'client_secret', label: 'Client secret', secret: true, onceOnly: true }],
    risk: (op) => riskSecret(op)
  },
  {
    key: SP,
    label: 'Entra enterprise application',
    scope: 'app',
    fields: spFields,
    capabilities: CAPS,
    reversible: true,
    refs: [{ field: 'application', type: APP, required: true }],
    risk: (op) => riskSp(op)
  },
  {
    key: ROLE,
    label: 'Entra app role',
    scope: 'app',
    fields: roleFields,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [{ field: 'application', type: APP, required: true }],
    nameField: 'value',
    risk: (op) => riskRole(op)
  },
  {
    key: ASSIGN,
    label: 'Entra group role assignment',
    scope: 'app',
    fields: assignFields,
    capabilities: {
      create: true,
      update: false,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [
      { field: 'service_principal', type: SP, required: true },
      { field: 'group', type: GROUP, required: true },
      { field: 'app_role', type: ROLE, required: false }
    ],
    risk: (op) => riskAssign(op)
  },
  {
    key: PERM,
    label: 'Entra API permissions',
    scope: 'app',
    fields: permFields,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [{ field: 'application', type: APP, required: true }],
    risk: (op) => riskPerm(op)
  },
  {
    key: GROUP,
    label: 'Entra group',
    scope: 'shared',
    fields: groupFields,
    // Read and adopt only: the Hub never creates, changes or deletes a group.
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
    risk: () => []
  }
]
