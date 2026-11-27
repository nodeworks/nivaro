import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2, Task 14: Microsoft Entra ID. Facts are from the adapter:
// api/src/services/hub/providers/entra/** and the shared client providers/microsoft/graph.ts.
// Nothing here ran against a live tenant yet: the section says what still needs one live check.

const HUB_ONLY =
  'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'

export const hubProvidersEntraDocs: DocSection = {
  id: 'hub-providers-entra',
  label: 'Provider: Microsoft Entra ID',
  content: [
    { type: 'h1', id: 'hub-providers-entra', text: 'Provider: Microsoft Entra ID — Hub mode only' },
    { type: 'warn', text: HUB_ONLY },
    {
      type: 'p',
      text: 'Manages the sign-in side of an app in Microsoft Entra ID through Microsoft Graph: its app registration, client secrets, enterprise application, app roles, group-to-role assignments and requested API permissions.'
    },
    { type: 'h2', id: 'hub-providers-entra-connection', text: 'Connection' },
    {
      type: 'p',
      text: 'Fields: `tenant_id` (a directory id, or a domain such as contoso.onmicrosoft.com), `client_id` (a GUID) and one credential: the sealed `client_secret`, or a sealed `certificate_key` (the private key, PEM) with its `certificate_thumbprint`. The Hub signs in with the client-credentials grant for the Graph `.default` scope, caches the token per connection and mints again once on a 401. A token for another tenant than a pinned directory id is refused. Allowed hosts: `graph.microsoft.com` and `login.microsoftonline.com`. Paging follows the next link on the Graph host only; a 429 with a Retry-After of 5 seconds or less is waited out, a longer one is a retryable failure.'
    },
    {
      type: 'p',
      text: 'Test reads the permissions from the token. Preferred: `Application.ReadWrite.OwnedBy`, so the Hub changes only apps it owns (an app it creates is owned by it). `Application.ReadWrite.All` also works but Test warns that it reaches every app in the tenant. Group role assignments need `AppRoleAssignment.ReadWrite.All`; reading groups needs `Group.Read.All`. All are application permissions with admin consent.'
    },
    { type: 'h2', id: 'hub-providers-entra-types', text: 'Resource types' },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`entra.app_registration`',
          'application object id',
          'Name, who can sign in (single tenant by default), web and single-page redirect URIs, sign-out URL. Outputs `client_id` and `tenant_id` (not secret). Tags are kept as `nivaro-hub:<key>=<value>` on the application; other tags are left alone. Delete is `destructive` + `downtime`. A wider sign-in audience, a wildcard or non-local http redirect is `public_exposure`.'
        ],
        [
          '`entra.client_secret`',
          '`<application id>:<key id>`',
          'A client secret on an app registration, valid 1 to 24 months. The value is shown by Entra once: it is the `client_secret` output (once only, sealed by the Hub, never in observed state, a plan or an error). Only its id, name and dates are read, never the hint.'
        ],
        [
          '`entra.service_principal`',
          'service principal id',
          'The enterprise application for an app registration: sign-in enabled and "require assignment". Requiring assignment, switching sign-in off or deleting it is `downtime`.'
        ],
        [
          '`entra.app_role`',
          '`<application id>:<role id>`',
          'One entry of the application’s app roles (value, display name, description, who can hold it). The role id is derived from the Hub resource, so a resumed create finds its own role. Entra needs a role switched off before it can be removed: delete does both steps. Changing the value or switching a role off is `downtime`.'
        ],
        [
          '`entra.group_role_assignment`',
          '`<service principal id>:<assignment id>`',
          'A group holding an app role (or default access) on an enterprise application. The group is an adopted `entra.group`. Assignments of people and applications are not listed. Removing one is `downtime`.'
        ],
        [
          '`entra.api_permission`',
          '`<application id>:<API application id>`',
          'The permissions an app registration requests from one API (default Microsoft Graph), by permission id and type (`Scope` delegated or `Role` application). Requesting does not grant. Adding an application (`Role`) permission is `public_exposure`.'
        ],
        [
          '`entra.group`',
          'group object id',
          'Shared, read and adopt only. The Hub never creates, changes or deletes a group; apply refuses with `UNSUPPORTED`.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-entra-secrets', text: 'Secret rotation and expiry' },
    {
      type: 'ul',
      items: [
        'Rotate: set `rotate_outputs` on the client secret. A new secret named `<name> (rotated <time>)` is made next to the current one and becomes the resource’s id; the new value is the `client_secret` output. The old secret keeps working.',
        'Bind the outputs: `client_secret` to the stack secret `OIDC_CLIENT_SECRET`, and the app registration’s `client_id` to `OIDC_CLIENT_ID`. Pushing a binding marks the stack "needs apply"; it never applies by itself.',
        'After the stack applied the new secret, set `remove_older`: the earlier secrets of that name (the same name or `<name> (rotated …)`, never another tool’s) are deleted. It is `destructive` and a typed confirm.',
        'Health warns 30 days before a secret expires and reports `down` once it has, and says how many older secrets are still valid.',
        'If the sealed copy of a secret is lost, it cannot be read again: rotate it.'
      ]
    },
    { type: 'h2', id: 'hub-providers-entra-consent', text: 'Consent' },
    {
      type: 'p',
      text: 'Admin consent is a person’s step. The health of `entra.api_permission` compares what is requested with what the app’s enterprise application was granted (application permissions and delegated grants). When something is missing it says "Consent needed" with the link `https://login.microsoftonline.com/<tenant>/adminconsent?client_id=<app id>`. The Hub never grants consent.'
    },
    { type: 'h2', id: 'hub-providers-entra-rules', text: 'Safety rules' },
    {
      type: 'ul',
      items: [
        'The app registration the connection itself signs in as is never written (`SELF_APP`), nor its enterprise application, roles, secrets or permissions.',
        'A create that finds an enterprise application, role value, secret name, permission request or assignment the Hub did not make stops with `ALREADY_EXISTS`: adopt it. Applications are not name-unique, so only the Hub’s resource tag identifies one made by an interrupted run.',
        'A just-made app registration may not be visible everywhere yet: creating its secret or enterprise application then fails with the retryable `REPLICATION_PENDING`.',
        'Ids put into a URL are GUIDs or refused (`BAD_ID`). Provider text is scrubbed of the connection’s secrets (client secret, certificate key, tokens) before it is shown.',
        'Entra types have no price: no cost estimate is shown for them.',
        'Needs a live check: the `appRoleAssignedTo` listing, `tags/any` application filters and the consent health against a real tenant; they are from documentation and recorded answers only.'
      ]
    }
  ]
}
