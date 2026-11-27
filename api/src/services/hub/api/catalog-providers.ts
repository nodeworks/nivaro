import type { HubField, HubRoute } from './catalog.js'

/**
 * Catalog entries for the Hub third-party providers routes (routes/hub-providers.ts): connections,
 * provider types, managed resources and resource changes. Kept beside catalog.ts so its list stays
 * one spread line; the catalog guard test reads HUB_ROUTES, which includes these.
 */

const s = (description: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'string',
  description,
  ...extra
})
const n = (description: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'integer',
  description,
  ...extra
})
const o = (description: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'object',
  description,
  ...extra
})
const list = (items: HubField['items'], description: string): HubField => ({
  type: 'array',
  items,
  description
})

const r = (
  method: HubRoute['method'],
  path: string,
  auth: HubRoute['auth'],
  access: HubRoute['access'],
  summary: string,
  extra: Partial<HubRoute> = {}
): HubRoute => ({ method, path, group: 'Providers', auth, access, summary, ...extra })

const SECRETS_NOTE =
  'Secret fields are write-only: reads answer a mask, a fingerprint and the names of the secret fields that hold a value.'
const CHANGE_NOTE =
  'Every refusal carries a code (STALE_PLAN, CONFIRM_MISMATCH, FROZEN, CONNECTION_NOT_ALLOWED, SHARED_ADMIN_ONLY, SHARED_IN_USE …); a provider failure is 502 PROVIDER_ERROR.'

