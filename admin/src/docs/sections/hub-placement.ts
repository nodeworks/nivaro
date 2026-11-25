import type { DocSection } from '../types.js'

// Hub placement (ideas 48, 49, 50), checked against api/src/services/hub/placement/*,
// routes/hub-placement.ts, the move kind between_stacks (services/hub/move/*) and
// admin/src/pages/hub/placement.

export const hubPlacementDocs: DocSection = {
  id: 'hub-placement',
  label: 'Hosts, costs and other Hubs',
  content: [
    { type: 'h1', id: 'hub-placement', text: 'Hosts, costs and other Hubs' },
    {
      type: 'p',
      text: 'Three Apps hub screens for Hub administrators: Hosts (`/hub/hosts`) groups the Docker hosts in regions and shows what runs where; Costs (`/hub/costs`) estimates what each app costs a month; Other Hubs (on the Fleet tab) shows the apps of other Nivaro Hubs, read only.'
    },

    { type: 'h2', id: 'hub-placement-hosts', text: 'Hosts and regions' },
    {
      type: 'p',
      text: 'A host is a Docker driver: one Hub agent in front of one swarm. A region is a named group of hosts (a data centre, a cloud region, a rack) with a cost factor in percent that the cost report applies (100 = the rates as set). A host is in one region at most; GitLab drivers are not hosts, their pipelines decide where an app runs. Each host shows the environments whose Docker stack it runs, the shared deployments on it, and its latest capacity figures (CPU, memory, files) from the capacity samples.'
    },
    {
      type: 'ul',
      items: [
        '**Run an environment on a host.** An environment with no placement yet gets a new Docker stack placement on the host picked (Not running anywhere yet → Pick a host → Run here). Deploy it after with Apply now on its row. An environment that already runs is never placed again here: 409 `ALREADY_PLACED`; one an app creation is still placing is not listed and is refused (409 `CREATION_RUNNING`); a freeze holds it, and the placement edit of an environment, too (action `placement`, 409 `FROZEN`).',
        '**Move one to another host.** Move… on a host row opens that environment’s Move panel with a new stack on the other host to pick. The Hub moves it with the move engine (below): plan, checklist, typed confirm, rollback until release.',
        'Writes are logged (`nivaro_hub_regions`, `nivaro_hub_region_drivers`, `hub-env-place`) and refused with 409 `MOVE_OPEN` while a move holds the environment.'
      ]
    },

    { type: 'h2', id: 'hub-placement-moves', text: 'Moving a stack to another host' },
    {
      type: 'p',
      text: 'A Docker stack moves to another placement of its own with the move kind `between_stacks`: from a dedicated Docker stack to a dedicated Docker stack, usually on another host. It follows the steps of a move to a dedicated stack (`to_dedicated`) exactly, with the source driven as in a move to a shared deployment (over its hub link): the database never moves, the new stack is deployed in maintenance, the files are copied, the name is routed, verified and released, and the old stack is retired. Every rollback rule of moves holds unchanged: never two writers on one database, never an app without a home.'
    },
    {
      type: 'table',
      head: ['Check', 'What it means'],
      rows: [
        [
          'Routing',
          'Two stacks on one host move automatically (one Traefik edge). Two hosts are two edges: the route is changed by hand, and the plan says which names must point where.'
        ],
        [
          '`SOURCE_UNREACHABLE`',
          'A move to ANOTHER host is always routed by hand, so the Hub needs an address of the old stack that does not depend on its public name, or it could not hold it in maintenance or roll back once the name moved. In practice: the old stack must be on a host whose agent publishes stacks on a port, and that agent’s address must be a loopback or private (RFC 1918) address, or a `.test` name. A Traefik-only source is refused for a move to another host; between two stacks on one Traefik host the move is automatic.'
        ],
        [
          'The new stack is proven',
          'Both stacks answer the same version, so the version never proves the name moved. The new stack is deployed with the move’s number (HUB_BOOT_MAINTENANCE) and reports it on `/api/version` as `move_target`. Verify, the manual-route wait and Confirm route, release, retire and a rollback’s "point the name back" all require that marker on the public name; release lifts maintenance only with `only_target` (the old stack answers 409 `NOT_THE_MOVE_TARGET` and keeps its freeze), and the old stack is never retired while the name may still reach it (`NAME_NOT_ON_NEW_STACK`). Needs 0.3.215 or later (`MOVE_TARGET_MARKER`).'
        ],
        [
          '`PORT_IN_USE`',
          'Two stacks of one environment on one host that publishes stacks on a port would ask for the same port. Enter another free published port for the new stack in the Move panel (`to.publish_port`); each stack keeps its own port for the move, and release makes the new one the environment’s.'
        ],
        [
          '`DB_CONNECTIONS`',
          'While the move runs both stacks are up, each opening its own pools on the same database. The Hub counts the stack twice with the Scaling tab’s own math (processes × (main + background pool + 1)) plus every other Hub stack on that server, and refuses past the server’s connection limit. An unknown limit only warns (`DB_LIMIT_UNKNOWN`).'
        ],
        [
          '`REDIS_SHARED`',
          'Both stacks hold the same hub token, so they must not share one Redis database (a bundled Redis per stack is fine).'
        ],
        [
          '`NOT_A_MOVE`',
          'Between two dedicated placements only Docker stacks move. A GitLab placement changes by editing the environment’s placement.'
        ]
      ]
    },

    { type: 'h2', id: 'hub-placement-costs', text: 'Cost chargeback' },
    {
      type: 'p',
      text: 'Costs estimates a monthly cost per environment from what the Hub measures, times rates you set (Rates on the tab: per CPU core, per GB of memory, per GB of files, per GB of database, a flat amount per environment, a currency and a 7–31 day window). It is for showback, not an invoice.'
    },
    {
      type: 'table',
      head: ['Figure', 'Where it comes from'],
      rows: [
        [
          'CPU',
          'Mean CPU over the window from the capacity samples (a shared deployment app: its share of the deployment by answering time).'
        ],
        [
          'Memory',
          'Mean memory of a dedicated stack; a shared deployment’s memory split between its apps by their answering time (evenly when nobody answered).'
        ],
        ['Files', 'The newest stored-files total.'],
        ['Database', 'The size of the newest successful database backup the Hub made.'],
        [
          'Region factor',
          'The host region’s cost factor, applied to the environment’s whole amount (a shared deployment app: its deployment’s host).'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'A figure the Hub could not read counts as nothing and is named under Not measured. The means and the newest figures are computed by the database (one row per environment and per shared deployment), never read sample by sample.',
        'Set an app’s department and cost centre on its row; the report groups by department and by owner. An app with several owners is counted under each, so owner totals overlap.',
        'Export CSV gives one line per environment. Every text cell that starts with `=`, `+`, `-` or `@` is written with a leading quote, so a spreadsheet shows it as text. Owners are named by their name (Unnamed without one), never an email address. Each export is logged (`hub-chargeback-export`).'
      ]
    },

    { type: 'h2', id: 'hub-placement-federation', text: 'Other Hubs (federation)' },
    {
      type: 'p',
      text: 'A Hub can show the apps of other Nivaro Hubs on its Fleet tab, read only, each tagged with the Hub it comes from. Nothing on this Hub ever acts on another one.'
    },
    {
      type: 'ul',
      items: [
        'On the other Hub, make an API key with the `hub:read` scope only. Add it here (Fleet → Other Hubs → Add a Hub) with that Hub’s https origin. Before it is stored, this Hub asks the other one `GET /api/hub/federation/self`: a key that can write (`hub:write`) is refused (`PEER_KEY_TOO_WIDE`), and so is anything that is not a named API key. The check runs again on every fresh read.',
        'The key is sealed with this Hub’s ENCRYPTION_KEY and never answered back (reads show the mask). A new address needs the key again (`TOKEN_REQUIRED`): an old key never goes to a new origin.',
        'This Hub only ever sends two GETs to the other: `/api/hub/federation/self` (it answers an API key with hub:read, or a Hub administrator’s own session) and `/api/hub/fleet` (what the key’s owner may see there). Every call goes through the SSRF guard (redirects refused; a private or reserved address needs SSRF_ALLOW_HOSTS on this Hub), with a 10 s timeout and a 4 MB answer cap.',
        'What the other Hub answers is not trusted: each row is rebuilt from plain text, numbers, booleans and dates with length caps; addresses become a host name only. The one link shown is the other Hub’s stored https origin plus `/hub?app=<id>` (a stored address that fails the address rule, or plain http, gets no link and is not answered back).',
        'Reads are cached 60 s; a Hub that stops answering shows its last answer for up to 15 minutes, marked as such. Read now asks every Hub at once.'
      ]
    },
    {
      type: 'note',
      text: 'Tables (migration 580, created everywhere, used only with HUB=on): `nivaro_hub_regions`, `nivaro_hub_region_drivers`, `nivaro_hub_app_cost_centers`, `nivaro_hub_peers`. The rates live in nivaro_extension_settings (`nivaro-hub` / `chargeback`).'
    }
  ]
}
