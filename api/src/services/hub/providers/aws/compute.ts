import {
  type FieldSpec,
  type Observed,
  type PlannedOp,
  type ProviderContext,
  ProviderError
} from '../types.js'
import { awsQuery, ec2TagSpec, hubTags, waitFor } from './client.js'
import {
  child,
  ec2Probe,
  findByResourceTag,
  flag,
  int,
  items,
  putTags,
  tagsOf,
  text
} from './ec2.js'
import {
  type AwsListPage,
  type AwsTypeDef,
  cap,
  ec2Page,
  nameField,
  observed,
  regionField,
  riskOf
} from './kit.js'
import type { XmlValue } from './xml.js'

/** aws.ec2_instance and aws.ebs_volume. */

const refList = (key: string, label: string, refType: string): FieldSpec => ({
  key,
  label,
  kind: 'list',
  items: { key: 'item', label, kind: 'ref', refType }
})

const must = (v: string | string[] | null | undefined, what: string): string => {
  if (typeof v !== 'string' || !v)
    throw new ProviderError('REF_UNRESOLVED', `${what} is not created yet.`)
  return v
}

// ── EC2 instance ──

const CHEAP_FAMILIES = new Set(['t2', 't3', 't3a', 't4g'])
const CHEAP_SIZES = new Set(['nano', 'micro', 'small'])

/** `none` up to a t3.small-class burstable instance; `monthly` for everything above it. */
export function instanceCost(type: unknown): 'none' | 'monthly' {
  const [family, size] = String(type ?? '').split('.')
  return CHEAP_FAMILIES.has(family) && CHEAP_SIZES.has(size) ? 'none' : 'monthly'
}

function instanceMap(i: XmlValue, region: string): Observed | null {
  const id = text(child(i, 'instanceId'))
  const state = text(child(child(i, 'instanceState'), 'name'))
  if (!id || state === 'terminated') return null
  const tags = tagsOf(child(i, 'tagSet'))
  return observed(
    'aws.ec2_instance',
    id,
    region,
    tags.Name ?? null,
    {
      instance_type: text(child(i, 'instanceType')),
      image_id: text(child(i, 'imageId')),
      subnet: text(child(i, 'subnetId')),
      security_groups: items(child(i, 'groupSet')).map((g) => text(child(g, 'groupId'))),
      key_name: text(child(i, 'keyName')) || undefined,
      private_ip: text(child(i, 'privateIpAddress')) || undefined,
      public_ip: text(child(i, 'ipAddress')) || undefined
    },
    tags,
    state
  )
}

function reservationInstances(set: XmlValue | undefined): XmlValue[] {
  return items(set).flatMap((r) => items(child(r, 'instancesSet')))
}

async function describeInstance(ctx: ProviderContext, id: string, region: string) {
  const r = await awsQuery(ctx, 'ec2', 'DescribeInstances', { InstanceId: [id] }, { region }).catch(
    (e) => {
      if (e instanceof ProviderError && /InvalidInstanceID/.test(e.code)) return null
      throw e
    }
  )
  const i = r && reservationInstances(r.reservationSet)[0]
  return i ? instanceMap(i, region) : null
}

async function instanceState(ctx: ProviderContext, id: string, region: string, want: string) {
  return waitFor(ctx, async () => {
    const o = await describeInstance(ctx, id, region)
    if (!o) throw new ProviderError('NOT_FOUND', `Instance ${id} is gone.`)
    return o.status === want ? o : null
  })
}

