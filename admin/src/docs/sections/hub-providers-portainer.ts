import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3: Portainer. Facts are from the adapter code:
// api/src/services/hub/providers/portainer/**. Nothing here ran against a live Portainer yet.

export const hubProvidersPortainerDocs: DocSection = {
  id: 'hub-providers-portainer',
  label: 'Provider: Portainer',
  content: [
    { type: 'h1', id: 'hub-providers-portainer', text: 'Provider: Portainer — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `baseUrl` (the https address of your self-hosted Portainer, for example `https://portainer.example.com:9443`: no login, path or query) and a secret `token` (a Portainer access token, `ptr_…`, of an administrator). A Portainer on a private network works only when its host is listed in `SSRF_ALLOW_HOSTS` on this Hub, the same rule as Hub GitLab targets. Test reads who the token is and the Portainer version, and marks every write right missing for a token that is not an administrator’s.'
    },
    {
      type: 'warn',
      text: 'Portainer never writes Docker through the Hub. The Hub agent stays the only thing that deploys, updates, restarts or removes a stack, container or service. The adapter manages Portainer’s own setup (environments, teams, access, registries) and reads stacks. Any other call is refused before it is made (`DOCKER_WRITE_NOT_ALLOWED`); a test records every call the adapter makes and proves no Docker-writing endpoint is ever reached.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`portainer.environment`',
          '`<environment id>`',
          'A Hub Docker host registered in Portainer as an Edge agent: name, public address, group and check-in interval. The **edge key** is an output (secret, shown again by Portainer, so it is never once-only): bind it to the stack secret the host’s Portainer agent reads. Delete detaches the host from Portainer and is `destructive`; the containers on the host are not touched. Health is Portainer’s own view: up or down, and running, stopped and unhealthy container counts, shown beside the Hub’s fleet row so a mismatch is visible.'
        ],
        [
          '`portainer.team`',
          '`<team id>`',
          'A Portainer team (name only). Members are managed in Portainer. Delete is `destructive`.'
        ],
        [
          '`portainer.team_access`',
          '`<environment id>/<team id>`',
          'One team’s role on one environment. **Read-only user by default.** Helpdesk, operator, standard user and environment administrator are `public_exposure` (a Hub administrator starts them): they let the team act on the host’s containers through Portainer. The Hub changes only its own team’s entry and leaves every other team’s role as Portainer has it.'
        ],
        [
          '`portainer.registry`',
          '`<registry id>`',
          'Registry address and login (custom, Docker Hub, GitLab or Quay.io). The password is a sealed secret field: written to Portainer once, never shown, never in a plan, a step or an error. Portainer’s registry access rules are not changed by the Hub, so a new registry is visible to Portainer administrators only until someone shares it in Portainer.'
        ],
        [
          '`portainer.stack`',
          '`<stack id>`',
          '**Read and adopt only.** Shows name, environment, kind (swarm, compose, kubernetes) and status; an inactive stack warns. Create, change and delete are not offered, and any attempt answers `DOCKER_WRITE_NOT_ALLOWED`. Stack variables and files are never read.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'All five types are shared: only Hub administrators change them.',
        'A create that finds an environment, team or registry with the same name the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead. A team that already has access to the environment stops the same way.',
        'Registering an environment gives Portainer, and the people it grants a role, a way to reach that host’s Docker. That is Portainer’s own access model; keep team access read-only unless a person needs more.',
        'No type has a cost estimate: Portainer is licensed per node, not per resource.',
        'Needs a live check: the multipart create of an Edge environment (the `URL` the agent calls back, which the adapter sets to the connection’s address), whether Portainer answers the edge key on create and on read, the team access map write on an environment (`TeamAccessPolicies` on `PUT /endpoints/{id}`), and the registry type ids.'
      ]
    }
  ]
}
