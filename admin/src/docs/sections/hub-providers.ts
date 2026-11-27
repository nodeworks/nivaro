import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 1 (GitHub, AWS, Vercel, Auth0, Expo). Facts are from the merged
// code: api/src/services/hub/providers/** (engine, observe, adapters, hooks), routes/hub-providers.ts,
// services/hub/api/{catalog-providers,graphql}.ts, packages/sdk/src/commands/hub.ts and
// packages/mcp/src/tools/hub.ts. Nothing here ran against a live provider account yet: each
// provider section says what still needs one live check.

const HUB_ONLY =
  'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it: the routes answer 404 and the Apps hub has no Connections or Shared infra tab.'

export const hubProvidersDocs: DocSection = {
  id: 'hub-providers',
  label: 'Outside services: connections, resources and changes',
  content: [
    { type: 'h1', id: 'hub-providers', text: 'Outside services — Hub mode only' },
    { type: 'warn', text: HUB_ONLY },
    {
      type: 'p',
      text: 'The Hub can look after the things an app runs on outside Nivaro: a GitHub repository and its Actions secrets, an AWS VPC, database or DNS zone, a Vercel project, an Auth0 application, an Expo project. You give the Hub a connection (the credentials for one account), and from then on every resource of that account the Hub manages is a row it can compare with the provider, change through a reviewed plan, and undo. Wave 1 ships five providers: GitHub (with Actions), Amazon Web Services, Vercel, Auth0 and Expo (EAS).'
    },
    { type: 'h2', id: 'hub-providers-connections', text: 'Connections' },
    {
      type: 'p',
      text: 'A connection is one account at one provider. Administrators create them on the Connections tab of the Apps hub (`/hub/connections`). The form is drawn from the provider’s own list of fields. A field marked secret goes into one sealed secret; every read answers only a mask (`••••••`), a fingerprint and the names of the secret fields that hold a value. Nothing a person types into a secret field is shown again, logged, put in a URL or sent to an AI tool.'
    },
    {
      type: 'ul',
      items: [
        'Test calls the provider: it answers the identity the credentials belong to and which permissions they have and miss. The result and the connection status (Works, Failing, Not tested, Off) are stored.',
        'Outbound calls go only to the hosts the connection’s fields allow (for example `api.github.com`, `api.vercel.com`, `<tenant>.auth0.com`, the AWS endpoints of the regions you allow), https only. A private or link-local address is refused unless the Hub runs with `SSRF_ALLOW_HOSTS`.',
        'Editing: only the secret fields you send change. A masked value keeps the stored one; an empty value clears it (a required secret cannot be cleared). Any change to the credentials or to a field that decides the host (a domain, a region, an account) resets the status to Not tested.',
        'Changing a host-deciding field needs its secrets re-sent: the old secret was sealed for the old host and is not carried over to a new one.',
        'Delete is refused (409 `CONNECTION_IN_USE`) while the connection still has managed resources or a change that is applying or waiting for approval.'
      ]
    },
    { type: 'h3', text: 'Which connections an app may use' },
    {
      type: 'p',
      text: 'Owners never see connection credentials. An administrator sets, per app, the connections its owners may change things through (the "Outside services" card on the app page; `PUT /api/hub/apps/:id/connections`). An owner sees a short summary (id, provider, name, status) of the connections allowed for apps they own, and a connection outside that list answers 404. Creating an app (or a retirement, promotion or creation run) never widens this list by itself, except that a Create app run adds the connections its target and parts name.'
    },
    { type: 'h2', id: 'hub-providers-resources', text: 'Resources, scope and drift' },
    {
      type: 'p',
      text: 'A managed resource is one object at the provider with a row in the Hub: its type (`aws.vpc`, `github.repository` …), the provider’s id, the values the Hub wants (desired), what it last saw (observed), whether it drifted, and the app and environment it belongs to. Each type has a scope.'
    },
    {
      type: 'table',
      head: ['Scope', 'Belongs to', 'Who may change it'],
      rows: [
        [
          '`app`',
          'An app and one of its environments, or the app as a whole (an app-level resource such as a repository, a Vercel project or a workflow).',
          'Administrators; owners through a connection on their app’s allowed list. A ref inside an app resource must point at the same environment, an app-level resource of the same app, or a shared one, never at another environment.'
        ],
        [
          '`shared`',
          'No app: a VPC, subnet, Route 53 zone or other infrastructure several apps point at.',
          'Hub administrators only. Owners cannot see shared resources or changes. Deleting one that another resource still points at is refused with `SHARED_IN_USE`, for everyone, with no override.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Environment rows have a collapsed "Outside resources" summary (count, drifted, gone) that opens to the resources grouped by provider; the Shared infra tab (`/hub/shared-infra`, administrators) lists shared resources by connection with a "Used by N" chip.',
        'Adopt: a resource that already exists at the provider (created by hand, say) is not touched until you adopt it. The "Not managed by the Hub" list on a connection (`GET /api/hub/connections/:id/unmanaged?type=`) shows what the provider has that the Hub does not manage and did not make; Adopt binds one to an app environment or, for administrators, to the shared scope. Adopt writes nothing at the provider. It stores the readable, non-secret values as the desired state, so a later change at the provider shows as drift. Adoption is refused when any connection of the provider already manages it (`RESOURCE_ALREADY_MANAGED`).',
        'Drift: every 15 minutes (cron `hub-resources-observe`, Hub only, one leader at a time) the Hub reads each managed resource, stalest first (up to 300 per connection per tick, four connections at once, a five-minute budget per connection). A value that differs from the desired state sets the drift flag. A resource the provider no longer has shows as gone. An unreadable field is never drift, a failed read keeps the old state, and secret fields drift only when both sides carry a fingerprint and they differ. Each tick first marks changes whose run died as interrupted.',
        'A drifted resource is fixed with Re-apply (put the provider back to the Hub’s values) or Accept (take the provider’s values as the new desired state); both go through the change flow below.',
        'A create that never reached the provider leaves a row with no provider id, shown as "Creating…" or "Create failed". Resume continues it when the engine would; Discard (`POST /api/hub/resources/:id/discard`, two-press) drops the row and closes its failed change as cancelled. Discard makes no provider call, is refused while the change runs (`RESOURCE_BUSY`) and for a resource the provider has (`BAD_STATUS`).'
      ]
    },
    { type: 'h2', id: 'hub-providers-flow', text: 'The change flow' },
    {
      type: 'p',
      text: 'Nothing at a provider changes outside a reviewed plan. A person (or the API) asks for a plan of one or more operations on one connection: create, update, delete, adopt, reapply (put the provider back) or accept (take the provider’s values). The Hub reads the provider, works out what would happen, and stores a planned change. Nothing is written at the provider while planning.'
    },
    {
      type: 'table',
      head: ['Step', 'What happens'],
      rows: [
        [
          'Plan',
          'Access is judged first, before any provider call. Fields are validated against the type, refs are checked, operations are ordered (parents first, deletes last, children before parents). Each existing resource is read once. The plan lists every operation with its reason, the fields that change (old to new; a secret says only that a new value is set), risk flags, gates, blockers and what has to be typed. The plan carries a `planHash` over the operations and what was observed.'
        ],
        [
          'Start',
          'Sends back the hash the person saw. The Hub re-plans from the stored request; if the hash moved the change is marked stale (`STALE_PLAN`) and nothing runs. Then blockers, gates, the typed confirm and approval are checked, the resource locks are taken, and the run continues in the background.'
        ],
        [
          'Steps',
          'Each step re-reads the provider and stops with `PRECONDITION_CHANGED` when what the plan relied on moved. A create inserts its resource row before the call and tags the object with it, so a replayed create finds what it made. Delete and replace take a snapshot first where the type can. Steps record before, after and the provider’s answer with secrets scrubbed.'
        ],
        [
          'Resume',
          'A restart or lost lock leaves the change `interrupted`. Resume replays only steps without a recorded success. A retryable provider failure (rate limit, 5xx, timeout) also offers Resume. A failed precondition is not resumable: plan again. A failure no retry can fix (a refused key, a missing permission) says so and offers "Drop this change" (cancel).'
        ],
        [
          'Undo',
          'Offered on an applied change, only while it is the newest change of its resources. It plans the way back (create becomes delete, update goes back to the stored before-state, delete becomes create from it) as a new planned change that passes every gate again. Adopt and accept are not undone, and a field the type calls non-reversible refuses the undo (`NOT_REVERSIBLE`).'
        ],
        [
          'Cancel, discard',
          'A planned or pending change can be cancelled by an administrator or the person who made it.'
        ]
      ]
    },
    { type: 'h3', text: 'Gates' },
    {
      type: 'p',
      text: 'Each risk flag a plan raises maps to exactly one gate.'
    },
    {
      type: 'table',
      head: ['Flag or situation', 'Gate'],
      rows: [
        [
          '`destructive`, `data_loss`',
          'Typed confirm. One operation: its name. Several: the app key (app scope) or the connection name (shared). An adapter may ask for its own text (an S3 bucket with objects needs `delete all objects in <bucket>`, and only administrators may ask for it).'
        ],
        [
          '`public_exposure`',
          'Administrator. An owner’s change that opens something to the public is a blocker (`ADMIN_ONLY`), not an approval.'
        ],
        ['`downtime`', 'Typed confirm, only in a production environment.'],
        [
          '`cost`',
          'An owner’s change waits as `pending_approval` until a Hub administrator approves it with a matching plan hash (or declines it with a reason). An administrator’s own cost change goes straight through.'
        ],
        [
          'Production environment',
          'The owner production rule of the app (Hub switch and per-app policy): where it says administrators only, an owner’s plan is refused (`PRODUCTION_ADMIN_ONLY`).'
        ],
        [
          'Freezes, deploy windows, checklists, open moves',
          'Judged as the action "Resource changes": `FROZEN`, `OUTSIDE_WINDOW`, the production checklist (opt-in per item), and `MOVE_OPEN` while a move of the environment is open. A shared change names no app, so only Hub-wide freezes stop it. A retired app answers `ENV_ARCHIVED`.'
        ],
        [
          'Who',
          'Plan is open to anyone who passes access (MCP and View-as included: it writes nothing). Start, resume, cancel, approve, decline never run for an MCP tool or under View-as. Approve and decline are administrators; the approval re-plans as the requester, so their access must still hold.'
        ]
      ]
    },
    {
      type: 'h3',
      text: 'Carried changes (promotions, creations, retirements)'
    },
    {
      type: 'p',
      text: 'Some Hub flows make provider changes for you: a promotion (dispatch a workflow, promote a Vercel build), Create app (a repository, an Auth0 application, a DNS record) and a retirement (delete the app’s resources). These use the same engine, never a private call to an adapter. The change records its origin (`promotion`, `creation` or `retirement`, set only by the Hub itself: a request body cannot carry one) and the engine re-judges at plan, start and resume that the originating run is still running, belongs to the same app and environment, and may do this kind of operation. The origin replaces the gates that the run already judged (the promotion’s freeze and window, the retirement’s own freeze), never the others: an incident’s freeze still stops a retirement. A carried change does not claim the resource checklist.'
    },
    { type: 'h3', text: 'Where changes show' },
    {
      type: 'ul',
      items: [
        'Open changes: the Connections and Shared infra tabs list planned, pending approval, applying, failed and interrupted changes (the Connections tab counts those waiting for approval). A row opens `?change=<id>` on the tab, a panel above the tab content that shows the whole change; Close drops the parameter. Notices (approval needed, failed, applied) link there.',
        'Audit: the Hub audit timeline has a Resources category: every `hub-resource-*` action (plan, start, cancel, resume, undo, approve, decline, adopt, discard) and connection action is logged with field names, ids and codes only, never values.',
        'Smoke checks: an applied change that touched a serving type (`vercel.deployment`, `vercel.domain`, `aws.route53_record`, `aws.load_balancer`, `aws.listener`, `aws.target_group`, `aws.rds_instance`) queues the environment’s smoke suite with trigger "Resource change". Carried changes are skipped; their promotion queues its own run.'
      ]
    },
    { type: 'h3', text: 'Rules every adapter follows' },
    {
      type: 'ul',
      items: [
        'A create that finds an object the Hub did not make never patches or binds it: it stops with `ALREADY_EXISTS` and tells you to adopt. The plan shows this as a blocker when the adapter can look it up. A resumed run (its resource row already holds the provider id) is not a collision.',
        'A named operation (dispatch, promote, point, build) checks that its target is the one in the plan, else `TARGET_MISMATCH` or `PROJECT_MISMATCH`.',
        'A pinned account, team, org or tenant is enforced on every read by id, children through their parent: anything outside answers not-found or `<PROVIDER>_OUT_OF_ACCOUNT`.',
        'Any call that sends a plain secret scrubs that value from errors before they are stored or shown.',
        'Provider answers of 429, 5xx or a timeout fail the step as retryable with the provider’s text; a refused key is `AUTH_FAILED` and is not retryable; a missing permission is `FORBIDDEN` or `AccessDenied` and is not retryable.',
        'A secret field is write-only everywhere: observed state keeps a fingerprint only, so a change to the value at the provider cannot be detected as drift.'
      ]
    },
    {
      type: 'note',
      text: 'Tables (migration 582, created everywhere, used only with `HUB=on`; excluded from promote:config): `nivaro_hub_connections`, `nivaro_hub_app_connections`, `nivaro_hub_resources`, `nivaro_hub_resource_changes`. Migration 583 adds three nullable ids used by the flow hooks. Secrets are sealed with the Hub’s `ENCRYPTION_KEY`.'
    }
  ]
}

export const hubProvidersGithubDocs: DocSection = {
  id: 'hub-providers-github',
  label: 'Provider: GitHub and Actions',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-github',
      text: 'Provider: GitHub and Actions — Hub mode only'
    },
    {
      type: 'p',
      text: 'Connection fields: how to sign in (`auth_method` = GitHub App or personal access token), the `owner` (user or organisation) the connection is pinned to, for an app `app_id`, `installation_id` and a secret `private_key`, for a token a secret `token`. The only host is `api.github.com`. Every read by id is checked against the pinned owner. Repository lists try the organisation first, then the user.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`github.repository`',
          '`owner/repo`',
          'Create, update (description, visibility, features), adopt. A delete archives the repository and drops the Hub row; a permanent delete is planned only when the resource asks for destroy (`destructive` + `data_loss`). A public create or a change to public visibility is `public_exposure`.'
        ],
        [
          '`github.branch_protection`',
          '`owner/repo#branch`',
          'Required reviews, status checks and admin enforcement for a branch. Delete is `destructive`.'
        ],
        [
          '`github.environment`',
          '`owner/repo#env`',
          'A deployment environment. Reviewer lists and protection `restrictions` are not modelled. Delete is `destructive` + `data_loss`.'
        ],
        [
          '`github.actions_secret`',
          '`owner/repo#NAME` or `owner/repo@env#NAME`',
          'Repository or environment secret, written as a libsodium sealed box. Updates only when the value changed. Delete is `destructive` + `data_loss`.'
        ],
        [
          '`github.actions_variable`',
          'same shape as a secret',
          'Repository or environment variable (the value is readable and compared).'
        ],
        [
          '`github.workflow`',
          '`owner/repo#file.yml`',
          'No create or delete (adopt it). Enable or disable it, and dispatch a run: a dispatch is a separate operation (`action: dispatch`) driven by the one-shot `dispatch` field, with a ref and inputs. It is cleared after it runs, so a re-apply does not dispatch again.'
        ],
        ['`github.deploy_key`', '`owner/repo#<id>`', 'A writable key is `public_exposure`.'],
        [
          '`github.webhook`',
          '`owner/repo#<id>`',
          'A webhook that is not https is `public_exposure`. A PATCH replaces the config, so the secret is sent whenever it is available.'
        ],
        [
          '`github.team` (shared)',
          '`org#team-slug`',
          'An organisation team: name, description, visibility, parent team. A rename gives the team a new slug, so a new id. Delete is `destructive`. Organisation accounts only.'
        ],
        [
          '`github.team_repo_access`',
          '`owner/repo#team-slug`',
          'One team’s permission (read, triage, write, maintain, admin) on one repository. Admin is `public_exposure`; delete is `destructive`.'
        ],
        [
          '`github.ruleset`',
          '`owner/repo#<id>` or `org#<id>`',
          'A branch or tag ruleset on a repository, or on the organisation when no repository is set. Models reviews, status checks, linear history, signed commits, blocking deletes and force pushes. Rules and bypass actors the Hub does not model are kept as they are on update. Switching a ruleset off or to log-only is `public_exposure`. Task 5’s branch protection stays for older plans.'
        ],
        [
          '`github.environment_secret` / `github.environment_variable`',
          '`owner/repo@env#NAME`',
          'The environment is a reference to a `github.environment`. Same write rules as the repository ones (sealed box, value write-only for secrets).'
        ],
        [
          '`github.environment_protection`',
          '`owner/repo#env`',
          'Required reviewers (`user:login` or `team:slug`, at most 6), wait timer, prevent self-review, deployment branch policy and its patterns, on an existing environment. Fewer reviewers, a shorter wait or any branch allowed is `public_exposure`. Delete clears the protection and keeps the environment. A plain `github.environment` update keeps the reviewers it finds.'
        ],
        [
          '`github.org_secret` / `github.org_variable` (shared)',
          '`org#NAME`',
          'Organisation Actions secret or variable available to private, all or selected repositories (names; the Hub looks up the ids). Available to all repositories is `public_exposure`. Changing a secret’s visibility needs its value again; changing only the repository list of a selected secret does not.'
        ],
        [
          '`github.dependabot_secret`',
          '`owner/repo#NAME`',
          'Repository Dependabot secret, written as a sealed box like an Actions secret.'
        ],
        [
          '`github.runner_group` (shared)',
          '`org#<id>`',
          'A runner group with its visibility, repositories and the public-repositories switch (`public_exposure`). The default group is never deleted. Output `registration_token` (secret, once only): the one-shot field `register_runner` (or `rotate_outputs`) makes a new organisation runner registration token on the next apply; the Hub seals it and it is shown nowhere.'
        ],
        [
          '`github.pages`',
          '`owner/repo#pages`',
          'GitHub Pages: built from a workflow or from a branch and folder, a custom domain, HTTPS enforcement. Turning it on is `public_exposure` (the site is public).'
        ],
        [
          '`github.repo_file`',
          '`owner/repo@branch#path`',
          'One text file (up to 1 MB) committed through the contents API as “Nivaro Hub”, for example `CODEOWNERS` or a workflow. Drift is the content changing in the repository; an update sends the blob id read just before, so a file changed since is not overwritten. A path under `.github/workflows/` or a `CODEOWNERS` file is `public_exposure` (a Hub administrator applies it). Files are adopted by id, not listed. Never put a secret in one.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Risk flags: `public_exposure`, `destructive`, `data_loss` as listed above. GitHub types carry no `cost` flag.',
        'Every id names the account first and is checked against the connection’s pinned owner on every read and write (another account reads as missing, a write is refused `GITHUB_OUT_OF_ACCOUNT`); parents are checked too.',
        'Organisation types (teams, organisation secrets and variables, runner groups, organisation rulesets) need an organisation account; on a user account they answer “organisation accounts only”.',
        'Permissions the connection test checks for the new types: a GitHub App needs members, organization secrets, organization variables, organization self-hosted runners, Dependabot secrets, Pages and Contents (write); a classic token needs `admin:org` for the organisation types.',
        'Names containing `#` or `@` are not supported in ids (and a branch with either cannot be used by a managed file).',
        'Used by Create app (the GitHub target kind: repository from a template, an environment and the CI secrets, the deploy workflow), by promotions (component kind `github_actions`: a dispatch with the input `version`) and by retirements. See Outside services in Hub flows.',
        'Needs a live check: nothing ran against real GitHub yet. Response shapes are from the documentation; the environment-secrets path and the installation-permission map for an app token are the first things to confirm on a throwaway organisation.'
      ]
    }
  ]
}

