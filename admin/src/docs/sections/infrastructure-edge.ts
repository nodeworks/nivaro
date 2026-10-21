import type { DocSection } from '../types'

export const infrastructureEdgeDocs: DocSection = {
  id: 'infrastructure-edge',
  label: 'Infrastructure: Proxy, Resources, GitLab',
  content: [
    { type: 'h1', id: 'infrastructure-edge', text: 'Infrastructure: Proxy, Resources, GitLab' },
    {
      type: 'p',
      text: 'Three read-only tabs on the Infrastructure page, for administrators. Nivaro only reads from each source and never changes anything.'
    },
    { type: 'h3', text: 'Proxy' },
    {
      type: 'p',
      text: 'Set TRAEFIK_API_URL to the Traefik API on an internal network (add TRAEFIK_API_TOKEN, or TRAEFIK_API_USER and TRAEFIK_API_PASSWORD, if it is protected). The tab lists every router with its rule, entrypoints, priority, middleware chain, TLS and target service, with each backend server marked up or down. A router whose servers are all down is flagged. Traefik v2 and v3 both work.'
    },
    {
      type: 'p',
      text: 'When two routers share an entrypoint and one has a broader PathPrefix with a higher priority, the tab says so in plain words, for example "Requests for /api/x go to router A, not router B". When no priority is set, Traefik uses the rule length, and the tab shows that. Request rate and 5xx rate per router appear when Traefik metrics reach the telemetry store.'
    },
    { type: 'h3', text: 'Resources' },
    {
      type: 'p',
      text: 'Per container CPU, share of CPU periods throttled, memory against its limit, out-of-memory kills, network and disk, from cAdvisor metrics in the telemetry store. Switch between 24 hours and 7 days, and sort by any column. A container is flagged when more than 10 percent of its CPU periods were throttled or its memory is over 85 percent of its limit. A limit of 0 shows as "no limit".'
    },
    { type: 'h3', text: 'GitLab' },
    {
      type: 'p',
      text: 'Uses the GitLab URL and token of a GitLab component on the Environments page; the token is never shown. The tab shows readiness and liveness, the version, runners (online, offline, stale after a day without contact, or never contacted), the number of pending jobs and how long the oldest has waited, and the GitLab container CPU and memory. Health checks only answer to GitLab’s monitoring allowlist, so add this server there or set GITLAB_HEALTH_TOKEN. Set GITLAB_CONTAINER to a name pattern if the container is not called gitlab. Each part reports on its own if it cannot be read.'
    },
    {
      type: 'note',
      text: 'Without an administrator token, runners and pending jobs fall back to what the token can see and to the projects mapped on Environments.'
    }
  ]
}
