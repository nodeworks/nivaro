import { fieldWords, typedName } from '../plan-words.js'
import {
  type DesiredResource,
  type FieldChange,
  type Observed,
  type PlannedOp,
  type ProviderContext,
  ProviderError,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import { directoryChoice, isProduction } from './client.js'
import { parseNames, sameNames, sortedNames } from './names.js'
import { ACCOUNT_TYPE, CERT_TYPE, daysLeft, keyTypeOf, RENEW_BEFORE_DAYS } from './order.js'
import { CERT_FIELDS } from './specs.js'

/** Pure planners for both types. No calls: observed is what the adapter read. */

const CA_LABEL = (ctx: ProviderContext) =>
  directoryChoice(ctx.config) === 'letsencrypt_production'
    ? 'Let’s Encrypt (production)'
    : directoryChoice(ctx.config) === 'custom'
      ? 'the configured ACME CA'
      : 'Let’s Encrypt staging'

const STAGING_NOTE =
  ' This is the STAGING CA: browsers do not trust its certificates. A Hub administrator switches the connection to production when it is time.'

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** The contact the account should carry: the resource's own, else the connection's. */
export function contactOf(ctx: ProviderContext, fields: Record<string, unknown>): string {
  return str(fields.contact_email) || str(ctx.config.contact_email)
}

// ═══ Account ═══

export function planAccount(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: ACCOUNT_TYPE,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Deactivate the ACME account ${typedName('', observed.name)}. This cannot be undone: the CA refuses every further order and renewal made with this account, so certificates ordered under it can no longer be renewed through it.`,
        changes: [],
        preconditions: { status: observed.fields.status ?? null },
        risk: []
      }
    ]
  }
  const contact = contactOf(ctx, desired.fields)
  if (!observed) {
    if (desired.fields.terms_agreed !== true)
      throw new ProviderError(
        'INVALID_FIELDS',
        'Agree to the CA’s terms of service to make an ACME account.'
      )
    return [
      {
        kind: 'create',
        type: ACCOUNT_TYPE,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Make an ACME account at ${CA_LABEL(ctx)} for ${contact || 'the connection’s contact'} and agree to the CA’s terms of service.${isProduction(ctx.config) ? '' : STAGING_NOTE}`,
        changes: [
          { field: 'terms_agreed', to: true },
          { field: 'contact_email', to: contact }
        ],
        preconditions: {},
        risk: []
      }
    ]
  }
  if (contact && contact !== observed.fields.contact_email)
    return [
      {
        kind: 'update',
        type: ACCOUNT_TYPE,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Change the contact email of ${typedName('ACME account', observed.name)} to ${contact}.`,
        changes: [{ field: 'contact_email', from: observed.fields.contact_email, to: contact }],
        preconditions: { contact_email: observed.fields.contact_email ?? null },
        risk: []
      }
    ]
  return []
}

// ═══ Certificate ═══

const certWords = (changes: FieldChange[]) => fieldWords(CERT_FIELDS, changes)
const LABEL = 'certificate'

function zoneOf(desired: DesiredResource): string {
  const z = str(desired.fields.zone)
  if (!z)
    throw new ProviderError(
      'INVALID_FIELDS',
      'Name the DNS zone (its id) that holds the certificate’s names.'
    )
  return z
}

export function planCertificate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: CERT_TYPE,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Stop managing ${typedName(LABEL, observed.name)}. The CA is not asked to revoke it: it stays valid until ${String(observed.fields.not_after ?? 'it expires')}, and anything already using it keeps working. The Hub forgets its sealed private key.`,
        changes: [],
        preconditions: { serial: observed.fields.serial ?? null },
        risk: []
      }
    ]
  }
  const names = parseNames(desired.fields.names)
  const zone = zoneOf(desired)
  const keyType = keyTypeOf(desired.fields.key_type)
  const wantNames = names.map((n) => n.name)
  const hasWildcard = names.some((n) => n.wildcard)
  const production = isProduction(ctx.config)
  const note = production ? '' : STAGING_NOTE

  if (!observed) {
    return [
      {
        kind: 'create',
        type: CERT_TYPE,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Order ${typedName(LABEL, String(desired.fields.name ?? ''))} for ${wantNames.join(', ')} from ${CA_LABEL(ctx)}. Each name is proven with a temporary _acme-challenge TXT record in zone ${zone}, removed afterwards. The private key is shown once; the Hub seals it.${hasWildcard ? ' A wildcard certificate covers every subdomain.' : ''}${note}`,
        changes: [
          { field: 'names', to: wantNames },
          { field: 'key_type', to: keyType },
          { field: 'zone', to: zone }
        ],
        preconditions: {},
        risk: [],
        data: { wildcard: hasWildcard, production }
      }
    ]
  }

  const haveNames = Array.isArray(observed.fields.names) ? (observed.fields.names as string[]) : []
  const changes: FieldChange[] = []
  if (!sameNames(wantNames, haveNames))
    changes.push({ field: 'names', from: sortedNames(haveNames), to: sortedNames(wantNames) })
  if (keyType !== observed.fields.key_type)
    changes.push({ field: 'key_type', from: observed.fields.key_type, to: keyType })
  const pre = {
    serial: observed.fields.serial ?? null,
    not_after: observed.fields.not_after ?? null
  }
  const base = {
    kind: 'update' as const,
    type: CERT_TYPE,
    resourceId: desired.resourceId,
    externalId: observed.externalId,
    preconditions: pre,
    risk: [] as []
  }
  const rotate = desired.fields[ROTATE_OUTPUTS_FIELD] === true
  const oneShot = rotate ? { $oneShot: [ROTATE_OUTPUTS_FIELD] } : {}

  if (changes.length) {
    const newWildcard = names.some((n) => n.wildcard && !haveNames.includes(n.name))
    return [
      {
        ...base,
        reason: `Order a new ${LABEL} for ${typedName('', observed.name)}: ${certWords(changes)} cannot change on an issued certificate. The old certificate stays valid until it expires.${newWildcard ? ' A wildcard certificate covers every subdomain.' : ''}${note}`,
        changes,
        action: 'reissue',
        data: { wildcard: newWildcard, production, ...oneShot }
      }
    ]
  }
  if (rotate)
    return [
      {
        ...base,
        reason: `Make a new private key and ${LABEL} for ${typedName('', observed.name)}. The old certificate stays valid until it expires, so what uses it keeps working until the new value is applied.`,
        changes: [{ field: ROTATE_OUTPUTS_FIELD, to: true }],
        action: 'rotate',
        data: { wildcard: false, production }
      }
    ]
  const notAfter = String(observed.fields.not_after ?? '')
  if (notAfter) {
    const left = daysLeft(notAfter, ctx.now())
    if (left <= RENEW_BEFORE_DAYS)
      return [
        {
          ...base,
          reason:
            left < 0
              ? `Renew ${typedName(LABEL, observed.name)}: it expired ${-left} day(s) ago.`
              : `Renew ${typedName(LABEL, observed.name)}: it expires in ${left} day(s) (renewal starts ${RENEW_BEFORE_DAYS} days before). Same names, a fresh key.`,
          changes: [],
          action: 'renew',
          data: { wildcard: false, production }
        }
      ]
  }
  return []
}
