import { fieldWords, typedName } from '../plan-words.js'
import {
  type DesiredResource,
  type FieldChange,
  type Observed,
  type PlannedOp,
  ProviderError,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import { isSecret, norm, PROJECT_FIELDS, sameValue } from './resources.js'
import { specOf, T } from './specs.js'

/**
 * The pure diff for every GitLab type (no calls). One config row per type says which fields
 * change in place, which force a replace (a new token, a new variable), which hold a secret and
 * whether the type offers the once-only rotate op.
 */

interface Cfg {
  /** Fields that change in place. */
  diff: string[]
  /** Fields that force a replace (delete + create). */
  replace: string[]
  /** Ref fields compared with the observed scope (`project`, `group`). */
  refs: string[]
  /** The write-only secret field (a variable's value, a webhook's token). */
  secret?: string
  /** Fields compared only when the desired value is set (GitLab picks the default). */
  ignoreEmpty?: string[]
  same?: Record<string, (a: unknown, b: unknown) => boolean>
  /** Fields set at create (listed in the plan). */
  create: string[]
  /** Offers the rotate op through ROTATE_OUTPUTS_FIELD. */
  rotate?: boolean
}

const dateKey = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10)
}
const refName = (v: unknown): string | null =>
  typeof v === 'string' && v ? v.replace(/^refs\/(heads|tags)\//, '') : null
const keyText = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const p = v.trim().split(/\s+/)
  return p.length >= 2 ? `${p[0]} ${p[1]}` : (p[0] ?? null)
}

const CFGS: Record<string, Cfg> = {
  [T.project]: {
    diff: [...PROJECT_FIELDS, 'archived'],
    replace: [],
    refs: [],
    create: [
      'name',
      'path',
      'description',
      'visibility',
      'defaultBranch',
      'templateName',
      'templateProject'
    ]
  },
  [T.protectedBranch]: {
    diff: ['pushAccess', 'mergeAccess', 'allowForcePush', 'codeOwnerApprovalRequired'],
    replace: ['name'],
    refs: ['project'],
    create: ['name', 'pushAccess', 'mergeAccess', 'allowForcePush', 'codeOwnerApprovalRequired']
  },
  [T.environment]: {
    diff: ['externalUrl', 'tier'],
    replace: ['name'],
    refs: ['project'],
    create: ['name', 'externalUrl', 'tier']
  },
  [T.protectedEnvironment]: {
    diff: ['deployAccess', 'approverRole', 'requiredApprovals'],
    replace: ['environment'],
    refs: ['project'],
    create: ['environment', 'deployAccess', 'approverRole', 'requiredApprovals']
  },
  [T.ciVariable]: {
    diff: ['variableType', 'masked', 'protected', 'raw'],
    replace: ['key', 'environmentScope'],
    refs: [],
    secret: 'value',
    create: ['key', 'variableType', 'masked', 'protected', 'raw', 'environmentScope']
  },
  [T.deployToken]: {
    diff: [],
    replace: ['name', 'scopes', 'expiresAt', 'username'],
    refs: [],
    ignoreEmpty: ['username'],
    same: { expiresAt: (a, b) => dateKey(a) === dateKey(b) },
    create: ['name', 'scopes', 'expiresAt', 'username'],
    rotate: true
  },
  [T.deployKey]: {
    diff: ['title', 'canPush'],
    replace: ['key'],
    refs: ['project'],
    same: { key: (a, b) => keyText(a) === keyText(b) },
    create: ['title', 'key', 'canPush']
  },
  [T.webhook]: {
    diff: ['url', 'events', 'enableSslVerification'],
    replace: [],
    refs: ['project'],
    secret: 'token',
    create: ['url', 'events', 'enableSslVerification']
  },
  [T.pipelineSchedule]: {
    diff: ['description', 'ref', 'cron', 'cronTimezone', 'active'],
    replace: [],
    refs: ['project'],
    same: { ref: (a, b) => refName(a) === refName(b) },
    create: ['description', 'ref', 'cron', 'cronTimezone', 'active']
  },
  [T.runner]: {
    diff: [
      'description',
      'tagList',
      'runUntagged',
      'locked',
      'accessLevel',
      'paused',
      'maximumTimeout'
    ],
    replace: [],
    refs: [],
    create: [
      'description',
      'tagList',
      'runUntagged',
      'locked',
      'accessLevel',
      'paused',
      'maximumTimeout'
    ],
    rotate: true
  }
}

