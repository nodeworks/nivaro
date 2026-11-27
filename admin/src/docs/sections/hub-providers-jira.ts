import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3: Jira. Facts are from the adapter code:
// api/src/services/hub/providers/jira/**. Nothing here ran against a live Jira site yet.

export const hubProvidersJiraDocs: DocSection = {
  id: 'hub-providers-jira',
  label: 'Provider: Jira',
  content: [
    { type: 'h1', id: 'hub-providers-jira', text: 'Provider: Jira — Hub mode only' },
    {
      type: 'p',
      text: 'One connection is one Jira site, signed in one of three ways (field `mode`). **Jira Cloud with an API token**: `base_url` must be an `https://<site>.atlassian.net` address (any other host is refused, so the token cannot be sent elsewhere), `email` and a secret `api_token`. **Jira Cloud OAuth 2.0 service account**: `cloud_id` (a UUID), `client_id` and a secret `client_secret`; the Hub gets a token from `api.atlassian.com`, keeps it in memory until it expires and calls Jira through `api.atlassian.com/ex/jira/<cloud id>`. **Jira Data Center**: an https `base_url` (a path such as `/jira` is allowed) and a secret personal access token `pat`; a private address passes only through `SSRF_ALLOW_HOSTS` on the Hub, the same rule as GitLab. All calls use REST API version 2, so descriptions and comments are plain text.'
    },
    {
      type: 'p',
      text: 'Optional `project_keys` limits the connection to those projects. Every read and write by id then checks the project (a component or version is judged through its own project): outside the list it reads as gone, and a change throws `JIRA_OUT_OF_ACCOUNT`. Test lists what the account may do from Jira’s own permission answer (Browse projects, Administer projects, Create issues, Add comments, Transition issues, and on Data Center Administer for webhooks). Nothing here is billed per resource, so no type has a cost estimate.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`jira.project`',
          'project key (`WEB`)',
          'Shared, read and adopt only. Components, versions and rules point at it.'
        ],
        [
          '`jira.component`',
          'Jira’s numeric id',
          'One per app: name and description in a project. Moving it to another project is a replace. Delete and replace are `destructive` (issues lose the component). A create that finds a component of the same name stops with `ALREADY_EXISTS`: adopt it.'
        ],
        [
          '`jira.version`',
          'Jira’s numeric id',
          'One per release: name, description, release date, archived. Set the one-shot field **Mark released** and the Hub runs the named op `release`: one change that sets `released` and the release date (today unless you gave one); a version that is already released changes nothing. A promotion to production sets it through the Wave 3 hook. Delete and replace are `destructive`.'
        ],
        [
          '`jira.webhook`',
          'Jira’s numeric id',
          'Data Center only (the admin webhook API); on Jira Cloud the plan stops with `WEBHOOK_DC_ONLY`. Name, https address (no login or query string), events, an optional JQL filter, enabled, and a sealed secret sent to Jira. When the connection is limited to some projects a JQL filter is required. Create, change and delete do not touch your issues.'
        ],
        [
          '`jira.issue_link_rule`',
          '`rule:<PROJECT>:<component id or 0>:<uuid>:<hash>`',
          'Hub-side: nothing exists at Jira to create. It says where Hub events become issues: the project, the issue type (by name, checked against the project), the component, extra labels and a priority name per severity. The settings that matter to a send ride in the id, so a change shows in the plan without a read. It is the only sender.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-jira-notify', text: 'Hub events become Jira issues' },
    {
      type: 'p',
      text: 'A `jira.issue_link_rule` can be named by a notify route (`/hub/connections` → Notify routes). The route decides which events go to it; the rule decides which project, issue type and component they land in. A message with a dedup key (a Hub incident, a failed deploy) is one Jira issue:'
    },
    {
      type: 'ul',
      items: [
        '**Open** creates the issue: summary = the title, description = the text in a `{noformat}` block (it cannot be broken out of, so Jira markup in an incident title cannot make links or macros), the severity and the Hub link (https only). Labels `nivaro-hub`, `app:<key>`, the rule’s labels and one label `hub-<hash>` made from the dedup key. If an issue with that label is still open, the Hub adds a comment ("Raised again") instead of opening a second one.',
        '**Update** adds a comment to the open issue; with no open issue it creates one so the message is not lost.',
        '**Resolve** adds a comment and moves the issue along a transition whose target status is in Jira’s **done** category (found by category, never by status or transition name; the first such transition Jira offers). No such transition: the comment is added and the answer says it did not move. No open issue: nothing is written.',
        'The issue is found again by its label (JQL, `statusCategory != Done`), not from memory, so a Hub restart does not split one incident into two issues. Inside one process the key is also remembered for an hour and checked by key first. Jira Cloud search can lag a few seconds behind a create.',
        'A message without a dedup key always opens a new issue. A 429 is retryable; Jira’s refusal text is scrubbed of the connection’s secrets (and of the Basic credential derived from them) before it is clipped.',
        'Needs a live check: Jira Cloud `search/jql` against a freshly created label, a transition screen that requires a resolution (the Hub does not fill one in, so that move fails with Jira’s message), webhook `secret` on Data Center versions that support it, and OAuth service-account access to a given site.'
      ]
    }
  ]
}
