import {
  type CostEstimate,
  type FieldSpec,
  type OutputSpec,
  type PlannedOp,
  type ResourceTypeSpec,
  type RiskFlag,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import { EMAIL_RE } from './client.js'
import { ACCOUNT_TYPE, CERT_TYPE, KEY_TYPES } from './order.js'

/**
 * The two ACME resource types (Task 38).
 *  - `acme.account` (shared): the CA account of the connection's key. Hub administrators only.
 *  - `acme.certificate` (app): one certificate for a list of names, proven with DNS-01.
 */

const FREE: CostEstimate = {
  currency: 'USD',
  monthlyCents: 0,
  oneTimeCents: 0,
  yearlyCents: 0,
  basis: 'free',
  confidence: 'exact',
  lines: [],
  priceAsOf: null,
  note: 'The certificate and the account are free.'
}
const estimateFree = async (): Promise<CostEstimate> => ({ ...FREE, lines: [] })

export const ACCOUNT_FIELDS: FieldSpec[] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    help: 'A label for this account in the Hub (kept in the Hub, not at the CA).'
  },
  {
    key: 'terms_agreed',
    label: 'I agree to the CA’s terms of service',
    kind: 'boolean',
    createOnly: true,
    default: false,
    help: 'Required to make an account. For Let’s Encrypt: https://letsencrypt.org/repository/'
  },
  {
    key: 'contact_email',
    label: 'Contact email',
    kind: 'string',
    pattern: EMAIL_RE.source,
    help: 'Blank = the connection’s contact email.'
  },
  { key: 'status', label: 'Status', kind: 'string', readOnly: true },
  { key: 'directory', label: 'Certificate authority', kind: 'string', readOnly: true }
]

export const CERT_FIELDS: FieldSpec[] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    help: 'A label for this certificate in the Hub, e.g. www-production.'
  },
  {
    key: 'account',
    label: 'ACME account',
    kind: 'ref',
    refType: ACCOUNT_TYPE,
    required: true,
    help: 'The CA account that orders it (a Hub administrator makes it once per connection).'
  },
  {
    key: 'names',
    label: 'Names',
    kind: 'list',
    required: true,
    items: { key: 'item', label: 'Name', kind: 'string' },
    help: 'Host names, e.g. app.example.com, or a wildcard such as *.example.com. All names must be inside the one DNS zone below. A wildcard certificate works for every subdomain: a Hub administrator starts it.'
  },
  {
    key: 'zone',
    label: 'DNS zone',
    kind: 'string',
    required: true,
    help: 'The zone id (Cloudflare zone id or Route 53 hosted zone id) in the connection’s DNS connection that holds the names. The TXT proof records are made and removed there.'
  },
  {
    key: 'key_type',
    label: 'Key type',
    kind: 'enum',
    default: 'ec256',
    options: KEY_TYPES.map((v) => ({
      value: v,
      label: { ec256: 'EC P-256', ec384: 'EC P-384', rsa2048: 'RSA 2048', rsa4096: 'RSA 4096' }[v]
    })),
    help: 'A different key type orders a new certificate.'
  },
  {
    key: ROTATE_OUTPUTS_FIELD,
    label: 'Make a new key and certificate',
    kind: 'boolean',
    trigger: true,
    default: false,
    help: 'The private key is shown once, when the certificate is made. If the sealed copy is lost this orders a new certificate with a new key; the old certificate stays valid until it expires. At most one order an hour.'
  },
  { key: 'serial', label: 'Serial', kind: 'string', readOnly: true },
  { key: 'issuer', label: 'Issued by', kind: 'string', readOnly: true },
  { key: 'not_before', label: 'Valid from', kind: 'string', readOnly: true },
  { key: 'not_after', label: 'Valid until', kind: 'string', readOnly: true },
  { key: 'directory', label: 'Certificate authority', kind: 'string', readOnly: true }
]

export const CERT_OUTPUTS: OutputSpec[] = [
  { key: 'fullchain', label: 'Certificate chain (PEM)', secret: false },
  { key: 'private_key', label: 'Private key (PEM)', secret: true, onceOnly: true }
]

/** Names that are wildcards, read from an op's data (set by plan). */
const wildcardOf = (op: PlannedOp): boolean => op.data?.wildcard === true

export const accountSpec: ResourceTypeSpec = {
  key: ACCOUNT_TYPE,
  label: 'ACME account',
  scope: 'shared',
  fields: ACCOUNT_FIELDS,
  capabilities: {
    create: true,
    update: true,
    delete: true,
    adopt: true,
    snapshot: false,
    tag: false
  },
  reversible: false,
  refs: [],
  nameField: 'name',
  risk(op): RiskFlag[] {
    // Deactivating an account cannot be undone and strands every certificate ordered under it.
    return op.kind === 'delete' ? ['destructive', 'data_loss'] : []
  },
  estimate: estimateFree
}

export const certificateSpec: ResourceTypeSpec = {
  key: CERT_TYPE,
  label: 'Certificate',
  scope: 'app',
  fields: CERT_FIELDS,
  capabilities: {
    create: true,
    update: true,
    delete: true,
    adopt: false,
    snapshot: false,
    tag: false
  },
  reversible: false,
  refs: [{ field: 'account', type: ACCOUNT_TYPE }],
  nameField: 'name',
  outputs: CERT_OUTPUTS,
  risk(op): RiskFlag[] {
    // A renewal and a plain re-key are normal changes. A NEW wildcard name is a name for every
    // subdomain at once: a Hub administrator starts it (judged on what is sent to the CA).
    if (op.kind === 'delete') return []
    if (op.action === 'renew' || op.action === 'rotate') return []
    return wildcardOf(op) ? ['public_exposure'] : []
  },
  estimate: estimateFree
}

export const ACME_TYPES: ResourceTypeSpec[] = [accountSpec, certificateSpec]
