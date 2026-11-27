import {
  type DesiredResource,
  type FieldSpec,
  type Observed,
  type ProviderContext,
  ProviderError,
  type SecretValue
} from '../types.js'
import { awsQuery, keyValueTags, orNull, waitFor } from './client.js'
import {
  type AwsListPage,
  type AwsTypeDef,
  cap,
  nameField,
  observed,
  regionField,
  riskOf
} from './kit.js'
import { type XmlValue, xmlChild, xmlList, xmlText } from './xml.js'

/**
 * aws.rds_instance, aws.rds_subnet_group, aws.rds_parameter_group. Ids are the RDS identifiers
 * (instance id, group name). An instance is always `cost: monthly`; it is deleted only with a
 * final snapshot (`nivaro-final-<id>-<time>`, named at plan time); the master password is a
 * secret field, read only inside apply.
 */

const t = xmlText
const c = xmlChild
const list = (v: XmlValue | undefined, name: string) => xmlList(v, name)
const bool = (v: XmlValue | undefined) => xmlText(v) === 'true'
const num = (v: XmlValue | undefined) => (xmlText(v) === '' ? undefined : Number(xmlText(v)))
const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 12)

const refList = (key: string, label: string, refType: string): FieldSpec => ({
  key,
  label,
  kind: 'list',
  items: { key: 'item', label, kind: 'ref', refType }
})

const ids = (v: string | string[] | null | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []

const idOf = (v: string | string[] | null | undefined, what: string): string => {
  if (typeof v !== 'string' || !v)
    throw new ProviderError('REF_UNRESOLVED', `${what} is not created yet.`)
  return v
}

/** RDS `TagList` as a map. */
function tagMap(v: XmlValue | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const x of list(v, 'Tag')) {
    const k = t(c(x, 'Key'))
    if (k) out[k] = t(c(x, 'Value'))
  }
  return out
}

async function tagsFor(
  ctx: ProviderContext,
  region: string,
  arn: string
): Promise<Record<string, string>> {
  if (!arn) return {}
  const r = await awsQuery(ctx, 'rds', 'ListTagsForResource', { ResourceName: arn }, { region })
  return tagMap(r.TagList)
}

async function putTags(
  ctx: ProviderContext,
  region: string,
  arn: string,
  tags: Record<string, string>
) {
  await awsQuery(
    ctx,
    'rds',
    'AddTagsToResource',
    { ResourceName: arn, Tags: keyValueTags(tags) },
    { region }
  )
}

const rdsTags = (d: DesiredResource) => ({ ...d.tags, 'nivaro-hub:managed': 'true' })

// ── Instance ──

async function instanceFromNode(
  ctx: ProviderContext,
  v: XmlValue,
  region: string,
  withTags = true
): Promise<Observed | null> {
  const id = t(c(v, 'DBInstanceIdentifier'))
  if (!id) return null
  const arn = t(c(v, 'DBInstanceArn'))
  const tags = withTags ? await tagsFor(ctx, region, arn) : {}
  const group = list(c(v, 'DBParameterGroups'), 'DBParameterGroup')[0]
  const o = observed(
    'aws.rds_instance',
    id,
    region,
    id,
    {
      engine: t(c(v, 'Engine')),
      engine_version: t(c(v, 'EngineVersion')),
      instance_class: t(c(v, 'DBInstanceClass')),
      allocated_storage_gb: num(c(v, 'AllocatedStorage')),
      storage_type: t(c(v, 'StorageType')) || undefined,
      multi_az: bool(c(v, 'MultiAZ')),
      db_name: t(c(v, 'DBName')) || undefined,
      master_username: t(c(v, 'MasterUsername')),
      subnet_group: t(c(c(v, 'DBSubnetGroup'), 'DBSubnetGroupName')) || undefined,
      parameter_group: t(c(group, 'DBParameterGroupName')) || undefined,
      security_groups: list(c(v, 'VpcSecurityGroups'), 'VpcSecurityGroupMembership').map((m) =>
        t(c(m, 'VpcSecurityGroupId'))
      ),
      backup_retention_days: num(c(v, 'BackupRetentionPeriod')),
      publicly_accessible: bool(c(v, 'PubliclyAccessible')),
      deletion_protection: bool(c(v, 'DeletionProtection')),
      storage_encrypted: bool(c(v, 'StorageEncrypted')),
      endpoint: t(c(c(v, 'Endpoint'), 'Address')) || undefined,
      port: num(c(c(v, 'Endpoint'), 'Port'))
    },
    tags,
    t(c(v, 'DBInstanceStatus'))
  )
  o.url = arn || null
  return o
}

