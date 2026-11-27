import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3: Snyk. Facts are from the adapter code:
// api/src/services/hub/providers/snyk/**. Nothing here ran against a live Snyk organization yet.

export const hubProvidersSnykDocs: DocSection = {
  id: 'hub-providers-snyk',
  label: 'Provider: Snyk',
  content: [
    { type: 'h1', id: 'hub-providers-snyk', text: 'Provider: Snyk — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `host` (the region: `api.snyk.io`, `api.eu.snyk.io` or `api.au.snyk.io`; no other host is ever called), `organization` (the organization id, a uuid) and a secret `token` (a service account token is preferred over a personal one). The organization id is in every call, so an id from another organization answers 404 and reads as missing. Snyk lists no rights for a token and a write cannot be tried without changing something: Test checks that the token can read integrations, targets and projects and assumes a token that reads can also write (a read-only role fails at its first change). Snyk bills the organization plan, not each resource, so no type has a cost estimate.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`snyk.integration`',
          '`<integrationId>`',
          'Shared, read only: the organization’s GitHub or GitLab integration. Adopt it so a target can point at it. The Hub never creates or removes one.'
        ],
        [
          '`snyk.target`',
          '`<targetId>`',
          'Imports one repository that the GitHub or GitLab adapter manages: name the `github.repository` or the `gitlab.project` as a ref (exactly one), plus an optional branch. A GitLab project also needs its path (`group/project`) because Snyk lists targets by path and imports by numeric id. Create posts the import and waits for the job; a job that has not finished in about 12 seconds stops with the retryable `IMPORT_PENDING` (adopt the target if it appears). **Delete stops monitoring**: Snyk removes the target and its projects, so it is `destructive` and `public_exposure` (administrator).'
        ],
        [
          '`snyk.project`',
          '`<projectId>`',
          'One manifest or container, read, with its open issues by severity and the fixable count. A project appears when its target is imported and goes when the target is deleted; the Hub only changes its protection settings: monitoring on/off, pull request checks on/off and what fails a pull request (any vulnerability or high severity only). Health warns on critical or high issues and on a project nobody monitors.'
        ],
        [
          '`snyk.ignore`',
          '`<projectId>/<issueId>`',
          'An ignore with a reason, a reason kind, an expiry and an optional "stop ignoring when a fix exists". An expiry date in the past is refused. **An ignore with no expiry never lapses: `public_exposure` (administrator).** A create on an issue that already has an ignore the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-snyk-protection', text: 'Weakening protection is an administrator’s change' },
    {
      type: 'p',
      text: 'The plan judges the risk on what it sends. Switching monitoring off, switching pull request checks off, failing pull requests only on high severity, deleting a target and ignoring an issue with no expiry are all `public_exposure`: an owner’s change waits for an administrator’s approval. Turning protection on, or setting an ignore to expire, is not flagged.'
    },
    { type: 'h2', id: 'hub-providers-snyk-findings', text: 'Findings in the vulnerability tab' },
    {
      type: 'p',
      text: 'Snyk’s findings join the image scan as source `snyk`: critical, high, medium and low counts, the number of fixable issues, how many projects were counted and how many are not monitored (their counts may be old). The counts come from each project’s issue totals; the fixable count is one extra read per monitored project with issues (at most 100 per connection per pass) and stays empty when the token cannot read issues. Snyk shows findings per project, not per image digest, so they are listed by project.'
    },
    {
      type: 'ul',
      items: [
        'No type hands out an output and none sends messages.',
        'Needs a live check: the import call’s answer (the job id in the body or the `Location` header), the REST target\'s `display_name` for a GitLab target, and whether `PUT /ignore/<issue>` replaces every path of the issue.'
      ]
    }
  ]
}
