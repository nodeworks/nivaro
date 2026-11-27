import {
  type FieldSpec,
  type OutputSpec,
  type PlannedOp,
  type ResourceTypeSpec,
  type RiskFlag,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import { coversEveryone } from './ip.js'
import { SQL_SKUS, sqlDatabaseEstimate } from './pricing.js'

export const RG = 'azure.resource_group'
export const SRV = 'azure.sql_server'
export const FW = 'azure.sql_firewall_rule'
export const DB = 'azure.sql_database'
export const PE = 'azure.sql_private_endpoint'
export const BUDGET = 'azure.budget'
export const ROTATE = ROTATE_OUTPUTS_FIELD

const GROUP_REF: FieldSpec = {
  key: 'resource_group',
  label: 'Resource group',
  kind: 'ref',
  refType: RG,
  required: true,
  createOnly: true,
  replaceOnChange: true
}
const SERVER_REF: FieldSpec = {
  key: 'server',
  label: 'SQL server',
  kind: 'ref',
  refType: SRV,
  required: true,
  createOnly: true,
  replaceOnChange: true
}
const NAME = (pattern: string, help?: string): FieldSpec => ({
  key: 'name',
  label: 'Name',
  kind: 'string',
  required: true,
  createOnly: true,
  replaceOnChange: true,
  pattern,
  ...(help ? { help } : {})
})
const LOCATION: FieldSpec = {
  key: 'location',
  label: 'Region',
  kind: 'string',
  required: true,
  createOnly: true,
  replaceOnChange: true,
  help: 'An Azure region name such as eastus or westeurope.'
}
const SUBSCRIPTION: FieldSpec = {
  key: 'subscription_id',
  label: 'Subscription',
  kind: 'string',
  required: true,
  createOnly: true,
  replaceOnChange: true,
  optionsFrom: 'subscription_ids',
  help: 'One of the connection’s subscriptions.'
}

const CAPS = (over: Partial<ResourceTypeSpec['capabilities']> = {}) => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false,
  ...over
})

const SERVER_OUTPUTS: OutputSpec[] = [
  {
    key: 'connection_string',
    label: 'SQL connection string (admin login)',
    secret: true,
    onceOnly: true
  },
  { key: 'server_fqdn', label: 'Server address', secret: false }
]

const fieldsOf = (op: PlannedOp, desired: { fields: Record<string, unknown> } | null) => ({
  changed: (k: string) => op.kind === 'create' || op.changes.some((c) => c.field === k),
  want: desired?.fields ?? {}
})