async function describeInstance(ctx: ProviderContext, id: string, region: string) {
  const r = await orNull(() =>
    awsQuery(ctx, 'rds', 'DescribeDBInstances', { DBInstanceIdentifier: id }, { region })
  )
  const v = r && list(r.DBInstances, 'DBInstance')[0]
  return v ? instanceFromNode(ctx, v, region) : null
}

const MODIFIABLE: Array<[field: string, param: string]> = [
  ['instance_class', 'DBInstanceClass'],
  ['allocated_storage_gb', 'AllocatedStorage'],
  ['storage_type', 'StorageType'],
  ['multi_az', 'MultiAZ'],
  ['backup_retention_days', 'BackupRetentionPeriod'],
  ['publicly_accessible', 'PubliclyAccessible'],
  ['deletion_protection', 'DeletionProtection'],
  ['engine_version', 'EngineVersion']
]

const secretPlain = (d: DesiredResource, key: string): string | undefined =>
  (d.fields[key] as SecretValue | undefined)?.plain

export const rdsInstanceDef: AwsTypeDef = {
  spec: {
    key: 'aws.rds_instance',
    label: 'RDS instance',
    scope: 'app',
    nameField: 'name',
    fields: [
      regionField,
      {
        ...nameField,
        label: 'Identifier',
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[a-zA-Z][a-zA-Z0-9-]{0,62}$'
      },
      {
        key: 'engine',
        label: 'Engine',
        kind: 'enum',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        options: ['postgres', 'mysql', 'mariadb', 'sqlserver-ex', 'sqlserver-se', 'oracle-se2'].map(
          (v) => ({ value: v, label: v })
        )
      },
      { key: 'engine_version', label: 'Engine version', kind: 'string' },
      {
        key: 'instance_class',
        label: 'Instance class',
        kind: 'string',
        required: true,
        pattern: '^db\\.[a-z0-9]+\\.[a-z0-9]+$',
        help: 'A change restarts the database.'
      },
      {
        key: 'allocated_storage_gb',
        label: 'Storage (GiB)',
        kind: 'number',
        required: true,
        min: 20,
        help: 'Can grow, never shrink.'
      },
      {
        key: 'storage_type',
        label: 'Storage type',
        kind: 'enum',
        default: 'gp3',
        options: ['gp3', 'gp2', 'io1'].map((v) => ({ value: v, label: v }))
      },
      { key: 'multi_az', label: 'Multi-AZ', kind: 'boolean', default: false },
      { key: 'db_name', label: 'Initial database', kind: 'string', createOnly: true },
      {
        key: 'master_username',
        label: 'Master user',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true
      },
      { key: 'master_password', label: 'Master password', kind: 'secret', required: true },
      {
        key: 'subnet_group',
        label: 'Subnet group',
        kind: 'ref',
        refType: 'aws.rds_subnet_group',
        required: true,
        replaceOnChange: true
      },
      {
        key: 'parameter_group',
        label: 'Parameter group',
        kind: 'ref',
        refType: 'aws.rds_parameter_group'
      },
      refList('security_groups', 'Security groups', 'aws.security_group'),
      {
        key: 'backup_retention_days',
        label: 'Backup retention (days)',
        kind: 'number',
        default: 7,
        min: 0,
        max: 35
      },
      { key: 'publicly_accessible', label: 'Publicly accessible', kind: 'boolean', default: false },
      { key: 'deletion_protection', label: 'Deletion protection', kind: 'boolean', default: true },
      {
        key: 'storage_encrypted',
        label: 'Encrypted',
        kind: 'boolean',
        default: true,
        createOnly: true,
        replaceOnChange: true
      },
      { key: 'endpoint', label: 'Endpoint', kind: 'string', readOnly: true },
      { key: 'port', label: 'Port', kind: 'number', readOnly: true }
    ],
    capabilities: cap({ snapshot: true }),
    reversible: (f) => f === 'backup_retention_days' || f === 'deletion_protection',
    refs: [
      { field: 'subnet_group', type: 'aws.rds_subnet_group' },
      { field: 'parameter_group', type: 'aws.rds_parameter_group', required: false },
      { field: 'security_groups', type: 'aws.security_group', required: false }
    ],
    risk: riskOf((op, d) => {
      const out: Array<'cost' | 'public_exposure' | 'data_loss' | 'downtime'> = []
      if (op.kind === 'create' || op.kind === 'replace') out.push('cost')
      if (op.kind === 'delete' || op.kind === 'replace') out.push('data_loss')
      const pa = op.changes.find((x) => x.field === 'publicly_accessible')
      if (
        ((op.kind === 'create' || op.kind === 'replace') &&
          d?.fields.publicly_accessible === true) ||
        pa?.to === true
      )
        out.push('public_exposure')
      if (
        op.kind === 'update' &&
        op.changes.some((x) => x.field === 'instance_class' || x.field === 'engine_version')
      )
        out.push('downtime', 'cost')
      if (op.kind === 'update' && op.changes.some((x) => x.field === 'multi_az' && x.to === true))
        out.push('cost')
      return out
    }),
    costClass: () => 'monthly'
  },
  probe: {
    need: 'rds:DescribeDBInstances',
    run: (ctx, region) =>
      awsQuery(ctx, 'rds', 'DescribeDBInstances', { MaxRecords: 20 }, { region })
  },
  checkPlan(desired, obs) {
    const want = Number(desired.fields.allocated_storage_gb)
    const have = Number(obs?.fields.allocated_storage_gb)
    if (obs && Number.isFinite(want) && Number.isFinite(have) && want < have)
      throw new ProviderError(
        'STORAGE_SHRINK_REFUSED',
        `Database storage cannot shrink (${have} GiB to ${want} GiB).`
      )
  },
  observe: (ctx, id, region) => describeInstance(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await awsQuery(
      ctx,
      'rds',
      'DescribeDBInstances',
      { MaxRecords: 50, Marker: token ?? undefined },
      { region }
    )
    const out: Observed[] = []
    for (const v of list(r.DBInstances, 'DBInstance')) {
      const o = await instanceFromNode(ctx, v, region)
      if (o) out.push(o)
    }
    return { items: out, next: t(r.Marker) || null }
  },
  findExisting: (ctx, desired, region) =>
    describeInstance(ctx, String(desired.fields.name), region),
  opData: (ctx, desired, obs, kind) =>
    kind === 'delete' || kind === 'replace'
      ? {
          finalSnapshot: `nivaro-final-${obs?.externalId ?? desired?.fields.name}-${stamp(ctx.now())}`
        }
      : {},
  async create(ctx, desired, region) {
    const f = desired.fields
    const password = secretPlain(desired, 'master_password')
    if (!password)
      throw new ProviderError(
        'SECRET_MISSING',
        'The master password is required to create the database.'
      )
    const id = String(f.name)
    await awsQuery(
      ctx,
      'rds',
      'CreateDBInstance',
      {
        DBInstanceIdentifier: id,
        Engine: f.engine,
        EngineVersion: f.engine_version || undefined,
        DBInstanceClass: f.instance_class,
        AllocatedStorage: f.allocated_storage_gb,
        StorageType: f.storage_type ?? 'gp3',
        MultiAZ: f.multi_az ?? false,
        DBName: f.db_name || undefined,
        MasterUsername: f.master_username,
        MasterUserPassword: password,
        DBSubnetGroupName: idOf(desired.refs.subnet_group, 'The subnet group'),
        DBParameterGroupName:
          typeof desired.refs.parameter_group === 'string'
            ? desired.refs.parameter_group
            : undefined,
        VpcSecurityGroupIds: ids(desired.refs.security_groups).length
          ? ids(desired.refs.security_groups)
          : undefined,
        BackupRetentionPeriod: f.backup_retention_days ?? 7,
        PubliclyAccessible: f.publicly_accessible ?? false,
        DeletionProtection: f.deletion_protection ?? true,
        StorageEncrypted: f.storage_encrypted ?? true,
        Tags: keyValueTags(rdsTags(desired))
      },
      { region }
    )
    return id
  },
  async update(ctx, id, region, desired, obs, changed) {
    const params: Record<string, unknown> = { DBInstanceIdentifier: id, ApplyImmediately: true }
    for (const [field, param] of MODIFIABLE)
      if (changed.has(field)) params[param] = desired.fields[field]
    if (changed.has('security_groups'))
      params.VpcSecurityGroupIds = ids(desired.refs.security_groups)
    if (changed.has('parameter_group') && typeof desired.refs.parameter_group === 'string')
      params.DBParameterGroupName = desired.refs.parameter_group
    if (changed.has('master_password')) {
      const pw = secretPlain(desired, 'master_password')
      if (pw) params.MasterUserPassword = pw
    }
    if (Object.keys(params).length > 2)
      await awsQuery(ctx, 'rds', 'ModifyDBInstance', params, { region })
    if (obs.url) await putTags(ctx, region, obs.url, rdsTags(desired))
  },
  async snapshot(ctx, id, region) {
    const snap = `nivaro-${id}-${stamp(ctx.now())}`
    await awsQuery(
      ctx,
      'rds',
      'CreateDBSnapshot',
      {
        DBInstanceIdentifier: id,
        DBSnapshotIdentifier: snap,
        Tags: keyValueTags({ 'nivaro-hub:managed': 'true' })
      },
      { region }
    )
    return {
      kind: 'rds_snapshot',
      id: snap,
      label: `Snapshot of ${id}`,
      createdAt: ctx.now().toISOString()
    }
  },
  async remove(ctx, id, region, op) {
    const final = String(op.data?.finalSnapshot ?? `nivaro-final-${id}-${stamp(ctx.now())}`)
    await awsQuery(
      ctx,
      'rds',
      'DeleteDBInstance',
      {
        DBInstanceIdentifier: id,
        SkipFinalSnapshot: false,
        FinalDBSnapshotIdentifier: final,
        DeleteAutomatedBackups: false
      },
      { region }
    )
    // A replace creates the same identifier again: wait until the old one is gone.
    if (op.kind === 'replace')
      await waitFor(ctx, async () => ((await describeInstance(ctx, id, region)) ? null : true), {
        tries: 60,
        delayMs: 10_000
      })
  }
}