export const ec2InstanceDef: AwsTypeDef = {
  spec: {
    key: 'aws.ec2_instance',
    label: 'EC2 instance',
    scope: 'app',
    fields: [
      regionField,
      nameField,
      {
        key: 'instance_type',
        label: 'Instance type',
        kind: 'string',
        required: true,
        pattern: '^[a-z][a-z0-9-]*\\d[a-z0-9-]*\\.[a-z0-9]+$',
        help: 'A change stops and restarts the instance. Above t3.small it bills monthly (admin approval for owners).'
      },
      {
        key: 'image_id',
        label: 'Image (AMI)',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^ami-[0-9a-f]+$'
      },
      {
        key: 'subnet',
        label: 'Subnet',
        kind: 'ref',
        refType: 'aws.subnet',
        required: true,
        replaceOnChange: true
      },
      refList('security_groups', 'Security groups', 'aws.security_group'),
      {
        key: 'key_name',
        label: 'Key pair',
        kind: 'string',
        createOnly: true,
        replaceOnChange: true
      },
      {
        key: 'user_data',
        label: 'User data',
        kind: 'string',
        createOnly: true,
        help: 'Read at first boot; never read back.'
      },
      { key: 'private_ip', label: 'Private address', kind: 'string', readOnly: true },
      { key: 'public_ip', label: 'Public address', kind: 'string', readOnly: true }
    ],
    capabilities: cap(),
    reversible: (f) => f === 'instance_type' || f === 'security_groups' || f === 'name',
    refs: [
      { field: 'subnet', type: 'aws.subnet' },
      { field: 'security_groups', type: 'aws.security_group', required: false }
    ],
    risk: riskOf((op, d) => {
      const out: Array<'cost' | 'downtime' | 'data_loss'> = []
      const type = op.changes.find((c) => c.field === 'instance_type')
      if (op.kind === 'create' || op.kind === 'replace') {
        if (instanceCost(d?.fields.instance_type) === 'monthly') out.push('cost')
      } else if (op.kind === 'update' && type) {
        out.push('downtime')
        if (instanceCost(type.to) === 'monthly' && instanceCost(type.from) === 'none')
          out.push('cost')
      }
      if (op.kind === 'delete' || op.kind === 'replace') out.push('data_loss')
      return out
    }),
    costClass: (d) => instanceCost(d.fields.instance_type)
  },
  probe: ec2Probe('DescribeInstances'),
  normalize: (f) => {
    const { user_data: _omit, ...rest } = f
    return rest
  },
  observe: (ctx, id, region) => describeInstance(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await awsQuery(
      ctx,
      'ec2',
      'DescribeInstances',
      { MaxResults: 100, NextToken: token ?? undefined },
      { region }
    )
    const out: Observed[] = []
    for (const i of reservationInstances(r.reservationSet)) {
      const o = instanceMap(i, region)
      if (o) out.push(o)
    }
    return { items: out, next: ec2Page(text(r.nextToken)) }
  },
  async findExisting(ctx, desired, region) {
    const rid = desired.tags['nivaro-hub:resource']
    if (!rid) return null
    const r = await awsQuery(
      ctx,
      'ec2',
      'DescribeInstances',
      { Filter: [{ Name: 'tag:nivaro-hub:resource', Value: [rid] }] },
      { region }
    )
    for (const i of reservationInstances(r.reservationSet)) {
      const o = instanceMap(i, region)
      if (o && o.status !== 'shutting-down') return o
    }
    return null
  },
  opData: (ctx, desired, _o, kind) =>
    kind === 'create' || kind === 'replace'
      ? { clientToken: `nivaro-i-${desired?.resourceId ?? 'x'}-${ctx.now().getTime()}` }
      : {},
  async create(ctx, desired, region, op) {
    const tags = hubTags(desired.tags, desired.fields.name)
    const sgs = Array.isArray(desired.refs.security_groups) ? desired.refs.security_groups : []
    const userData = typeof desired.fields.user_data === 'string' && desired.fields.user_data
    const r = await awsQuery(
      ctx,
      'ec2',
      'RunInstances',
      {
        ImageId: desired.fields.image_id,
        InstanceType: desired.fields.instance_type,
        MinCount: 1,
        MaxCount: 1,
        SubnetId: must(desired.refs.subnet, 'The subnet'),
        SecurityGroupId: sgs.length ? sgs : undefined,
        KeyName: desired.fields.key_name || undefined,
        UserData: userData ? Buffer.from(userData).toString('base64') : undefined,
        ClientToken: String(op.data?.clientToken ?? '').slice(0, 64) || undefined,
        TagSpecification: [...ec2TagSpec('instance', tags), ...ec2TagSpec('volume', tags)]
      },
      { region }
    )
    const id = text(child(items(r.instancesSet)[0], 'instanceId'))
    if (!id)
      throw new ProviderError('AWS_BAD_ANSWER', 'RunInstances answered no id.', { retryable: true })
    await instanceState(ctx, id, region, 'running')
    return id
  },
  async update(ctx, id, region, desired, obs, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
    if (changed.has('security_groups')) {
      const sgs = Array.isArray(desired.refs.security_groups) ? desired.refs.security_groups : []
      await awsQuery(
        ctx,
        'ec2',
        'ModifyInstanceAttribute',
        { InstanceId: id, GroupId: sgs },
        { region }
      )
    }
    if (changed.has('instance_type') && desired.fields.instance_type !== obs.fields.instance_type) {
      const wasRunning = obs.status === 'running'
      if (obs.status !== 'stopped') {
        await awsQuery(ctx, 'ec2', 'StopInstances', { InstanceId: [id] }, { region })
        if (!(await instanceState(ctx, id, region, 'stopped')))
          throw new ProviderError('TIMEOUT', 'The instance did not stop in time.', {
            retryable: true
          })
      }
      await awsQuery(
        ctx,
        'ec2',
        'ModifyInstanceAttribute',
        { InstanceId: id, InstanceType: { Value: desired.fields.instance_type } },
        { region }
      )
      if (wasRunning) await awsQuery(ctx, 'ec2', 'StartInstances', { InstanceId: [id] }, { region })
    }
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'ec2', 'TerminateInstances', { InstanceId: [id] }, { region })
  }
}