export const PROVIDER_ROUTES: HubRoute[] = [
  r('GET', '/provider-types', 'owner', 'read', 'Registered providers and their resource types', {
    notes:
      'Types, fields, capabilities and the risk vocabulary of each adapter. Never connection data.'
  }),
  r(
    'GET',
    '/connections',
    'owner',
    'read',
    'Provider connections (admins: all; owners: those allowed for their apps)',
    { notes: SECRETS_NOTE, query: { provider: s('Only this provider') } }
  ),
  r('POST', '/connections', 'admin', 'write', 'Create a provider connection', {
    sensitive: true,
    notes: SECRETS_NOTE,
    body: {
      provider: s('Provider key (github, aws, …)', { required: true }),
      name: s('Display name', { required: true }),
      config: o('Non-secret connection fields'),
      secrets: o('Secret connection fields (sealed, never answered back)', { secret: true })
    }
  }),
  r('GET', '/connections/:id', 'owner', 'read', 'One provider connection', {
    notes: SECRETS_NOTE
  }),
  r('PATCH', '/connections/:id', 'admin', 'write', 'Edit a provider connection', {
    sensitive: true,
    notes: `${SECRETS_NOTE} Only the secret keys sent change; a masked value keeps the stored one, an empty value clears it.`,
    body: {
      name: s('Display name'),
      config: o('Non-secret fields to change (merged over the stored ones)'),
      secrets: o('Secret fields to change', { secret: true })
    }
  }),
  r('DELETE', '/connections/:id', 'admin', 'write', 'Delete a provider connection', {
    sensitive: true,
    notes: 'Refused (409 CONNECTION_IN_USE) while it still has managed resources.'
  }),
  r(
    'POST',
    '/connections/:id/test',
    'admin',
    'write',
    'Test the credentials: identity and the permissions they have',
    { notes: 'Calls the provider. Stores the result and the connection status.' }
  ),
  r(
    'POST',
    '/connections/:id/acme/generate-account-key',
    'admin',
    'write',
    'Generate and seal the ACME account key of an acme connection',
    {
      sensitive: true,
      body: {
        replace: { type: 'boolean', description: 'Replace a stored key (makes a new ACME account)' }
      },
      notes:
        'Only for acme connections. The key is made on the server and sealed into the connection; it is never answered. 409 ACCOUNT_KEY_EXISTS when a key is stored and replace is not true.'
    }
  ),
  r('GET', '/connections/:id/unmanaged', 'admin', 'read', 'Resources the Hub does not manage yet', {
    query: {
      type: s('Resource type key (aws.vpc …)', { required: true }),
      cursor: s('Next page, from the previous answer')
    }
  }),
  r('POST', '/connections/:id/adopt', 'owner', 'write', 'Adopt an existing provider resource', {
    notes:
      'Binds it to an app environment or (admins only) to the shared scope. No provider write.',
    body: {
      type: s('Resource type key', { required: true }),
      externalId: s('The provider’s id for it', { required: true }),
      scope: s('app or shared', { required: true, enum: ['app', 'shared'] }),
      appId: n('Required for scope app'),
      environmentId: n('The environment of the app')
    }
  }),
  r('GET', '/apps/:id/connections', 'owner', 'read', 'Connections allowed for an app'),
  r('PUT', '/apps/:id/connections', 'admin', 'write', 'Set the connections allowed for an app', {
    sensitive: true,
    body: { connection_ids: list('integer', 'Exactly these connections are allowed') }
  }),
  r('GET', '/resources', 'owner', 'read', 'Managed resources the caller may see', {
    query: {
      app: n('An app id'),
      environment: n('An environment id'),
      provider: s('Provider key'),
      connection: n('A connection id'),
      type: s('Resource type key'),
      drift: s('1 = only resources that drifted'),
      scope: s('app or shared', { enum: ['app', 'shared'] })
    }
  }),
  r('GET', '/resources/:id', 'owner', 'read', 'One managed resource', {
    notes:
      'A row with no provider id carries pending_create {change_id, status, resumable}: its create has not reached the provider (still running, or failed).'
  }),
  r(
    'POST',
    '/resources/:id/discard',
    'owner',
    'write',
    'Discard a create that never reached the provider',
    {
      notes:
        'No provider call: drops the resource row (it has no provider id) and closes its failed change as cancelled. Refused while the change runs (409 RESOURCE_BUSY) and for a resource the provider has (409 BAD_STATUS).'
    }
  ),
  r('POST', '/resources/plan', 'owner', 'plan', 'Plan changes to managed resources', {
    notes: `Reads the provider and stores a planned change; nothing is written at the provider. ${CHANGE_NOTE}`,
    body: {
      connectionId: n('The connection', { required: true }),
      scope: s('app or shared', { required: true, enum: ['app', 'shared'] }),
      appId: n('Required for scope app'),
      environmentId: n('The environment of the app'),
      ops: list(
        'object',
        '{action: create|update|delete|adopt|reapply|accept, resourceId?, type?, fields?, externalId?}'
      )
    }
  }),
  r('GET', '/resource-changes', 'owner', 'read', 'Resource changes the caller may see', {
    query: {
      app: n('An app id'),
      environment: n('An environment id'),
      connection: n('A connection id'),
      scope: s('app or shared', { enum: ['app', 'shared'] }),
      status: s('One status, or a comma list'),
      limit: n('1–200, default 50'),
      before: n('Page back from this change id')
    }
  }),
  r('GET', '/resource-changes/:id', 'owner', 'read', 'One resource change, step by step'),
  r('POST', '/resource-changes/:id/start', 'owner', 'write', 'Start a planned change', {
    sensitive: true,
    accepted: true,
    notes: `Bound to the plan hash; destructive changes need the typed confirm; an owner’s cost change is saved as pending_approval. ${CHANGE_NOTE}`,
    body: {
      planHash: s('The planHash of the plan read', { required: true }),
      confirm: s('The text the plan asks to be typed, when it asks')
    }
  }),
  r(
    'POST',
    '/resource-changes/:id/cancel',
    'owner',
    'write',
    'Cancel a change that has not started'
  ),
  r('POST', '/resource-changes/:id/resume', 'owner', 'write', 'Resume an interrupted change', {
    accepted: true,
    notes: 'Replays only the steps without a recorded success.'
  }),
  r(
    'POST',
    '/resource-changes/:id/undo',
    'owner',
    'write',
    'Plan the way back of an applied change',
    {
      sensitive: true,
      notes: 'Makes a new planned change from the observed state back to the stored before-state.'
    }
  ),
  r(
    'POST',
    '/resource-changes/:id/approve',
    'admin',
    'write',
    'Approve an owner’s pending change',
    {
      sensitive: true,
      accepted: true,
      body: { planHash: s('The planHash the approver saw', { required: true }) }
    }
  ),
  r(
    'POST',
    '/resource-changes/:id/decline',
    'admin',
    'write',
    'Decline an owner’s pending change',
    { body: { reason: s('Why (shown to the owner)', { required: true }) } }
  ),
  // Task 13 (Wave 2 framework): outputs, bindings and notify routes (routes/hub-provider-outputs.ts).
  r('GET', '/resources/:id/bindings', 'owner', 'read', 'A resource’s outputs and where they go', {
    notes:
      'Outputs answer the key, a fingerprint and when it changed — never a value. A once-only output whose copy is gone is `lost` (rotate it).'
  }),
  r('PUT', '/resources/:id/bindings', 'owner', 'write', 'Bind a resource’s outputs to settings', {
    sensitive: true,
    notes:
      'Replaces the list, then pushes the stored values in the background. A stack target only saves the stack settings (the stack then needs Apply now); an app setting goes through the hub link and must be on its allow-list (SETTING_NOT_ALLOWED). A secret output never binds to a plain setting (SECRET_TO_PLAIN).',
    body: {
      bindings: list(
        'object',
        'Each {output_key, environment_id, target stack_setting|stack_secret|app_setting, target_key}'
      )
    }
  }),
  r('GET', '/notify-routes', 'owner', 'read', 'Notify routes (admins: all; owners: their apps’)'),
  r('POST', '/notify-routes', 'owner', 'write', 'Send Hub events through a resource', {
    body: {
      name: s('A label'),
      scope: s('hub (every app, admins) or app', { required: true, enum: ['hub', 'app'] }),
      app_id: n('The app (scope app)'),
      events: list('string', 'Event names (deploy.failed, incident.opened …)'),
      resource_id: n('The sending resource (Slack channel, Teams webhook …)', { required: true }),
      enabled: { type: 'boolean', description: 'Default true' }
    }
  }),
  r('PATCH', '/notify-routes/:id', 'owner', 'write', 'Change a notify route', {
    body: {
      name: s('A label'),
      events: list('string', 'Event names'),
      resource_id: n('The sending resource'),
      enabled: { type: 'boolean', description: 'On or off' }
    }
  }),
  r('DELETE', '/notify-routes/:id', 'owner', 'write', 'Delete a notify route'),
  r('POST', '/notify-routes/:id/test', 'owner', 'write', 'Send one test message through a route', {
    notes: 'Waits for the provider (at most 10 s) and answers ok or the scrubbed error.'
  })
]
