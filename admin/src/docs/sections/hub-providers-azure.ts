import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3: Azure (SQL and Cost Management). Facts are from the adapter
// code: api/src/services/hub/providers/azure/**. Nothing here ran against a live Azure
// subscription yet.

export const hubProvidersAzureDocs: DocSection = {
  id: 'hub-providers-azure',
  label: 'Provider: Azure',
  content: [
    { type: 'h1', id: 'hub-providers-azure', text: 'Provider: Azure — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `tenant_id`, `client_id`, a secret `client_secret` (an Entra app registration, signed in with the client-credentials grant for `https://management.azure.com/.default`, the same sign-in as the Entra and Teams providers) and `subscription_ids`, the subscriptions this connection may touch. Anything outside that list is refused (`AZURE_OUT_OF_ACCOUNT`) on every read, write and delete, and a database, rule or endpoint is judged through its server’s id. Hosts: `management.azure.com`, `login.microsoftonline.com` and `prices.azure.com` (public price list, no sign-in). Give the app registration a role on each subscription: Contributor (or SQL Server Contributor and SQL DB Contributor), plus Cost Management Reader for the cost feed and Cost Management Contributor for budgets. Test reads each subscription and runs a month-to-date cost query, and marks a missing right.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`azure.resource_group`',
          'ARM id',
          'Shared. Read and adopt, or create (an empty group). Delete is refused while the group holds anything (`GROUP_NOT_EMPTY`): the Hub never deletes a group with resources in it. The `nivaro-hub:app` tag is written to Azure as `nivaro-hub-app`.'
        ],
        [
          '`azure.sql_server`',
          'ARM id',
          'Shared. Minimum TLS 1.2 (or 1.3), **public network access off by default**: turning it on is `public_exposure` (admin). Entra sign-in only by default (an Entra admin is required); turn it off to make a SQL admin login. Outputs: `server_fqdn` and, for a SQL-auth server, `connection_string` (secret, once only, built from the admin login and the password the Hub made or you supplied, naming the `app_database` field’s database). The password is never in a plan, step, error or the observed state. The `rotate_outputs` trigger sets a new admin password and answers a new connection string (`downtime`: the old string stops working). Delete is `destructive` + `data_loss` and is refused while a database other than `master` remains (`SERVER_NOT_EMPTY`).'
        ],
        [
          '`azure.sql_firewall_rule`',
          'ARM id',
          'Shared. A start and end IPv4 address. A range wider than a /8, the single address 0.0.0.0 (Azure reads it as every Azure service of any customer) or one the Hub cannot parse is `public_exposure`; a narrow range is not.'
        ],
        [
          '`azure.sql_database`',
          'ARM id',
          'Per app. Size (DTU tier Basic, S0–S3, P1, or vCore General Purpose, serverless, Business Critical), vCores, maximum size and short-term backup retention. A size change is `downtime` (typed confirm in production). Delete is `destructive` + `data_loss` and records a **restore point first**: a point-in-time restore moment inside the retention window (refused with `NO_RESTORE_POINT` when retention is 0). Costed monthly: the estimate reads the Azure Retail Prices API for the server’s region (vCore-hour and storage by GB-month, or a DTU tier’s monthly price), falls back to a dated table for the DTU tiers, and says plainly that it is a list price without reserved capacity, hybrid benefit, extra backup storage or data out. Serverless shows storage only and names the always-on figure in the note.'
        ],
        [
          '`azure.sql_private_endpoint`',
          'ARM id',
          'Shared. **Read and adopt only**: private endpoint connections are made by the owner of the endpoint; any change answers `READ_ONLY_TYPE`.'
        ],
        [
          '`azure.budget`',
          'ARM id',
          'Per app. A monthly Azure budget (Consumption) that counts the resources tagged `nivaro-hub-app` with the app’s value, with 80 % and 100 % actual-spend alerts to the listed emails. When the budget’s health is read and its current spend has passed a threshold, the Hub sends `cost.over_budget` through the notify routes (Slack, Teams, email, SMS), once per budget, threshold and month by dedup key.'
        ]
      ]
    },
    {
      type: 'h2',
      id: 'hub-providers-azure-costs',
      text: 'Cost Management feed'
    },
    {
      type: 'p',
      text: 'The adapter answers `costs(range)` for the cost feed: Cost Management Query API rows per day, per resource id, with the `nivaro-hub-app` tag value on a row whose resource carries it. The Query API allows two groupings, so the adapter asks twice (resource id + charge type for the rows, resource id + tag for the app) and lays the tag on the rows. Amounts are in the billing currency, in cents; credits and refunds are negative, and the charge type decides `recordType` (usage, tax, credit, discount, refund). A subscription whose costs the app cannot read adds no rows. Azure bills a day or more late.'
    },
    {
      type: 'ul',
      items: [
        'Long-running writes (a server, database or group) are followed through the `Azure-AsyncOperation` / `Location` address (only on `management.azure.com`). A run that gives up leaves the resource in its provisioning state and fails retryably; the next apply reads it first and waits again.',
        'A create that finds a resource with the same name the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead (Azure’s PUT would overwrite it).',
        'Needs a live check: the Retail Prices API product and meter names behind the vCore and DTU estimate, the Cost Management column names (`TagValue`), whether a server created Entra-only needs the Entra admin’s principal type, and the budget start-date rule.'
      ]
    }
  ]
}