// ── EBS volume ──

export function volumeCost(f: Record<string, unknown>): 'none' | 'monthly' {
  const type = String(f.volume_type ?? 'gp3')
  if (type === 'io1' || type === 'io2') return 'monthly'
  if (type === 'gp3' && (Number(f.iops ?? 0) > 3000 || Number(f.throughput ?? 0) > 125))
    return 'monthly'
  return 'none'
}

function volumeMap(v: XmlValue, region: string): Observed | null {
  const id = text(child(v, 'volumeId'))
  if (!id) return null
  const tags = tagsOf(child(v, 'tagSet'))
  const att = items(child(v, 'attachmentSet'))[0]
  return observed(
    'aws.ebs_volume',
    id,
    region,
    tags.Name ?? null,
    {
      availability_zone: text(child(v, 'availabilityZone')),
      size_gb: int(child(v, 'size')),
      volume_type: text(child(v, 'volumeType')),
      iops: int(child(v, 'iops')),
      throughput: int(child(v, 'throughput')),
      encrypted: flag(child(v, 'encrypted')),
      instance: text(child(att, 'instanceId')) || undefined,
      device: text(child(att, 'device')) || undefined
    },
    tags,
    text(child(v, 'status'))
  )
}

async function describeVolume(ctx: ProviderContext, id: string, region: string) {
  const r = await awsQuery(ctx, 'ec2', 'DescribeVolumes', { VolumeId: [id] }, { region }).catch(
    (e) => {
      if (e instanceof ProviderError && /InvalidVolume/.test(e.code)) return null
      throw e
    }
  )
  const v = r && items(r.volumeSet)[0]
  return v ? volumeMap(v, region) : null
}

const volumeAvailable = (ctx: ProviderContext, id: string, region: string) =>
  waitFor(ctx, async () => {
    const o = await describeVolume(ctx, id, region)
    if (!o) throw new ProviderError('NOT_FOUND', `Volume ${id} is gone.`)
    return o.status === 'available' ? o : null
  })

