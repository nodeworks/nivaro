import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: GitLab as a full provider. Facts are from the merged code:
// api/src/services/hub/providers/gitlab/** (client, specs, resources, plan, index, pricing).
// Nothing here ran against a live GitLab yet: the section says what still needs one live check.

export const hubProvidersGitlabDocs: DocSection = {
  id: 'hub-providers-gitlab',
  label: 'Provider: GitLab',
  content: [
    { type: 'h1', id: 'hub-providers-gitlab', text: 'Provider: GitLab — Hub mode only' },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). This is the full GitLab provider: projects, protections, environments, CI/CD variables, deploy tokens and keys, webhooks, pipeline schedules and runners. The Hub’s older GitLab code (drivers, promotions) keeps working with its own tokens; a target for new apps may use a GitLab connection instead of its own token (below).'
    },
    {
      type: 'h2',
      id: 'hub-providers-gitlab-targets',
      text: 'Targets that use a GitLab connection'
    },
    {
      type: 'p',
      text: 'On the Targets tab a GitLab target signs in to GitLab with its own token or with a GitLab connection (`connection_id`). With a connection the target keeps no token and no address: they are read from the connection each time, and the target’s namespace and template must sit inside the connection’s pinned group. Each app created on the target has a driver with its own sealed copy of the token.'
    },
    {
      type: 'ul',
      items: [
        'A new token on the connection (PATCH `secrets.token`) reaches every app’s driver made from a target that uses it, through the same path as a target token rotation: only a driver that still holds the previous token at the previous address is changed, then the app’s CI settings are pushed again. The answer carries `target_sync` (one entry per target, the same per-app results as a target save).',
        'A new address needs the token typed again in the same request (`SECRET_REQUIRED_ON_HOST_CHANGE`, as for every connection); the drivers then move to the new address together with the token, never one without the other.',
        'A `groupPath` or address that would leave a target outside (namespace or template no longer inside the group, or no usable https address) is refused with 409 `CONNECTION_IN_USE`; change the target first.',
        'Delete is refused with 409 `CONNECTION_IN_USE` while any Hub target (GitLab or GitHub) names the connection.',
        'Disabling the connection stops new apps on its targets; the target’s Test says why. Targets are administrators’ only, and a target’s connection is never added to an app’s allowed connections.'
      ]
    },
    {
      type: 'p',
      text: 'Connection fields: `baseUrl` (`https://gitlab.com` or your self-hosted address; https only, an install under a path such as `/gitlab` works), `groupPath` (the full path of ONE top-level group this connection is pinned to) and a secret `token`. A group access token with the `api` scope and the Maintainer role is preferred; a project access token or a personal access token also works. The only host is the one in `baseUrl`. A self-hosted address on a private network is refused unless `SSRF_ALLOW_HOSTS` on the Hub lists it (the same rule as Hub GitLab targets). The token goes in an `Authorization: Bearer` header and is dropped on a redirect to another host. Test reads the token user, the pinned group, the token’s scopes (`/personal_access_tokens/self`) and the token user’s role in the group: write needs the `api` scope and the Maintainer role, and a token that cannot describe its own scopes is not proven for writes.'
    },
    {
      type: 'note',
      text: 'The pinned group is enforced on every read by id: a project, group or runner outside it reads as "gone" (never as another team’s data), and a change against one stops with `GITLAB_OUT_OF_ACCOUNT`. Children (variables, tokens, hooks, branches…) are judged through their project or group. A template project for "create from template" must be inside the group too.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`gitlab.group`',
          '`<group id>`',
          'Shared, read and adopt only: the Hub never creates, changes or removes a group.'
        ],
        [
          '`gitlab.project`',
          '`<project id>`',
          'Name, URL path, description, visibility, default branch, group (a `gitlab.group` ref; empty = the pinned group). Create from a built-in template (`templateName`) or from a project in the group (`templateProject`). Public visibility is `public_exposure`. Removing the resource ARCHIVES the project (read-only, nothing lost). Setting `destroy` and applying deletes it for good — `destructive` + `data_loss`, typed confirm.'
        ],
        [
          '`gitlab.protected_branch`',
          '`<project>/<branch>`',
          'Branch name or wildcard, who may push, who may merge, force push, code owner approval. Removing a protection is `destructive`. Changing who may push or merge uses GitLab’s access-list update, which is a Premium feature: on Free the answer says so plainly.'
        ],
        [
          '`gitlab.environment`',
          '`<project>/<environment id>`',
          'Name, address and tier. Removing stops the environment first (GitLab only removes a stopped one); if the stop job is still running the step fails as retryable.'
        ],
        [
          '`gitlab.protected_environment`',
          '`<project>/<name>`',
          'Who may deploy and an approval rule (role + number of approvals; approvals are Premium). A change destroys the old rule by id and adds the new one in the same request, so there is no gap. Removing is `destructive`.'
        ],
        [
          '`gitlab.ci_variable`',
          '`project:<id>:<key>:<scope>` or `group:<id>:<key>:<scope>`',
          'Project or group level (one of the two), masked, protected, raw, file or variable, environment scope. The value is write-only: it is never read into observed state, so only "changed" is a signal. A new key, scope or project is one `replace`, and the new value must be at hand before the old variable goes. An existing variable with the same key and scope that the Hub did not make is never overwritten: adopt it. Removal is `destructive`.'
        ],
        [
          '`gitlab.deploy_token`',
          '`project:<id>:<token id>` or `group:<id>:<token id>`',
          'Name, scopes, expiry, user name. GitLab shows the token once: output `token` (secret, once-only) and `username`. Nothing changes in place; a new name, scopes or expiry is a `replace` (new token first, old one removed after, `downtime`). The Make a new token now switch (`rotate_outputs`) does the same without a field change. If removing the old token fails, the new value is still kept and the answer names the old token left in place.'
        ],
        [
          '`gitlab.deploy_key`',
          '`<project>/<key id>`',
          'Title, public key (a new key is a replace) and "may push". The public key is not a secret. A key already on the project is not taken over.'
        ],
        [
          '`gitlab.webhook`',
          '`<project>/<hook id>`',
          'https address, events, certificate verification and a secret token. The token is write-only (compared by fingerprint, scrubbed from every error). A hook with the same address that the Hub did not make is not taken over. GitLab turning a hook off after failures shows as health `down`.'
        ],
        [
          '`gitlab.pipeline_schedule`',
          '`<project>/<schedule id>`',
          'Description, branch or tag, cron, time zone, active. `main` and `refs/heads/main` are the same ref. Schedule variables are not managed.'
        ],
        [
          '`gitlab.runner`',
          '`<runner id>`',
          'Create a project or group runner (GitLab returns its authentication token once: output `token`, secret, once-only), then tags, run untagged, locked, protected-only, paused and longest job. Rotate (`rotate_outputs`) resets the token — the old one stops working at once (`downtime`). Adopt works on any runner inside the pinned group; an instance runner is never inside it. Runner descriptions are not unique, so create cannot detect a twin.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Every id or name that goes into a request path is validated first: numeric ids must be digits, variable keys letters/digits/underscore, branch names follow git ref rules, environment names refuse dot segments. Anything else stops with `BAD_ID` before a call is made.',
        'A named step (rotate) checks the project or group in the resource id equals the one on the change (`TARGET_MISMATCH`); values for a write come only from the resource’s fields.',
        'Outputs (`token`, `username`) are sealed by the Hub at once and never appear in observed state, plans, steps, audit or logs; bind them to a stack secret such as a registry pull secret. A lost once-only token can only be rotated.',
        'Costs: GitLab bills the group, not each resource. Every type shows a known zero with the group’s plan and list price per seat in the note (Free, Premium, Ultimate on gitlab.com; "by contract" on a self-managed install), priced from a bundled table dated 2026-11-26 and the plan read from the pinned group’s namespace. Hosted runner minutes past the plan’s quota are usage the Hub cannot size.',
        'Needs a live check: endpoint paths, the Bearer header on every token kind, the access-list update bodies (`allowed_to_push`, `approval_rules` with `_destroy`), runner `paused`, and the bundled seat prices were written from GitLab’s documentation and not run. Confirm them on a throwaway group before relying on them.'
      ]
    }
  ]
}