// ── Subnet group ──

async function subnetGroupFromNode(
  ctx: ProviderContext,
  v: XmlValue,
  region: string
): Promise<Observed | null> {
  const name = t(c(v, 'DBSubnetGroupName'))
  if (!name) return null
  const arn = t(c(v, 'DBSubnetGroupArn'))
  const o = observed(
    'aws.rds_subnet_group',
    name,
    region,
    name,
    {
      description: t(c(v, 'DBSubnetGroupDescription')),
      subnets: list(c(v, 'Subnets'), 'Subnet').map((s) => t(c(s, 'SubnetIdentifier'))),
      vpc: t(c(v, 'VpcId'))
    },
    await tagsFor(ctx, region, arn),
    t(c(v, 'SubnetGroupStatus')) || 'available'
  )
  o.url = arn || null
  return o
}

async function describeSubnetGroup(ctx: ProviderContext, name: string, region: string) {
  const r = await orNull(() =>
    awsQuery(ctx, 'rds', 'DescribeDBSubnetGroups', { DBSubnetGroupName: name }, { region })
  )
  const v = r && list(r.DBSubnetGroups, 'DBSubnetGroup')[0]
  return v ? subnetGroupFromNode(ctx, v, region) : null
}

export const rdsSubnetGroupDef: AwsTypeDef = {
  spec: {
    key: 'aws.rds_subnet_group',
    label: 'RDS subnet group',
    scope: 'app',
    fields: [
      regionField,
      { ...nameField, createOnly: true, replaceOnChange: true },
      {
        key: 'description',
        label: 'Description',
        kind: 'string',
        default: 'Managed by Nivaro Hub'
      },
      { ...refList('subnets', 'Subnets', 'aws.subnet'), required: true },
      { key: 'vpc', label: 'VPC', kind: 'string', readOnly: true }
    ],
    capabilities: cap(),
    reversible: true,
    refs: [{ field: 'subnets', type: 'aws.subnet' }],
    risk: riskOf()
  },
  probe: {
    need: 'rds:DescribeDBSubnetGroups',
    run: (ctx, region) =>
      awsQuery(ctx, 'rds', 'DescribeDBSubnetGroups', { MaxRecords: 20 }, { region })
  },
  observe: (ctx, id, region) => describeSubnetGroup(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await awsQuery(
      ctx,
      'rds',
      'DescribeDBSubnetGroups',
      { MaxRecords: 50, Marker: token ?? undefined },
      { region }
    )
    const out: Observed[] = []
    for (const v of list(r.DBSubnetGroups, 'DBSubnetGroup')) {
      const o = await subnetGroupFromNode(ctx, v, region)
      if (o) out.push(o)
    }
    return { items: out, next: t(r.Marker) || null }
  },
  findExisting: (ctx, desired, region) =>
    describeSubnetGroup(ctx, String(desired.fields.name), region),
  async create(ctx, desired, region) {
    const name = String(desired.fields.name)
    await awsQuery(
      ctx,
      'rds',
      'CreateDBSubnetGroup',
      {
        DBSubnetGroupName: name,
        DBSubnetGroupDescription: desired.fields.description || 'Managed by Nivaro Hub',
        SubnetIds: ids(desired.refs.subnets),
        Tags: keyValueTags(rdsTags(desired))
      },
      { region }
    )
    return name
  },
  async update(ctx, id, region, desired) {
    await awsQuery(
      ctx,
      'rds',
      'ModifyDBSubnetGroup',
      {
        DBSubnetGroupName: id,
        DBSubnetGroupDescription: desired.fields.description || 'Managed by Nivaro Hub',
        SubnetIds: ids(desired.refs.subnets)
      },
      { region }
    )
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'rds', 'DeleteDBSubnetGroup', { DBSubnetGroupName: id }, { region })
  }
}

