import type { DocSection } from '../types.js'

export const infrastructureDriftDocs: DocSection = {
  id: 'infrastructure-drift',
  label: 'Stack drift',
  content: [
    { type: 'h1', id: 'infrastructure-drift', text: 'Stack drift' },
    {
      type: 'p',
      text: 'Someone runs docker service update by hand on a server to fix something quickly. The next deploy quietly undoes it, or quietly keeps it, and nobody decided which. Stack drift catches this: after every deploy the deploy script stores what each service looked like (the baseline), and every night Nivaro compares the running services with it. Differences show on the Environments page and administrators get one notification per new difference.'
    },
    { type: 'h2', id: 'infrastructure-drift-compared', text: 'What is compared' },
    {
      type: 'ul',
      items: [
        'Image: repository and digest. A different tag on the same digest is the same image.',
        'Environment variables, one by one. Only a short list of settings that never hold a secret keeps its value in clear (NODE_ENV, NIVARO_ROLE, LOG_LEVEL, CRON_TICKS, PUBLIC_URL, ADMIN_URL and the like, plus number-only sizing settings such as DB_POOL_MAX or WEB_REPLICAS); every other value, and any value carrying password=, token=, key=, secret=, sig= or user:password@ in a URL, is kept only as a keyed hash. The page says “Value changed (not shown)” for those, never the value.',
        'Mounts (type, source, target, read-only), secrets and configs (name and target), mode and replicas, CPU and memory limits and reservations, placement constraints and preferences.',
        'User, read-only root filesystem, added and dropped capabilities, healthcheck, command and arguments, update, rollback and restart settings (values equal to the swarm default are ignored, so a docker service inspect and a plain Engine read compare equal).',
        'Service and container labels, traefik labels included. Only the labels a stack deploy writes itself (com.docker.stack.namespace, com.docker.stack.image) and swarm labels are ignored.',
        'A service in the baseline that is not running is "missing"; a service in the stack that is not in the baseline is "extra".'
      ]
    },
    {
      type: 'p',
      text: 'Version numbers, timestamps, the update status and assigned ports are never compared. When the service spec version moved after the baseline, the difference is marked "Hand-run update" (and, when swarm kept the deployed spec as the previous one, "one docker service update after the deploy"). A new service id is marked "Recreated".'
    },
    { type: 'h2', id: 'infrastructure-drift-baseline', text: 'Storing a baseline' },
    {
      type: 'p',
      text: 'The deploy script calls this after a deploy has converged, with an administrator token. It answers 200 with what it stored; the deploy must not fail if it does not.'
    },
    {
      type: 'pre',
      code: 'POST /api/infrastructure/drift/baseline\n{\n  "stack": "efp",\n  "environment": "production",\n  "version": "0.3.4",\n  "release": "efp-2026.10.22-1",\n  "services": [ …docker service inspect output… ]\n}'
    },
    {
      type: 'ul',
      items: [
        "services is the array docker service inspect prints for the stack's services (at most 200, 8 MB). Services of another stack are left out and listed in the answer as ignored. Only the compared fields are stored.",
        'Leave services out and Nivaro reads the stack itself from the Docker host named like the environment in DOCKER_HOSTS (or the only host, or the one named in "host").',
        'A new baseline replaces the previous one for that stack and environment (the last 10 are kept) and closes its open differences.'
      ]
    },
    { type: 'h2', id: 'infrastructure-drift-check', text: 'The nightly check' },
    {
      type: 'p',
      text: 'The infra-drift-check job runs at 03:15 on instances that tick scheduled jobs and have a Docker host configured. It reads each stack through the read-only Docker proxy, never the Docker socket. Check now on the Environments card runs it at once (POST /api/infrastructure/drift/check, optionally with stack and environment).'
    },
    {
      type: 'p',
      text: 'Without a Docker host the card says "No live source — set DOCKER_HOSTS" instead of claiming there is no drift: nothing was compared. The hashes are keyed with the instance\'s SESSION_SECRET: without one, baselines are refused (503) and checks fail rather than hash with a fixed key; if it changes, hashed values can no longer be compared until the next baseline, and the check says so. One check per stack and environment runs at a time across replicas (a Redis lease), so the nightly job and Check now never record or alert the same difference twice.'
    },
    { type: 'h2', id: 'infrastructure-drift-where', text: 'Where it shows' },
    {
      type: 'ul',
      items: [
        'Environments → Stack drift: one row per environment and stack with the baseline (version, release, when), the last check and the number of drifted fields. Open a row for deployed versus running values per field.',
        'Infrastructure → Stacks: a one-line summary that links to Environments.',
        'Ask AI and connected apps: the infra_drift tool (GET /api/infrastructure/summary/infra_drift) lists drifted fields; it names environment variables but never returns their values.',
        'Notifications: administrators are told once per new difference, with a link to the row. A difference nobody could be told about is offered again on the next check.'
      ]
    },
    {
      type: 'note',
      text: 'Administrators only, and not available in cloud mode. GET /api/infrastructure/drift returns the stored status for the page.'
    }
  ]
}
