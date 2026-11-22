# Nivaro Hub app — deploy repository template

The Nivaro Hub creates one deploy repository per app by forking this template (Hub → Apps →
Create app). Import it into GitLab once, then name it as the target's `template_project`.

```
.gitlab-ci.yml        the `deploy` job: runs on a push to a branch that holds .hub/app.env
docker-stack.yml      web + worker + redis, routed by Traefik
scripts/deploy.sh     settings → swarm secrets → stack deploy → wait for /api/version
.hub/                 app.env + nivaro-version on each environment branch (see .hub/README.md)
```

## What the Hub does with it

For each app the Hub forks this project into `<namespace>/<app>-deploy`, removes the fork
relation, makes one protected branch per environment (named by the environment key), commits
`.hub/app.env` and the pin `.hub/nivaro-version` there, and sets the environment's secrets as
CI variables. The commit starts the `deploy` job. A later promotion only rewrites the pin.

## One-time setup (operator)

1. **Import** this folder as a GitLab project (e.g. `apps/nivaro-template`).
2. **Swarm.** A Docker swarm manager reachable over SSH, running Traefik v3 with the swarm
   provider on an external overlay network (default name `proxy`; the target's
   `proxy_network`). Entry points `websecure` (https) and `web` (http), or set
   `TRAEFIK_ENTRYPOINT`. The TLS certificate is Traefik's (a resolver or a default certificate
   covering the wildcard); add a `certresolver` label in a fork if you use one.
3. **Deploy user.** A user on the manager in the `docker` group, with an SSH key. The job
   forwards the manager's Docker socket over that one SSH connection (sshd's
   `AllowStreamLocalForwarding` must stay on, the default).
4. **Group CI variables** on the Hub's namespace (the Hub never holds host credentials):
   - `DEPLOY_SSH_KEY` — the deploy user's private key (type File or Variable, protected).
   - `DEPLOY_KNOWN_HOSTS` — the manager's host key lines (`ssh-keyscan <host>`). Without it the
     first connection trusts whatever key answers.
5. **Hub target.** In the Hub, add a target: GitLab address, namespace, this template,
   `deploy_host` (`user@manager.example.com`, pushed as the project variable `DEPLOY_HOST`),
   the proxy network, and how names are made (wildcard DNS, or manual tickets).

## What a deploy does

1. Reads `.hub/app.env`. Exactly the settings listed in `.hub/README.md`; any other key, a
   duplicate or a missing one stops the deploy. The file is read as data, never sourced.
   `ENV_KEY` must match the branch.
2. Reads the pin: refuses a missing pin and `latest`. The image is
   `nodeworks/nivaro@<digest>` (`HUB_IMAGE` overrides the repository); a pin without a digest
   deploys the version tag and says so.
3. Opens one SSH connection to `DEPLOY_HOST`, always as `ssh … -- "ssh://$DEPLOY_HOST"` after
   checking it is `host`, `user@host` or `host:port`.
4. Turns each `NIVARO_*_B64` variable into a swarm secret named
   `<STACK_NAME>_<name>_<first 8 hex of sha256(value)>`. Secrets are immutable: a new value is
   a new secret, and the stack moves to it. The app reads each through `<SETTING>_FILE`
   (`DB_URL_FILE`, `HUB_TOKEN_FILE`, `SESSION_SECRET_FILE`, `ENCRYPTION_KEY_FILE`,
   `OIDC_CLIENT_SECRET_FILE`). Values never reach argv or the job log.
5. Refuses to deploy over a stack of the same name that another app or environment owns
   (service labels `nivaro.hub.app` / `nivaro.hub.env`), then runs
   `docker stack deploy --detach=false` (start-first updates, rollback on failure).
6. Waits (40 × 15 s) until `http://web:3055/api/version`, read from a short-lived container on
   the stack's own network, answers the pinned version.

## Limits of this template

- **One node.** web, worker and redis are placed on manager nodes so they share the `uploads`
  volume. For several nodes, use a shared volume driver (NFS, …) and drop the constraints.
- **No host mounts, no privileged settings, no published ports.** Keep it that way in forks.
- **Old secrets** stay after a value changes, so `docker service rollback` still works. Clear
  them when no longer needed:
  `docker secret ls --filter label=nivaro.hub.stack=<STACK_NAME>`, then `docker secret rm`.
- **Extensions** are not part of a created app; adding one is a change to this repository.