// ── Parameter group ──

interface Param {
  name: string
  value: string
  apply_method: string
}

async function groupParams(ctx: ProviderContext, name: string, region: string): Promise<Param[]> {
  const out: Param[] = []
  let marker: string | undefined
  for (let i = 0; i < 20; i++) {
    const r = await awsQuery(
      ctx,
      'rds',
      'DescribeDBParameters',
      { DBParameterGroupName: name, Source: 'user', MaxRecords: 100, Marker: marker },
      { region }
    )
    for (const p of list(r.Parameters, 'Parameter'))
      if (t(c(p, 'ParameterValue')) !== '' || t(c(p, 'ParameterName')))
        out.push({
          name: t(c(p, 'ParameterName')),
          value: t(c(p, 'ParameterValue')),
          apply_method: t(c(p, 'ApplyMethod')) || 'pending-reboot'
        })
    marker = t(r.Marker) || undefined
    if (!marker) break
  }
  return out
}

async function paramGroupFromNode(
  ctx: ProviderContext,
  v: XmlValue,
  region: string
): Promise<Observed | null> {
  const name = t(c(v, 'DBParameterGroupName'))
  if (!name) return null
  const arn = t(c(v, 'DBParameterGroupArn'))
  const o = observed(
    'aws.rds_parameter_group',
    name,
    region,
    name,
    {
      family: t(c(v, 'DBParameterGroupFamily')),
      description: t(c(v, 'Description')),
      parameters: await groupParams(ctx, name, region)
    },
    await tagsFor(ctx, region, arn),
    'available'
  )
  o.url = arn || null
  return o
}

