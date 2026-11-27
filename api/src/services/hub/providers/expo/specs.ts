import type { FieldSpec, ResourceCapabilities, ResourceTypeSpec } from '../types.js'
import { expoBuildEstimate, expoProjectEstimate } from './pricing.js'

/** Resource type specs of the Expo adapter. Expo has no tags, so `tag` is false everywhere. */

export const EXPO_ENVIRONMENTS = [
  { value: 'development', label: 'Development' },
  { value: 'preview', label: 'Preview' },
  { value: 'production', label: 'Production' }
]

const NAME_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'

const caps = (over: Partial<ResourceCapabilities>): ResourceCapabilities => ({
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
  refType: 'expo.project',
  required: true,
  createOnly: true,
  replaceOnChange: true
}

export const EXPO_TYPES: ResourceTypeSpec[] = [
  {
    key: 'expo.project',
    label: 'Expo project',
    scope: 'app',
    fields: [
      {
        key: 'name',
        label: 'Project slug',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: NAME_PATTERN,
        help: 'Created under the connection’s pinned account. A slug cannot be renamed.'
      },
      {
        key: 'privacy',
        label: 'Privacy',
        kind: 'enum',
        default: 'unlisted',
        createOnly: true,
        options: [
          { value: 'unlisted', label: 'Unlisted' },
          { value: 'public', label: 'Public' }
        ]
      },
      { key: 'account', label: 'Account', kind: 'string', readOnly: true }
    ],
    estimate: expoProjectEstimate,
    capabilities: caps({}),
    reversible: false,
    refs: [],
    risk: (op) =>
      op.kind === 'delete' || op.kind === 'replace' ? ['destructive', 'data_loss'] : []
  },
  {
    key: 'expo.branch',
    label: 'Update branch',
    scope: 'app',
    fields: [
      projectRef,
      {
        key: 'name',
        label: 'Branch name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: NAME_PATTERN
      }
    ],
    capabilities: caps({ update: false }),
    reversible: false,
    refs: [{ field: 'project', type: 'expo.project' }],
    risk: (op) => (op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : [])
  },
  {
    key: 'expo.channel',
    label: 'Update channel',
    scope: 'app',
    fields: [
      projectRef,
      {
        key: 'name',
        label: 'Channel name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: NAME_PATTERN
      },
      {
        key: 'branch',
        label: 'Points at branch',
        kind: 'ref',
        refType: 'expo.branch',
        help: 'Changing this is a deploy: devices on this channel get that branch’s updates.'
      }
    ],
    capabilities: caps({}),
    // Pointing back at the previous branch is always possible.
    reversible: (field) => field === 'branch',
    // The branch is where the channel sends devices; the channel itself does not need it to exist.
    refs: [
      { field: 'project', type: 'expo.project' },
      { field: 'branch', type: 'expo.branch', required: false }
    ],
    risk: (op) => (op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : [])
  },
  {
    key: 'expo.env_var',
    label: 'Environment variable',
    scope: 'app',
    fields: [
      projectRef,
      {
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z_][A-Za-z0-9_]*$'
      },
      {
        key: 'value',
        label: 'Value',
        kind: 'secret',
        required: true,
        help: 'Write-only: the Hub keeps a fingerprint, never the value.'
      },
      {
        key: 'visibility',
        label: 'Visibility',
        kind: 'enum',
        default: 'secret',
        options: [
          { value: 'plaintext', label: 'Plain text' },
          { value: 'sensitive', label: 'Sensitive' },
          { value: 'secret', label: 'Secret' }
        ]
      },
      {
        key: 'environments',
        label: 'Environments',
        kind: 'list',
        required: true,
        items: {
          key: 'environment',
          label: 'Environment',
          kind: 'enum',
          options: EXPO_ENVIRONMENTS
        }
      }
    ],
    capabilities: caps({}),
    // A value that was overwritten cannot be read back, so only the shape is undoable.
    reversible: (field) => field === 'visibility' || field === 'environments',
    refs: [{ field: 'project', type: 'expo.project' }],
    nameField: 'name',
    risk: (op) => (op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : [])
  },
  {
    key: 'expo.build',
    label: 'Build',
    scope: 'app',
    fields: [
      projectRef,
      {
        key: 'platform',
        label: 'Platform',
        kind: 'enum',
        required: true,
        createOnly: true,
        options: [
          { value: 'ios', label: 'iOS' },
          { value: 'android', label: 'Android' }
        ]
      },
      {
        key: 'profile',
        label: 'Build profile',
        kind: 'string',
        required: true,
        createOnly: true,
        help: 'A profile from eas.json.'
      },
      { key: 'gitRef', label: 'Git ref', kind: 'string', createOnly: true }
    ],
    // A build is triggered once and read afterwards; it cannot be edited or deleted here.
    estimate: expoBuildEstimate,
    capabilities: caps({ update: false, delete: false }),
    reversible: false,
    refs: [{ field: 'project', type: 'expo.project' }],
    nameField: 'profile',
    risk: () => []
  }
]

export const EXPO_TYPE_KEYS = EXPO_TYPES.map((t) => t.key)