export const ebsVolumeDef: AwsTypeDef = {
  spec: {
    key: 'aws.ebs_volume',
    label: 'EBS volume',
    scope: 'app',
    fields: [
      regionField,
      nameField,
      {
        key: 'availability_zone',
        label: 'Availability zone',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true
      },
      {
        key: 'size_gb',
        label: 'Size (GiB)',
        kind: 'number',
        required: true,
        min: 1,
        help: 'Can grow, never shrink.'
      },
      {
        key: 'volume_type',
        label: 'Type',
        kind: 'enum',
        default: 'gp3',
        options: ['gp3', 'gp2', 'io1', 'io2', 'st1', 'sc1'].map((v) => ({ value: v, label: v }))
      },
      { key: 'iops', label: 'Provisioned IOPS', kind: 'number', min: 100 },
      { key: 'throughput', label: 'Throughput (MiB/s)', kind: 'number', min: 125 },
      {
        key: 'encrypted',
        label: 'Encrypted',
        kind: 'boolean',
        default: true,
        createOnly: true,
        replaceOnChange: true
      },
      { key: 'instance', label: 'Attached instance', kind: 'ref', refType: 'aws.ec2_instance' },
      {
        key: 'device',
        label: 'Device name',
        kind: 'string',
        default: '/dev/sdf',
        pattern: '^/dev/[a-z0-9]+$'
      }
    ],
    capabilities: cap({ snapshot: true }),
    reversible: (f) => f === 'name' || f === 'instance',
    refs: [{ field: 'instance', type: 'aws.ec2_instance', required: false }],
    risk: riskOf((op, d) => {
      const out: Array<'cost' | 'data_loss' | 'downtime'> = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('data_loss')
      if (
        (op.kind === 'create' || op.kind === 'replace') &&
        volumeCost(d?.fields ?? {}) === 'monthly'
      )
        out.push('cost')
      if (
        op.kind === 'update' &&
        d &&
        volumeCost(d.fields) === 'monthly' &&
        op.changes.some((c) => ['iops', 'throughput', 'volume_type'].includes(c.field))
      )
        out.push('cost')
      if (op.kind === 'update' && op.changes.some((c) => c.field === 'instance'))
        out.push('downtime')
      return out
    }),
    costClass: (d) => volumeCost(d.fields)
  },
  probe: ec2Probe('DescribeVolumes'),
  checkPlan(desired, obs) {
    const want = Number(desired.fields.size_gb)
    const have = Number(obs?.fields.size_gb)
    if (obs && Number.isFinite(want) && Number.isFinite(have) && want < have)
      throw new ProviderError(
        'VOLUME_SHRINK_REFUSED',
        `A volume cannot shrink (${have} GiB to ${want} GiB). Create a smaller volume and copy the data instead.`
      )
  },
  observe: (ctx, id, region) => describeVolume(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await awsQuery(
      ctx,
      'ec2',
      'DescribeVolumes',
      { MaxResults: 100, NextToken: token ?? undefined },
      { region }
    )
    const out: Observed[] = []
    for (const v of items(r.volumeSet)) {
      const o = volumeMap(v, region)
      if (o) out.push(o)
    }
    return { items: out, next: ec2Page(text(r.nextToken)) }
  },
  findExisting: findByResourceTag('DescribeVolumes', 'volumeSet', volumeMap),
  opData: (ctx, desired, _o, kind) =>
    kind === 'create' || kind === 'replace'
      ? { clientToken: `nivaro-v-${desired?.resourceId ?? 'x'}-${ctx.now().getTime()}` }
      : {},
  async create(ctx, desired, region, op) {
    const f = desired.fields
    const r = await awsQuery(
      ctx,
      'ec2',
      'CreateVolume',
      {
        AvailabilityZone: f.availability_zone,
        Size: f.size_gb,
        VolumeType: f.volume_type ?? 'gp3',
        Iops: f.iops || undefined,
        Throughput: f.throughput || undefined,
        Encrypted: f.encrypted ?? true,
        ClientToken: String(op.data?.clientToken ?? '').slice(0, 64) || undefined,
        TagSpecification: ec2TagSpec('volume', hubTags(desired.tags, f.name))
      },
      { region }
    )
    const id = text(child(r, 'volumeId'))
    if (!id)
      throw new ProviderError('AWS_BAD_ANSWER', 'CreateVolume answered no id.', { retryable: true })
    const inst = desired.refs.instance
    if (typeof inst === 'string' && inst) {
      await volumeAvailable(ctx, id, region)
      await awsQuery(
        ctx,
        'ec2',
        'AttachVolume',
        { VolumeId: id, InstanceId: inst, Device: f.device ?? '/dev/sdf' },
        { region }
      )
    }
    return id
  },
  async update(ctx, id, region, desired, obs, changed) {
    const f = desired.fields
    if (changed.has('name')) await putTags(ctx, region, id, hubTags(desired.tags, f.name))
    if (['size_gb', 'volume_type', 'iops', 'throughput'].some((k) => changed.has(k)))
      await awsQuery(
        ctx,
        'ec2',
        'ModifyVolume',
        {
          VolumeId: id,
          Size: changed.has('size_gb') ? f.size_gb : undefined,
          VolumeType: changed.has('volume_type') ? f.volume_type : undefined,
          Iops: changed.has('iops') ? f.iops : undefined,
          Throughput: changed.has('throughput') ? f.throughput : undefined
        },
        { region }
      )
    if (changed.has('instance')) {
      const want = typeof desired.refs.instance === 'string' ? desired.refs.instance : ''
      if (obs.fields.instance && obs.fields.instance !== want) {
        await awsQuery(ctx, 'ec2', 'DetachVolume', { VolumeId: id }, { region })
        await volumeAvailable(ctx, id, region)
      }
      if (want && obs.fields.instance !== want)
        await awsQuery(
          ctx,
          'ec2',
          'AttachVolume',
          { VolumeId: id, InstanceId: want, Device: f.device ?? '/dev/sdf' },
          { region }
        )
    }
  },
  async snapshot(ctx, id, region) {
    const r = await awsQuery(
      ctx,
      'ec2',
      'CreateSnapshot',
      {
        VolumeId: id,
        Description: `Nivaro Hub snapshot before change of ${id}`,
        TagSpecification: ec2TagSpec('snapshot', {
          'nivaro-hub:managed': 'true',
          'nivaro-hub:source': id
        })
      },
      { region }
    )
    const snap = text(child(r, 'snapshotId'))
    if (!snap)
      throw new ProviderError('AWS_BAD_ANSWER', 'CreateSnapshot answered no id.', {
        retryable: true
      })
    return {
      kind: 'ebs_snapshot',
      id: snap,
      label: `Snapshot of ${id}`,
      createdAt: ctx.now().toISOString()
    }
  },
  async remove(ctx, id, region) {
    const have = await describeVolume(ctx, id, region)
    if (have?.fields.instance) {
      await awsQuery(ctx, 'ec2', 'DetachVolume', { VolumeId: id }, { region })
      await volumeAvailable(ctx, id, region)
    }
    await awsQuery(ctx, 'ec2', 'DeleteVolume', { VolumeId: id }, { region })
  }
}

export const computeDefs: AwsTypeDef[] = [ec2InstanceDef, ebsVolumeDef]
export type { PlannedOp }