async function describeParamGroup(ctx: ProviderContext, name: string, region: string) {
  const r = await orNull(() =>
    awsQuery(ctx, 'rds', 'DescribeDBParameterGroups', { DBParameterGroupName: name }, { region })
  )
  const v = r && list(r.DBParameterGroups, 'DBParameterGroup')[0]
  return v ? paramGroupFromNode(ctx, v, region) : null
}

async function syncParams(
  ctx: ProviderContext,
  region: string,
  name: string,
  want: Param[] | undefined,
  have: Param[]
) {
  if (!want) return
  const haveBy = new Map(have.map((p) => [p.name, p]))
  const wantNames = new Set(want.map((p) => p.name))
  const toSet = want.filter((p) => {
    const h = haveBy.get(p.name)
    return !h || h.value !== String(p.value)
  })
  for (let i = 0; i < toSet.length; i += 20)
    await awsQuery(
      ctx,
      'rds',
      'ModifyDBParameterGroup',
      {
        DBParameterGroupName: name,
        Parameters: toSet.slice(i, i + 20).map((p) => ({
          ParameterName: p.name,
          ParameterValue: String(p.value),
          ApplyMethod: p.apply_method ?? 'pending-reboot'
        }))
      },
      { region }
    )
  const toReset = have.filter((p) => !wantNames.has(p.name))
  for (let i = 0; i < toReset.length; i += 20)
    await awsQuery(
      ctx,
      'rds',
      'ResetDBParameterGroup',
      {
        DBParameterGroupName: name,
        Parameters: toReset
          .slice(i, i + 20)
          .map((p) => ({ ParameterName: p.name, ApplyMethod: p.apply_method }))
      },
      { region }
    )
}