function changesOf(
  cfg: Cfg,
  keys: string[],
  desired: DesiredResource,
  observed: Observed
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    const want = desired.fields[k]
    if (want === undefined) continue
    if (cfg.ignoreEmpty?.includes(k) && norm(want) === null) continue
    // Approvals off: the approver role has no meaning and the provider shows none.
    if (k === 'approverRole' && !(Number(desired.fields.requiredApprovals ?? 0) > 0)) continue
    const same = cfg.same?.[k] ?? sameValue
    if (!same(want, observed.fields[k]))
      out.push({ field: k, from: norm(observed.fields[k]), to: norm(want) })
  }
  return out
}

/** The project or group a variable / deploy token lives in changed. */
function scopeChanged(desired: DesiredResource, observed: Observed): boolean {
  const m = /^(project|group):(\d+):/.exec(observed.externalId)
  if (!m) return false
  const p = desired.refs?.project
  const g = desired.refs?.group
  const hasP = typeof p === 'string' && p !== ''
  const hasG = typeof g === 'string' && g !== ''
  if (hasP === hasG) return false
  return hasP ? !(m[1] === 'project' && m[2] === p) : !(m[1] === 'group' && m[2] === g)
}

function refChanged(cfg: Cfg, desired: DesiredResource, observed: Observed): boolean {
  return cfg.refs.some((f) => {
    const want = desired.refs?.[f]
    const have = observed.fields[f]
    return typeof want === 'string' && want !== '' && have != null && String(have) !== want
  })
}