export const AZURE_SPECS: ResourceTypeSpec[] = [
  {
    key: RG,
    label: 'Azure resource group',
    scope: 'shared',
    nameField: 'name',
    fields: [SUBSCRIPTION, NAME('^[\\w().-]{1,90}$'), LOCATION],
    capabilities: CAPS({ update: false, tag: true }),
    reversible: false,
    refs: [],
    risk(op) {
      // The adapter refuses a delete while the group holds anything (GROUP_NOT_EMPTY).
      return op.kind === 'delete' ? ['destructive'] : []
    }
  },
  {
    key: SRV,
    label: 'Azure SQL server',
    scope: 'shared',
    nameField: 'name',
    fields: [
      GROUP_REF,
      NAME(
        '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$',
        'Lower case letters, digits and dashes; becomes <name>.database.windows.net.'
      ),
      LOCATION,
      {
        key: 'entra_only_auth',
        label: 'Entra sign-in only',
        kind: 'boolean',
        default: true,
        help: 'On: only Entra accounts sign in (no SQL password, no connection string output). Off: a SQL admin login is made and its connection string is an output.'
      },
      { key: 'entra_admin_login', label: 'Entra admin (name)', kind: 'string' },
      { key: 'entra_admin_object_id', label: 'Entra admin (object id)', kind: 'string' },
      {
        key: 'entra_admin_type',
        label: 'Entra admin is a',
        kind: 'enum',
        default: 'Group',
        createOnly: true,
        options: [
          { value: 'Group', label: 'Group' },
          { value: 'User', label: 'User' },
          { value: 'Application', label: 'Application' }
        ]
      },
      {
        key: 'minimal_tls_version',
        label: 'Minimum TLS version',
        kind: 'enum',
        default: '1.2',
        options: [
          { value: '1.2', label: 'TLS 1.2' },
          { value: '1.3', label: 'TLS 1.3' }
        ]
      },
      {
        key: 'public_network_access',
        label: 'Public network access',
        kind: 'boolean',
        default: false,
        help: 'Off by default: reachable only through a private endpoint. Turning it on exposes the server to the internet, limited only by its firewall rules.'
      },
      {
        key: 'sql_admin_login',
        label: 'SQL admin login',
        kind: 'string',
        default: 'nivarohub',
        createOnly: true,
        help: 'Used when Entra sign-in only is off.'
      },
      {
        key: 'admin_password',
        label: 'SQL admin password',
        kind: 'secret',
        createOnly: true,
        help: 'Optional: empty = the Hub makes one. Never shown again; the connection string output carries it.'
      },
      {
        key: 'app_database',
        label: 'Database the connection string names',
        kind: 'string',
        default: 'master',
        help: 'Create it as an Azure SQL database on this server; the connection string output points at it.'
      },
      {
        key: ROTATE,
        label: 'Rotate the SQL admin password',
        kind: 'boolean',
        trigger: true
      },
      { key: 'fqdn', label: 'Server address', kind: 'string', readOnly: true }
    ],
    capabilities: CAPS({ tag: true }),
    reversible: false,
    refs: [{ field: 'resource_group', type: RG, required: true }],
    outputs: SERVER_OUTPUTS,
    risk(op, desired) {
      const out: RiskFlag[] = []
      const { changed, want } = fieldsOf(op, desired)
      if (op.kind === 'delete') out.push('destructive', 'data_loss')
      else {
        // Judged on what is sent: public access on is "everyone can try the server".
        if (
          op.kind !== 'noop' &&
          changed('public_network_access') &&
          want.public_network_access === true
        )
          out.push('public_exposure')
        if (op.action === ROTATE) out.push('downtime')
      }
      return out
    }
  },
  {
    key: FW,
    label: 'Azure SQL firewall rule',
    scope: 'shared',
    nameField: 'name',
    fields: [
      SERVER_REF,
      NAME('^[\\w.-]{1,128}$'),
      { key: 'start_ip_address', label: 'Start IPv4 address', kind: 'string', required: true },
      { key: 'end_ip_address', label: 'End IPv4 address', kind: 'string', required: true }
    ],
    capabilities: CAPS(),
    reversible: true,
    refs: [{ field: 'server', type: SRV, required: true }],
    risk(op, desired) {
      if (op.kind === 'delete' || op.kind === 'noop') return []
      const f = desired?.fields ?? {}
      // A range that covers the internet (or 0.0.0.0, every Azure service) is "everyone".
      return coversEveryone(f.start_ip_address, f.end_ip_address) ? ['public_exposure'] : []
    }
  },
  {
    key: DB,
    label: 'Azure SQL database',
    scope: 'app',
    nameField: 'name',
    fields: [
      SERVER_REF,
      NAME('^[\\w.-]{1,128}$'),
      {
        key: 'sku_name',
        label: 'Size',
        kind: 'enum',
        required: true,
        default: 'S0',
        options: SQL_SKUS.map((s) => ({
          value: s.name,
          label:
            s.model === 'dtu'
              ? `${s.tier} ${s.name}`.replace('Basic Basic', 'Basic')
              : `${s.tier === 'GeneralPurpose' ? 'General Purpose' : 'Business Critical'}${s.model === 'serverless' ? ' serverless' : ''} (vCores)`
        }))
      },
      {
        key: 'capacity',
        label: 'vCores',
        kind: 'number',
        min: 1,
        max: 128,
        help: 'For the vCore sizes; the DTU tiers ignore it.'
      },
      { key: 'max_size_gb', label: 'Maximum size (GB)', kind: 'number', min: 1, default: 32 },
      {
        key: 'backup_retention_days',
        label: 'Backup retention (days)',
        kind: 'number',
        min: 1,
        max: 35,
        default: 7,
        help: 'Point-in-time restore window: also what the restore point recorded before a delete relies on.'
      },
      { key: 'location', label: 'Region', kind: 'string', readOnly: true }
    ],
    capabilities: CAPS({ snapshot: true, tag: true }),
    reversible: false,
    refs: [{ field: 'server', type: SRV, required: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'data_loss')
      // A size change moves the database to other hardware: connections drop at the switch.
      if (
        op.kind === 'update' &&
        op.changes.some((c) => ['sku_name', 'capacity', 'max_size_gb'].includes(c.field))
      )
        out.push('downtime')
      return out
    },
    costClass: () => 'monthly',
    estimate: sqlDatabaseEstimate
  },
  {
    key: PE,
    label: 'Azure SQL private endpoint connection',
    scope: 'shared',
    nameField: 'name',
    fields: [
      SERVER_REF,
      { key: 'name', label: 'Name', kind: 'string', readOnly: true },
      { key: 'status', label: 'Status', kind: 'string', readOnly: true },
      { key: 'private_endpoint', label: 'Private endpoint', kind: 'string', readOnly: true }
    ],
    capabilities: CAPS({ create: false, update: false, delete: false }),
    reversible: false,
    refs: [{ field: 'server', type: SRV, required: true }],
    risk: () => []
  },
  {
    key: BUDGET,
    label: 'Azure budget',
    scope: 'app',
    nameField: 'name',
    fields: [
      SUBSCRIPTION,
      NAME('^[\\w.-]{1,63}$'),
      { key: 'amount', label: 'Monthly amount', kind: 'number', required: true, min: 1 },
      {
        key: 'app_tag',
        label: 'App tag value',
        kind: 'string',
        help: 'The value of the nivaro-hub-app tag the budget counts. Empty = this app.'
      },
      {
        key: 'thresholds',
        label: 'Alert at (% of the amount)',
        kind: 'list',
        items: { key: 'threshold', label: 'Percent', kind: 'number', min: 1, max: 1000 },
        default: [80, 100]
      },
      {
        key: 'contact_emails',
        label: 'Alert emails',
        kind: 'list',
        required: true,
        items: { key: 'email', label: 'Email', kind: 'string' }
      },
      { key: 'start_date', label: 'Starts', kind: 'string', readOnly: true }
    ],
    capabilities: CAPS(),
    reversible: true,
    refs: [],
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
  }
]