export const hubProvidersAwsDocs: DocSection = {
  id: 'hub-providers-aws',
  label: 'Provider: Amazon Web Services',
  content: [
    { type: 'h1', id: 'hub-providers-aws', text: 'Provider: Amazon Web Services — Hub mode only' },
    {
      type: 'p',
      text: 'The adapter signs AWS requests itself (SigV4, no SDK) and talks to exact per-region endpoints only: `ec2`, `rds`, `elasticloadbalancing`, `sts`, `acm`, `s3` and `monitoring` (CloudWatch) for each region you allow, plus `route53.amazonaws.com` and the Price List endpoint `api.pricing.us-east-1.amazonaws.com`. S3 is path-style, so no wildcard host is needed. Commercial partition only.'
    },
    {
      type: 'p',
      text: 'Connection fields: `account_id`, `regions` (the list the connection may use; the first is the default), `access_key_id`, secret `secret_access_key`, optional secret `session_token`, optional `role_arn` and secret `external_id`. With a `role_arn` set, the keys are only used to assume that role (STS AssumeRole with the external id); the session keys are cached per connection and scrubbed. The region picker on a resource form offers the connection’s regions only. Test probes a permission per service and lists what is missing.'
    },
    { type: 'h2', id: 'hub-providers-aws-net', text: 'Networking and compute' },
    {
      type: 'table',
      head: ['Type', 'Scope', 'Notes'],
      rows: [
        ['`aws.vpc`', 'shared', 'CIDR, DNS support and hostnames.'],
        ['`aws.subnet`', 'shared', 'In a VPC; availability zone fixed at create.'],
        [
          '`aws.route_table`',
          'shared',
          'Manages routes through an internet gateway or NAT gateway ref (0.0.0.0/0; the internet gateway wins) plus a `routes` list, and deletes only routes it made. Route and target changes are `downtime`.'
        ],
        ['`aws.internet_gateway`', 'shared', 'Attached to a VPC.'],
        [
          '`aws.nat_gateway`',
          'shared',
          'Has a `cost` flag; the create waits until it is available.'
        ],
        [
          '`aws.network_acl`',
          'shared',
          'Removing a subnet re-associates it with the VPC’s default ACL.'
        ],
        [
          '`aws.elastic_ip`',
          'shared',
          'Allocation and association; changes are `downtime`; `cost` flag.'
        ],
        [
          '`aws.security_group`',
          'app or shared',
          'Rules compared as sets (descriptions written on add, not compared). Adding an ingress rule open to 0.0.0.0/0 or ::/0 is `public_exposure`, except exactly tcp 80 and 443; all-protocol, a port range or ICMP counts. A group is also found by name inside the VPC on create.'
        ],
        [
          '`aws.ec2_instance`',
          'app',
          'Instance type change is `downtime`; `cost` above the t3.small class on create, replace or a raise. Delete is `data_loss`. `user_data` is write-only.'
        ],
        [
          '`aws.ebs_volume`',
          'app',
          'Grow only: a smaller size is refused at plan (`VOLUME_SHRINK_REFUSED`). `cost` for io1/io2 or gp3 above 3000 IOPS or 125 MiB/s. Delete is `data_loss`.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-aws-data', text: 'Data and edge' },
    {
      type: 'table',
      head: ['Type', 'Scope', 'Notes'],
      rows: [
        [
          '`aws.rds_instance`',
          'app',
          'Create, replace, multi-AZ on and a class change carry `cost`; a class or version change is `downtime`; delete and replace are `data_loss` and always take a final snapshot (never skipped). Shrinking storage is refused (`STORAGE_SHRINK_REFUSED`). The master password is a secret field. An instance can be linked as a Hub database server (see Hub flows).'
        ],
        [
          '`aws.rds_subnet_group`, `aws.rds_parameter_group`',
          'app or shared',
          'Names are the ids.'
        ],
        [
          '`aws.s3_bucket`',
          'app',
          'Public access block, versioning, default encryption and tags. Deleting a bucket that is not empty fails with `BUCKET_NOT_EMPTY`; an administrator may plan the delete with "delete all objects", which needs the typed text `delete all objects in <bucket>` and is `data_loss`. Lifecycle rules are not modelled.'
        ],
        [
          '`aws.route53_zone`, `aws.route53_record`',
          'shared (zone), app (record)',
          'Global, listed once. A record id is `<zoneId>|<name>|<type>`. Records have no tags, so a create uses CREATE and never UPSERT: an existing record is `ALREADY_EXISTS` and must be adopted.'
        ],
        [
          '`aws.load_balancer`, `aws.target_group`, `aws.listener`',
          'app',
          'Load balancer carries `cost`; target and listener changes are `downtime`. Listener rules are not modelled.'
        ],
        [
          '`aws.acm_certificate`',
          'app',
          'DNS validation: the adapter creates the validation records and waits (bounded). The validation records are left in place on delete because certificates can share them.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Ids are AWS ids; ELB and ACM use ARNs, S3 the bucket name, RDS the identifier. Every type has a required `region` that cannot change after create (Route 53 types are global). With no region set, listing walks every allowed region.',
        'The Hub tags what it makes with `nivaro-hub:resource=<row id>`, `nivaro-hub:managed=true` and a name. A create that finds a same-named object with a different or no Hub tag stops with `ALREADY_EXISTS`; AWS duplicate-name errors map to the same code. Nothing is changed on a match. The plan cannot see name collisions: they show when the step runs.',
        'A refused or expired key is `AUTH_FAILED` (not retryable); `AccessDenied` is a missing permission, also not retryable.',
        'Waits are bounded polling where a dependent needs them (NAT available, instance state, volume available, RDS gone on replace); other creates return a pending status. Allow one to two minutes per step.',
        'Needs a live check: nothing ran against real AWS or LocalStack. Fixtures are hand-written from the documented shapes; request shapes (query parameter names, S3 and Route 53 bodies, Content-MD5 rules) need one run on a throwaway account.'
      ]
    },
    { type: 'h2', id: 'hub-providers-aws-costs', text: 'Cost estimates and measured traffic' },
    {
      type: 'p',
      text: 'EC2 instances, EBS volumes, NAT gateways, Elastic IPs, RDS instances, load balancers, S3 buckets and Route 53 zones show a list-price estimate in a plan; ACM public certificates are free. Prices come from the AWS Price List (`GetProducts`), are cached for seven days and fall back to a bundled table with its date when AWS cannot be read. A month is 730 hours. Data transfer out, NAT data processed and cross-zone data are separate lines from the traffic figure; S3 counts the bucket size CloudWatch reports.'
    },
    {
      type: 'p',
      text: 'Two optional read permissions turn the live prices and measured traffic on. The connection test shows a row for each and a missing one never fails the connection. Measured data out (EC2 `NetworkOut`, NAT `BytesOutToDestination`, load balancer `ProcessedBytes`, S3 `BytesDownloaded` where request metrics are on) is read in one batched CloudWatch call per connection and region, at most once an hour, because AWS bills CloudWatch by the metric.'
    },
    {
      type: 'pre',
      code: '{\n  "Version": "2012-10-17",\n  "Statement": [\n    {\n      "Sid": "NivaroHubCostEstimates",\n      "Effect": "Allow",\n      "Action": ["pricing:GetProducts", "cloudwatch:GetMetricData"],\n      "Resource": "*"\n    }\n  ]\n}'
    }
  ]
}

export const hubProvidersVercelDocs: DocSection = {
  id: 'hub-providers-vercel',
  label: 'Provider: Vercel',
  content: [
    { type: 'h1', id: 'hub-providers-vercel', text: 'Provider: Vercel — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `teamId` (`team_…`, every call carries it) and a secret `token`. The only host is `api.vercel.com`. Vercel cannot list a token’s scopes, so Test reads the team and a projects list and infers write permission from your membership role (owner, member or developer). Vercel has no resource tags.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`vercel.project`',
          '`prj_…`',
          'Name, framework, root directory, build, install and output commands, Node version, linked repository (set at create only). Delete is `destructive` + `data_loss`; not reversible.'
        ],
        [
          '`vercel.env_var`',
          '`<projectId>/<envId>`',
          'Key, secret value, type, targets and git branch. Changing the key, type or project is one `replace`: the new value must be present before the old variable is deleted. The value is write-only (never in observed state), so only "changed" is a signal. An existing variable with the same key, overlapping target and branch is updated instead of duplicated. Delete or replace is `destructive`.'
        ],
        [
          '`vercel.domain`',
          '`<projectId>/<domain>`',
          'Add a domain with an optional redirect and branch. Create is `public_exposure`; delete or replace is `destructive` + `downtime`.'
        ],
        [
          '`vercel.deployment`',
          '`dpl_…`',
          'No create or delete (Git and CI make deployments): adopt and update only. The resource means "this deployment should be the live production one". A promote or rollback is a named operation with the mode on the field; the alias switch is asynchronous, so the answer is the state read just after the call. A promote or rollback is `downtime` only when the target build is not ready or its checks failed. Not reversible: undo is a new rollback you plan yourself.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Used by promotions (component kind `vercel`: the newest managed deployment of the target environment that is not live yet is promoted; a rollback uses the deployment row the environment recorded for the version) and Create app.',
        'Needs a live check: endpoint paths and versions were written from the Vercel REST documentation and not run. Confirm the promote and rollback paths and what the "ready substate" reports first, on a throwaway team.'
      ]
    }
  ]
}

export const hubProvidersAuth0Docs: DocSection = {
  id: 'hub-providers-auth0',
  label: 'Provider: Auth0',
  content: [
    { type: 'h1', id: 'hub-providers-auth0', text: 'Provider: Auth0 — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `domain` (a lower-case host, no scheme, port, path, wildcard, IP or localhost; an invalid domain allows no call at all), `client_id`, secret `client_secret` of a machine-to-machine application, and an optional `audience` (default `https://<domain>/api/v2/`). The Hub mints a Management API token, caches it per connection and mints again once on a 401. Test reads the scopes from the token; if it cannot, it probes read paths and reports writes as missing.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`auth0.application`',
          '`client_id`',
          'Name, type, callbacks, logout URLs, allowed origins and web origins. Tags are kept in client metadata. Delete or replace is `destructive` + `downtime`. A URL list that gains a wildcard or a non-local http address is `public_exposure`. The client secret, signing keys and JWT configuration are never copied into observed state.'
        ],
        [
          '`auth0.api`',
          'resource-server id',
          'A resource server (identifier, scopes, signing algorithm). The identifier cannot change (replace). A signing algorithm change is `downtime`; delete is `destructive`.'
        ],
        [
          '`auth0.connection_binding`',
          '`<connection_id>:<client_id>`',
          'Enables an existing Auth0 connection for one application (`PATCH /connections/{id}/clients`). Delete or replace is `downtime`.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'A create that finds an API with the same identifier or an enabled application–connection pair stops with `ALREADY_EXISTS`. Applications are not name-unique, so only the Hub’s own tag identifies one; a resumed create finds it by that tag and returns it unchanged.',
        'Used by Create app: an Auth0 application whose callbacks, logout URLs and origins default to the environment’s address (`<base>/api/auth/callback`).',
        'Needs a live check: the connection-clients endpoint shape and its pagination are from documentation only.'
      ]
    }
  ]
}

export const hubProvidersExpoDocs: DocSection = {
  id: 'hub-providers-expo',
  label: 'Provider: Expo (EAS)',
  content: [
    { type: 'h1', id: 'hub-providers-expo', text: 'Provider: Expo (EAS) — Hub mode only' },
    {
      type: 'warn',
      text: 'The Expo adapter’s GraphQL documents are written from memory of the EAS schema and were never run against a real account. Several are marked unverified in the code (apps listing, app creation and deletion, environment variables, build reads, and the build trigger). Treat this provider as a preview until it has had a live check on a throwaway Expo account.'
    },
    {
      type: 'p',
      text: 'Connection fields: `account` (the Expo account or organisation name) and a secret `token`. The only host is `api.expo.dev`. Ids are the EAS app id for a project; branch, channel, environment variable and build use `<appId>:<entityId>` so a read knows which app to ask.'
    },
    {
      type: 'table',
      head: ['Type', 'What it does'],
      rows: [
        [
          '`expo.project`',
          'Create (privacy is set at create only), rename (a replace) and delete. Delete or replace is `destructive` + `data_loss`.'
        ],
        ['`expo.branch`', 'An update branch. Rename is a replace; delete is `destructive`.'],
        [
          '`expo.channel`',
          'An update channel pointing at a branch. Creating with a branch points it at once. Changing only the branch is `update` with the named operation `point`, read-before-write (skipped when it already points there). Delete is `destructive`.'
        ],
        [
          '`expo.env_var`',
          'Name, secret value, visibility (plaintext, sensitive or secret) and environments (development, preview, production). The value is write-only. Delete is `destructive`.'
        ],
        [
          '`expo.build`',
          'Create carries the named operation `build` (platform, profile, git ref); an existing build is only read, never started again. No update or delete.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Used by promotions (component kind `eas_update`: the branch the previous environment’s same-named channel points at becomes this environment’s channel target).',
        'No `cost` flag: EAS has no monthly resource here.',
        'The build trigger is a placeholder. EAS normally starts a build from an uploaded project archive through eas-cli, so before release it needs a real mechanism (a GitHub-linked build or a workflow run).',
        'Test checks that the account is reachable; EAS offers no cheap per-type permission probe.'
      ]
    }
  ]
}

export const hubProvidersSentryDocs: DocSection = {
  id: 'hub-providers-sentry',
  label: 'Provider: Sentry',
  content: [
    { type: 'h1', id: 'hub-providers-sentry', text: 'Provider: Sentry — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `host` (`sentry.io`, `us.sentry.io`, `de.sentry.io`, or a self-hosted name: a plain lower-case host, https only, no IP address or localhost; private addresses pass only through `SSRF_ALLOW_HOSTS`), `organization` (the slug; pinned, every call is scoped to it) and a secret auth token (an organization-level internal integration is preferred). Test reads the organization and the token\u2019s scopes; a token that does not list its scopes is probed with a read and every write is reported missing.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`sentry.team`',
          'slug',
          'Shared (Hub admins only). A slug change is a replace; delete is `destructive`.'
        ],
        [
          '`sentry.project`',
          'slug',
          'One per app. Name and platform change in place; the slug and the owning team are set at create. A project is made without Sentry\u2019s default alert rule, so the Hub\u2019s alerts are the only ones. Delete or replace is `destructive` + `data_loss`.'
        ],
        [
          '`sentry.client_key`',
          '`<project>/<key id>`',
          'A DSN holder. Name, active switch and rate limit change in place. Delete is `destructive` + `downtime`; switching it off is `downtime`. Declares the output `dsn`.'
        ],
        [
          '`sentry.issue_alert`',
          '`<project>/<rule id>`',
          'Conditions, filters and actions are lists of `{id, settings}` (the rule class id and its remaining values). Sentry\u2019s display names and uuids are ignored when comparing.'
        ],
        [
          '`sentry.metric_alert`',
          'rule id',
          'Projects, measure, query, time window and one or two triggers (critical, warning) with their notify actions.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-sentry-dsn', text: 'The DSN is an output' },
    {
      type: 'p',
      text: 'The client key hands out its public DSN as the output `dsn` (not secret, shown again by Sentry, so it is never once-only). It is sealed by the Hub and never appears in observed or desired state, a plan, a step or a log. Bind it to the environment so the app reports to its own project.'
    },
    {
      type: 'warn',
      text: 'Bind the DSN to a stack setting or stack secret named `SENTRY_DSN`, not to the app setting `sentry_dsn`. A Nivaro app has no `sentry_dsn` setting, so the hub link answers `409 SETTING_NOT_ON_THIS_APP` for it. A stack binding only saves the stack\u2019s settings: the stack then shows it needs Apply now, and nothing deploys by itself.'
    },
    { type: 'h2', id: 'hub-providers-sentry-releases', text: 'Releases and health' },
    {
      type: 'ul',
      items: [
        'A project may record a release and one deploy for an environment: fill `release_version`, `release_environment` (and optionally `release_url`) and set `record_release`. The named op `release` reads first, creates the release only if it does not exist for the project (Sentry answers 208 for an existing one) and the deploy only if that environment has none yet. The version and environment come from the resource, never from the plan data, and the op refuses a project that is not the resource\u2019s own (`TARGET_MISMATCH`). A promotion runs it once the promote hook is wired.',
        'Health on a project: unresolved issues seen in the last 24 hours, in total and for up to five environments (warning from 50). A disabled client key reads as a warning. The figures sit beside the Hub Issues tab.',
        'A create that finds a team or project with that slug, or a key or alert with that name, stops with `ALREADY_EXISTS`: adopt it instead. No type is costed: Sentry bills the organization plan, not each resource.',
        'Needs a live check: endpoint paths, the token scopes each call needs, the alert rule shapes (including the newer detector-based alerts) and the `X-Hits` count are written from the Sentry API documentation and were not run against a real organization.'
      ]
    }
  ]
}

export const hubProvidersHooksDocs: DocSection = {
  id: 'hub-providers-hooks',
  label: 'Outside services in Hub flows',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-hooks',
      text: 'Outside services in Hub flows — Hub mode only'
    },
    { type: 'warn', text: HUB_ONLY },
    {
      type: 'p',
      text: 'Create app, promotions, DNS, database servers and retirements can use provider resources. Every provider write they make is a carried change through the engine (see The change flow): the same plan, gates and audit, and a change id you can open from the run. No flow calls an adapter directly. Migration 583 adds `nivaro_hub_db_servers.resource_id`, `nivaro_hub_targets.connection_id` and `nivaro_hub_components.resource_id`, each only where the table exists.'
    },
    { type: 'h2', id: 'hub-providers-hooks-create', text: 'Create app' },
    {
      type: 'ul',
      items: [
        'A new creation step `providers` follows `database` in every order (in-flight creations get it as a pending step; with nothing to make it finishes at once). The request field `environments[].providers` lists up to six parts per environment as `{connection_id, type, fields?}`; the allowed types are `vercel.project`, `auth0.application`, `aws.route53_record` and `aws.rds_instance` (`BAD_PROVIDER_PART` otherwise). An Auth0 application’s callbacks, logout URLs and origins default to the environment’s address.',
        'The parts are validated and sealed at the start (an RDS master password may be one of the fields) and never answered back. A part the environment already has (same type, connection and name) is not made twice, so a retry makes nothing new. The route 53 record is added with the app name; an RDS instance is made but not linked as a database server (do that on the Databases tab).',
        'The connections the target and parts name are added to the new app’s allowed list.',
        'GitHub target: a target of kind `github` (stored in `nivaro_hub_targets` with a `connection_id`, no secret of its own; Test checks the connection’s fit) makes the app from a template repository. Its steps are database, providers, repository (app-level `github.repository` from the template), variables (a `github.environment` named for the environment key, the five secrets a GitLab target keeps as CI variables, base64, plus the variables `NIVARO_APP_ENV`, `NIVARO_VERSION` and `NIVARO_IMAGE_PIN`; an existing secret is never replaced), deploy (adopts the deploy workflow, records one `github_actions` component `api`, dispatches it with inputs `version` and `environment`), name, link, admin and template. Target settings: template, visibility (private or internal), deploy workflow, source branch, DNS mode, wildcard domain, edge address, scheme, port and a certificate note. The template workflow must declare the `version` and `environment` inputs.'
      ]
    },
    { type: 'h2', id: 'hub-providers-hooks-promote', text: 'Promotions' },
    {
      type: 'table',
      head: ['Component kind', 'Resource', 'What a promote does', 'What a rollback does'],
      rows: [
        [
          '`github_actions`',
          '`github.workflow`',
          'Dispatches the workflow on the target (or source) branch with the input `version`.',
          'Dispatches with the older version.'
        ],
        [
          '`vercel`',
          '`vercel.project`',
          'Promotes the newest managed `vercel.deployment` of the target environment that is not live yet. Adopt the build on the Resources panel first, or the step is blocked.',
          'Promotes the deployment row this environment recorded for the version.'
        ],
        [
          '`eas_update`',
          '`expo.channel`',
          'Points the channel at the branch the previous environment’s same-named channel points at (app-level or this environment’s).',
          'Points it at the recorded branch.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'A provider component is saved with the resource it deploys through (`resource_id`); it must be live, of the right type, and belong to the placement’s app or one of its environments (`BAD_RESOURCE`). Provider components store driver 0 and skip the driver-kind rules. A step with no usable target is a blocker `PROVIDER_NOT_READY` with the reason.',
        'The step runs one carried change (origin `promotion`) acting for the person who started the deploy, and the engine re-judges it. The provider ref is recorded as the deployed ref and the change as the deploy’s change; verify works as for an API component. Provider steps add their facts to the plan hash only when present, so every existing plan hash is unchanged.',
        'GitHub Actions environment approval (pending deployments) is not built. Only `workflow_dispatch` is.'
      ]
    },
    { type: 'h2', id: 'hub-providers-hooks-dns', text: 'Route 53 DNS' },
    {
      type: 'p',
      text: 'A Docker driver, a GitLab target or a GitHub target can set DNS mode `route53` with a `dns_zone_resource_id`. It needs the wildcard domain and an edge address or target. Names are then made automatically, like the wildcard modes. The zone must be a live, shared, managed `aws.route53_zone` whose name covers the wildcard domain (`DNS_ZONE_MISSING` otherwise). The providers step creates the record: an IP becomes A or AAAA, a name becomes CNAME, TTL 300.'
    },
    { type: 'h2', id: 'hub-providers-hooks-db', text: 'RDS as a database server' },
    {
      type: 'p',
      text: 'A Hub database server can be linked to a managed `aws.rds_instance` (`resource_id`). Its engine must match the instance (`ENGINE_MISMATCH`), and its host and port are filled from what the Hub observed (`BAD_RESOURCE` while the instance has no endpoint yet; the host may then be left empty). Deleting a linked instance is refused with `SHARED_IN_USE` while the server holds a database of another app or one not tied to an environment.'
    },
    { type: 'h2', id: 'hub-providers-hooks-retire', text: 'Retirement' },
    {
      type: 'p',
      text: 'The retirement plan lists the app’s provider resources on its remove lines (the list is not part of the plan hash: the live list is deleted at run time). After the stacks are removed, the remove step plans one carried delete per connection and environment, in the plan’s environment order, then archived environments, then the app-level group. Shared resources are never deleted. Retry picks each change up again. It needs an active administrator as signer (`ADMIN_REQUIRED`), and the typed app key on the remove sign-off is the confirmation. Every other freeze, an incident’s for one, still stops it.'
    }
  ]
}

export const hubProvidersApiDocs: DocSection = {
  id: 'hub-providers-api',
  label: 'Outside services API (REST, GraphQL, SDK, MCP)',
  content: [
    { type: 'h1', id: 'hub-providers-api', text: 'Outside services API — Hub mode only' },
    { type: 'warn', text: HUB_ONLY },
    {
      type: 'p',
      text: 'The provider routes are in the Hub API catalog like every other Hub route: listed in the instance’s OpenAPI document under the group "Providers", tagged "Hub mode only", with API-key scopes `hub:read` (lists and `POST /resources/plan`) and `hub:write` (everything else). See Hub API for the scopes, who sees what, and the shared rules.'
    },
    { type: 'h2', id: 'hub-providers-api-rest', text: 'REST' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          'GET /api/hub/provider-types',
          'Signed in',
          'Registered providers: connection fields, resource types with fields, capabilities, reversibility, refs, and the risk vocabulary. Never connection data.'
        ],
        [
          'GET /api/hub/connections',
          'Admin: all. Owner: those allowed for their apps (summary only)',
          'Connections (`?provider=`). Answers `field_options` (the lists a form offers, such as regions).'
        ],
        ['POST /api/hub/connections', 'Admin', '`{provider, name, config, secrets}`. 201.'],
        [
          'GET | PATCH | DELETE /api/hub/connections/:id',
          'Read: owner of an allowed app. Write: admin',
          'PATCH merges `config`, changes only the secrets sent. DELETE: 409 `CONNECTION_IN_USE`.'
        ],
        ['POST /api/hub/connections/:id/test', 'Admin', 'Calls the provider; stores the result.'],
        [
          'GET /api/hub/connections/:id/unmanaged?type=&cursor=',
          'Admin',
          'What the provider has that the Hub does not manage.'
        ],
        [
          'POST /api/hub/connections/:id/adopt',
          'Owner (own app), admin',
          '`{type, externalId, scope, appId?, environmentId?}`. 201. Shared scope is admin only.'
        ],
        [
          'GET | PUT /api/hub/apps/:id/connections',
          'Read: owner. PUT: admin',
          '`{connection_ids}`: exactly these are allowed.'
        ],
        [
          'GET /api/hub/resources, GET /api/hub/resources/:id',
          'Owner (own apps), admin',
          'Filters `app`, `environment`, `provider`, `connection`, `type`, `drift=1`, `scope`. A row with no provider id carries `pending_create`.'
        ],
        [
          'POST /api/hub/resources/:id/discard',
          'Owner (own app), admin',
          'Drop a create that never reached the provider.'
        ],
        [
          'POST /api/hub/resources/plan',
          'Owner, admin (`hub:read` is enough)',
          '`{connectionId, scope, appId?, environmentId?, ops[]}`. Answers a plan: `changeId`, `planHash`, `ops`, `gates`, `needsConfirm`, `needsApproval`, `blockers`. Writes nothing at the provider.'
        ],
        [
          'GET /api/hub/resource-changes, GET …/:id',
          'Owner (own apps), admin',
          'Filters `app`, `environment`, `connection`, `scope`, `status` (comma list), `limit`, `before`.'
        ],
        [
          'POST /api/hub/resource-changes/:id/start',
          'Owner, admin',
          '`{planHash, confirm?}`. 202. Never from MCP or View-as.'
        ],
        [
          'POST …/:id/cancel · resume · undo',
          'Owner (the requester), admin',
          'Cancel an unstarted or failed change, replay unfinished steps (202), plan the way back (answers a new plan).'
        ],
        ['POST …/:id/approve · decline', 'Admin', '`{planHash}` (202) · `{reason}`.']
      ]
    },
    {
      type: 'p',
      text: 'Answers carry the route’s `data` envelope. A refusal carries a code: `STALE_PLAN`, `CONFIRM_MISMATCH`, `FROZEN`, `OUTSIDE_WINDOW`, `MOVE_OPEN`, `CHECKLIST_REQUIRED`, `CONNECTION_NOT_ALLOWED`, `SHARED_ADMIN_ONLY`, `SHARED_IN_USE`, `PRODUCTION_ADMIN_ONLY`, `ADMIN_ONLY`, `RESOURCE_BUSY`, `PRECONDITION_CHANGED`, `ALREADY_EXISTS`, `NOT_REVERSIBLE`, `ORIGIN_INVALID`, `HUB_WRITE_NOT_FOR_AGENTS`, `DELEGATED_NO_WRITE` and others; a provider failure is 502 `PROVIDER_ERROR` or `AUTH_FAILED`. Secret fields are never answered: a connection shows a mask, a fingerprint and the secret field names; a stored change shows secrets as `{secret: true, fingerprint}` and never carries a sealed value.'
    },
    { type: 'h2', id: 'hub-providers-api-graphql', text: 'GraphQL' },
    {
      type: 'p',
      text: 'The `hub` namespace gains reads: `providerTypes`, `connections(provider)`, `connection(id)`, `connectionUnmanaged(id, type, cursor)`, `appConnections(appId)`, `resources(app, environment, provider, connection, type, drift, scope)`, `resource(id)`, `resourceChanges(app, environment, connection, scope, status, limit, before)` and `resourceChange(id)`, and one mutation, `planResourceChanges`, which is a plan and writes nothing at the provider. Starting, cancelling, approving and every connection write are REST only, as for promotions. The answers are the REST answers as they are (JSON), with secrets masked.'
    },
    { type: 'h2', id: 'hub-providers-api-sdk', text: 'SDK' },
    {
      type: 'p',
      text: '`nivaro.hub.*` (and the command builders in `hubCommands`) covers every route: `listProviderTypes`, `listConnections`, `readConnection`, `createConnection`, `updateConnection`, `deleteConnection`, `testConnection`, `listUnmanaged`, `adoptResource`, `appConnections`, `setAppConnections`, `listResources`, `readResource`, `planResources`, `listResourceChanges`, `readResourceChange`, `startResourceChange`, `cancelResourceChange`, `resumeResourceChange`, `undoResourceChange`, `approveResourceChange` and `declineResourceChange`. `startResourceChange(id, {planHash, confirm})` takes the hash from the plan you just read.'
    },
    {
      type: 'pre',
      code: "const plan = await nivaro.hub.planResources({\n  connectionId: 3,\n  scope: 'app',\n  appId: 7,\n  environmentId: 21,\n  ops: [{ action: 'create', type: 'vercel.project', fields: { name: 'web', framework: 'nextjs' } }]\n})\nif (plan.blockers.length === 0) {\n  await nivaro.hub.startResourceChange(plan.changeId, {\n    planHash: plan.planHash,\n    confirm: plan.needsConfirm ?? undefined\n  })\n}"
    },
    { type: 'h2', id: 'hub-providers-api-mcp', text: 'MCP' },
    {
      type: 'p',
      text: 'Four read and plan tools, available to every signed-in person (the route decides what that person may see): `hub_list_connections`, `hub_list_resources`, `hub_read_resource_change` and `hub_plan_resources`. The plan answer has secret-looking keys stripped and links to `/hub/connections?change=<id>`, where a person starts it. Starting, resuming, cancelling, undoing, approving, declining and every connection write are refused for an agent with `HUB_WRITE_NOT_FOR_AGENTS`, and View-as and run-as keys never write either.'
    }
  ]
}