export function planGitlab(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const type = desired?.type ?? observed?.type
  if (!type) return []
  const spec = specOf(type)
  const cfg = CFGS[type]
  if (!spec || (!cfg && type !== T.group))
    throw new ProviderError('UNKNOWN_TYPE', `GitLab has no ${type}.`)
  const label = spec.label
  const nameOf = (ext?: string | null) =>
    typedName(
      label,
      (spec.nameField ? (observed?.fields[spec.nameField] as string | undefined) : undefined) ??
        observed?.name ??
        (spec.nameField ? (desired?.fields[spec.nameField] as string | undefined) : undefined) ??
        ext ??
        null
    )
  const base = { type, resourceId: desired?.resourceId ?? null }
  const noop = (reason: string): PlannedOp => ({
    ...base,
    kind: 'noop',
    externalId: observed?.externalId ?? null,
    reason,
    changes: [],
    preconditions: {},
    risk: []
  })

  if (type === T.group) {
    if (!observed && desired)
      throw new ProviderError(
        'CAPABILITY_MISSING',
        'Groups are shared: the Hub adopts them, it never creates one.'
      )
    return [noop('Groups are only read; the Hub changes nothing on one.')]
  }
  if (!cfg) return []

  // ── delete ──
  if (!desired) {
    if (!observed) return []
    if (type === T.project) {
      if (observed.fields.archived === true) return [noop(`${nameOf()} is already archived.`)]
      return [
        {
          ...base,
          kind: 'delete',
          externalId: observed.externalId,
          action: 'archive',
          reason: `Archive ${nameOf()} (kept read-only, not deleted).`,
          changes: [{ field: 'archived', from: false, to: true }],
          preconditions: { archived: false, name: observed.fields.name },
          risk: []
        }
      ]
    }
    return [
      {
        ...base,
        kind: 'delete',
        externalId: observed.externalId,
        reason:
          type === T.environment
            ? `Stop and remove ${nameOf()} (its deployment history goes with it).`
            : type === T.runner
              ? `Remove ${nameOf()}; jobs it was running stop.`
              : `Remove ${nameOf()} from GitLab.`,
        changes: [],
        preconditions: { status: observed.status ?? null },
        risk: []
      }
    ]
  }

  // ── create ──
  if (!observed) {
    const changes: FieldChange[] = cfg.create
      .filter((k) => norm(desired.fields[k]) !== null)
      .map((k) => ({ field: k, to: desired.fields[k] }))
    if (cfg.secret && desired.fields[cfg.secret] !== undefined)
      changes.push({ field: cfg.secret, secret: true })
    const once =
      type === T.deployToken || type === T.runner
        ? ' GitLab shows the token once: the Hub seals it and hands it to what is bound to it.'
        : ''
    return [
      {
        ...base,
        kind: 'create',
        externalId: desired.externalId,
        reason: `Create ${nameOf(
          String(desired.fields[spec.nameField ?? 'name'] ?? '') || null
        )}.${once}`,
        changes,
        preconditions: {},
        risk: []
      }
    ]
  }

  // ── a project removed for good ──
  if (type === T.project && desired.fields.destroy === true) {
    return [
      {
        ...base,
        kind: 'delete',
        externalId: observed.externalId,
        action: 'destroy',
        reason: `Delete ${nameOf()} permanently, including its issues, merge requests and history.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }

  // ── replace ──
  const replaceChanges = changesOf(cfg, cfg.replace, desired, observed)
  const scope =
    (type === T.ciVariable || type === T.deployToken) && scopeChanged(desired, observed)
      ? [{ field: 'project', from: observed.fields.project ?? observed.fields.group, to: 'other' }]
      : []
  const refMoved = refChanged(cfg, desired, observed)
  if (replaceChanges.length || scope.length || refMoved) {
    const changes: FieldChange[] = [...replaceChanges]
    if (refMoved || scope.length)
      changes.push({ field: cfg.refs[0] ?? 'project', from: null, to: null })
    if (cfg.secret) changes.push({ field: cfg.secret, secret: true })
    const why = replaceChanges.length ? fieldWords(spec.fields, replaceChanges) : 'where it lives'
    return [
      {
        ...base,
        kind: 'replace',
        externalId: observed.externalId,
        reason:
          type === T.deployToken
            ? `Replace ${nameOf()}: ${why} cannot change in place, so a new token is made and the old one removed.`
            : `Replace ${nameOf()}: ${why} cannot change in place.`,
        changes,
        preconditions: { status: observed.status ?? null, version: observed.version ?? null },
        risk: []
      }
    ]
  }

  // ── update (+ rotate) ──
  const ops: PlannedOp[] = []
  const changes = changesOf(cfg, cfg.diff, desired, observed)
  if (cfg.secret) {
    const v = desired.fields[cfg.secret]
    if (isSecret(v) ? v.changed : v !== undefined && typeof v === 'string' && v !== '')
      changes.push({ field: cfg.secret, secret: true })
  }
  if (changes.length) {
    const pre: Record<string, unknown> = { version: observed.version ?? null }
    for (const c of changes) if (!c.secret) pre[c.field] = c.from ?? null
    ops.push({
      ...base,
      kind: 'update',
      externalId: observed.externalId,
      reason: `Change ${fieldWords(spec.fields, changes)} on ${nameOf()}.`,
      changes,
      preconditions: pre,
      risk: []
    })
  }
  if (cfg.rotate && desired.fields[ROTATE_OUTPUTS_FIELD] === true) {
    ops.push({
      ...base,
      kind: 'update',
      externalId: observed.externalId,
      action: 'rotate',
      reason:
        type === T.runner
          ? `Reset the authentication token of ${nameOf()}. The old token stops working at once; the runner must be restarted with the new one.`
          : `Make a new token for ${nameOf()} and remove the old one. The old token stops working at once.`,
      changes: [{ field: ROTATE_OUTPUTS_FIELD, from: false, to: true }],
      preconditions: { status: observed.status ?? null },
      risk: []
    })
  }
  return ops
}
