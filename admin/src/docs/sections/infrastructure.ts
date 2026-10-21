import type { DocSection } from '../types.js'

export const infrastructureDocs: DocSection = {
  id: 'infrastructure',
  label: 'Infrastructure',
  content: [
    { type: 'h1', id: 'infrastructure', text: 'Infrastructure' },
    {
      type: 'p',
      text: 'The Infrastructure page at /infrastructure (Operations → Health) shows the Docker hosts this instance runs on: stacks and containers, rolling updates, healthchecks, the swarm itself and its secrets. It is read-only and for administrators. Nivaro never mounts the Docker socket: a deployment runs a socket proxy that allows GET requests only, on an internal network, and names it in DOCKER_HOSTS (name=url pairs, comma-separated) or DOCKER_API_URL. Each host is read separately, so a host that does not answer shows its error and the others still render. In cloud mode the page is off.'
    },
    {
      type: 'p',
      text: 'The tabs are grouped: Overview; Workloads (Stacks, Containers, Updates, Health); Swarm (Swarm, Secrets); Hosts (Hosts, Resources, Reboot, Logs); Images and storage (Volumes, Images, Provenance); Proxy and build (Proxy, GitLab). On a wide screen they sit in one strip with a thin rule between groups, and the strip scrolls when it does not fit. On a narrow screen a single button shows the current view and opens the grouped list, which you can also type into. Every Docker-backed tab shows one section per host with the host name and its status on the right; a host that does not answer says so in that place. Long lists (a host with hundreds of containers, many images) show the first rows with a button for the rest.'
    },
    {
      type: 'note',
      text: 'Tabs that read swarm services, tasks, nodes or secrets need the matching sections switched on in the proxy (INFO, CONTAINERS, SERVICES, TASKS, NODES, SECRETS). Keep SWARM and CONFIGS off: Nivaro never reads them, because the swarm section returns the join tokens and the configs section returns config contents. A section the proxy refuses is reported on the tab; everything else still shows. Whatever the Engine answers, environment variables, join and unlock keys, credential-looking label values and secret command-line arguments are removed on the server before anything is cached or sent to the page.'
    },

    { type: 'h2', id: 'infrastructure-stacks', text: 'Stacks' },
    {
      type: 'p',
      text: 'The Stacks tab lists, per host, every swarm stack with its services, and every compose project with its containers. A counts strip at the top gives services, running against desired replicas, failing services and containers. The filter box matches stack, service, image and error text; Failing only hides everything that is fine.'
    },
    {
      type: 'ul',
      items: [
        'Each service shows running / desired replicas, its image with a short digest, its update state, published ports and when it last changed. A service is failing when fewer tasks run than it wants, when its update is paused or rolling back, or when a slot has nothing running and its newest task failed or cannot be scheduled. The reason is written under the name, with the engine’s own message (for example “no suitable node” or “No such container”).',
        'Expand a service to see its tasks: the newest four per slot, failed history included, with the node, image, state (and the state the swarm wants), error and times.',
        'On a swarm worker only that node’s own task containers are visible; services and other nodes’ tasks are read from a manager. A host outside a swarm shows its compose projects and standalone containers.'
      ]
    },

    { type: 'h2', id: 'infrastructure-updates', text: 'Updates' },
    {
      type: 'p',
      text: 'The Updates tab follows rolling updates. Services with an update in flight come first, with the update policy in words (order, parallelism, delay, monitor window, failure action) and the rollback policy. While any update is in flight the tab refreshes every 5 seconds, otherwise every minute.'
    },
    {
      type: 'ul',
      items: [
        'Latest rollout, slot by slot: the old task and the new one that replaced it, how long the new task took to reach running and to pass its healthcheck, retries, and with start-first ordering how long old and new ran side by side.',
        'When the failure action fires the service says so (paused after a failure, rolling back, rolled back). Services set to roll back on failure carry an auto-rollback tag.',
        'Rollouts in the task history: past updates read back from the tasks the swarm still remembers, grouped by the image (and forced-update counter) they ran. A rollback to an earlier image counts as its own rollout. History is as long as the swarm’s task history limit, five tasks per slot by default. A duration marked “at least” is a lower bound because some of its tasks have since stopped.',
        'Time to healthy is only known for containers on the host being read that have a healthcheck.'
      ]
    },

    { type: 'h2', id: 'infrastructure-health', text: 'Health' },
    {
      type: 'p',
      text: 'The Health tab lists every container with a healthcheck: its health now, how many times it turned unhealthy in the last 24 hours, and when its health last changed. Click a container for its detail: the last probes with exit code, duration and output (trimmed), the failing streak, restarts, how long it took from start to healthy, and its recent changes.'
    },
    {
      type: 'p',
      text: 'Docker keeps only the last five probes, so Nivaro keeps the changes itself: every time the tab is read, and every 2 minutes by the infra-health-sample background job, each container’s health is compared with the last one recorded and a change is stored in Redis for 3 days. A flap shorter than the sampling gap can be missed. The job only runs on deployed instances, like every scheduled job. Containers whose image carries the org.opencontainers.image.version label are also grouped by that version, so a release that flaps more than the last one stands out.'
    },

    { type: 'h2', id: 'infrastructure-swarm', text: 'Swarm' },
    {
      type: 'p',
      text: 'The Swarm tab shows the managers and whether each is reachable and which one leads, every node with its role, state, availability, engine version, size and labels, and the cluster settings: node certificate lifetime, task history kept, autolock, external CA, Raft snapshot and tick settings, dispatcher heartbeat, data path port and address pool.'
    },
    {
      type: 'ul',
      items: [
        'Warnings appear when managers are unreachable (and whether quorum is lost), when there are exactly two managers (they tolerate no failure), when no manager leads, when a node is not ready, and during a root CA rotation.',
        'The node certificate expiry date comes from the host-facts collector (metric nivaro_host_swarm_node_cert_expiry_seconds in the telemetry store). It warns under 14 days. Without the collector the tab says host facts are not collected.',
        'Autolock is shown for information only. Keeping it off lets hosts restart unattended.',
        'The cluster settings come from the manager’s system info, never the swarm section (which carries the join tokens). A setting the engine does not report there shows as unknown.'
      ]
    },

    { type: 'h2', id: 'infrastructure-secrets', text: 'Secrets' },
    {
      type: 'p',
      text: 'The Secrets tab maps swarm secrets and configs to the services that use them. Versions named with a suffix such as _v1, _v2 are grouped under one name with the newest first. Flags mark secrets no service uses and services still on an older version while a newer one exists. Configs are listed only by the names service specs reference: their contents are never read, so a config no service uses does not appear.'
    },
    {
      type: 'warn',
      text: 'Only names and dates are shown. Docker never returns secret values, and Nivaro never reads configs (their contents can hold credentials).'
    }
  ]
}