export const rdsParameterGroupDef: AwsTypeDef = {
  spec: {
    key: 'aws.rds_parameter_group',
    label: 'RDS parameter group',
    scope: 'app',
    fields: [
      regionField,
      { ...nameField, createOnly: true, replaceOnChange: true },
      {
        key: 'family',
        label: 'Family',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        help: 'e.g. postgres16, mysql8.0'
      },
      {
        key: 'description',
        label: 'Description',
        kind: 'string',
        createOnly: true,
        default: 'Managed by Nivaro Hub'
      },
      {
        key: 'parameters',
        label: 'Parameters',
        kind: 'list',
        items: {
          key: 'parameter',
          label: 'Parameter',
          kind: 'object',
          fields: [
            { key: 'name', label: 'Name', kind: 'string', required: true },
            { key: 'value', label: 'Value', kind: 'string', required: true },
            {
              key: 'apply_method',
              label: 'Apply',
              kind: 'enum',
              options: [
                { value: 'immediate', label: 'Immediately' },
                { value: 'pending-reboot', label: 'At next reboot' }
              ]
            }
          ]
        }
      }
    ],
    capabilities: cap(),
    reversible: true,
    refs: [],
    risk: riskOf((op) =>
      op.kind === 'update' && op.changes.some((x) => x.field === 'parameters') ? ['downtime'] : []
    )
  },
  probe: {
    need: 'rds:DescribeDBParameterGroups',
    run: (ctx, region) =>
      awsQuery(ctx, 'rds', 'DescribeDBParameterGroups', { MaxRecords: 20 }, { region })
  },
  // A parameter the Hub sets is compared by name + value; the apply method is only sent on write.
  normalize: (f) => ({
    ...f,
    parameters: Array.isArray(f.parameters)
      ? (f.parameters as Param[]).map((p) => ({
          name: p.name,
          value: String(p.value),
          apply_method: p.apply_method ?? 'pending-reboot'
        }))
      : f.parameters
  }),
  observe: (ctx, id, region) => describeParamGroup(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await awsQuery(
      ctx,
      'rds',
      'DescribeDBParameterGroups',
      { MaxRecords: 50, Marker: token ?? undefined },
      { region }
    )
    const out: Observed[] = []
    for (const v of list(r.DBParameterGroups, 'DBParameterGroup')) {
      const o = await paramGroupFromNode(ctx, v, region)
      if (o) out.push(o)
    }
    return { items: out, next: t(r.Marker) || null }
  },
  findExisting: (ctx, desired, region) =>
    describeParamGroup(ctx, String(desired.fields.name), region),
  async create(ctx, desired, region) {
    const name = String(desired.fields.name)
    await awsQuery(
      ctx,
      'rds',
      'CreateDBParameterGroup',
      {
        DBParameterGroupName: name,
        DBParameterGroupFamily: desired.fields.family,
        Description: desired.fields.description || 'Managed by Nivaro Hub',
        Tags: keyValueTags(rdsTags(desired))
      },
      { region }
    )
    await syncParams(ctx, region, name, desired.fields.parameters as Param[] | undefined, [])
    return name
  },
  async update(ctx, id, region, desired, obs) {
    await syncParams(
      ctx,
      region,
      id,
      desired.fields.parameters as Param[] | undefined,
      (obs.fields.parameters as Param[]) ?? []
    )
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'rds', 'DeleteDBParameterGroup', { DBParameterGroupName: id }, { region })
  }
}

export const rdsDefs: AwsTypeDef[] = [rdsInstanceDef, rdsSubnetGroupDef, rdsParameterGroupDef]
