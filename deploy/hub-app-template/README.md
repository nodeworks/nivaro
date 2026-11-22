# Nivaro Hub app — deploy repository template

The Nivaro Hub creates one deploy repository per app from this template (Hub → Apps → Create
app). Import it into GitLab once, tag a commit, and name project + tag in the Hub target
(`template_project`, `template_ref`).

```
ci/deploy.yml               the deploy job app repositories include (generated, see below)
scripts/deploy.sh           the job's script, embedded into ci/deploy.yml by sync-ci.sh
scripts/sync-ci.sh          regenerates ci/deploy.yml; --check fails when it is stale
manager/nivaro-hub-deploy   forced command: the only thing the deploy key may run on the manager
manager/docker-stack.yml    the stack the manager deploys (web + worker + redis, Traefik labels)
manager/authorized_keys.example, manager/key.conf.example
.gitlab-ci.yml              this template project's own check pipeline (never deploys)
.hub/                       app.env + nivaro-version on each environment branch (.hub/README.md)
```

## Trust: nothing the app repository can change

Anyone who can push to an app's deploy repository could rewrite its CI. So nothing there
decides what runs on the swarm:

- **The deploy job comes from this template at a pinned ref.** The Hub commits the app's
  `.gitlab-ci.yml` as only an `include: project/ref/file` of `ci/deploy.yml` here. The fork's
  copies of `scripts/`, `ci/` and `manager/` are never run.
- **The deploy key can only run `nivaro-hub-deploy`** (forced command, `restrict`): three verbs
  — `stack-owner <stack>`, `secret-create <stack>_<name>_<sha8>`, `deploy <stack>` — for stacks
  under this key's `prefix=` lines, hostnames under its `host=` lines, one proxy network and one
  image by digest. The stack file is the one installed on the manager; the job sends only
  settings and secret values, on stdin. There is no Docker socket forwarding and no shell.
- **The manager's host key is pinned.** The Hub pushes the target's `manager_known_hosts` as the
  masked project variable `DEPLOY_KNOWN_HOSTS` (base64) together with `DEPLOY_HOST`; the job
  connects with `StrictHostKeyChecking=yes` and refuses to run without it.

## One-time setup (operator)

1. **Import** this folder as a GitLab project (e.g. `platform/nivaro-template`), protect its
   tags, and tag a commit (e.g. `v1`). Only Hub operators get write access to it.
2. **Swarm.** A swarm manager running Traefik v3 with the swarm provider on an external overlay
   network (default `proxy`). Entry points `websecure` (https) and `web` (http), or set
   `entrypoint_https=` / `entrypoint_http=` in the key configuration. The TLS certificate is
   Traefik's (a resolver or a default certificate covering the wildcard).
3. **Manager setup** (as root on the manager):
   ```sh
   install -m 0755 manager/nivaro-hub-deploy /usr/local/bin/nivaro-hub-deploy
   install -d -m 0755 /etc/nivaro-hub-deploy /etc/nivaro-hub-deploy/keys
   install -m 0644 manager/docker-stack.yml /etc/nivaro-hub-deploy/docker-stack.yml
   install -m 0644 manager/key.conf.example /etc/nivaro-hub-deploy/keys/apps.conf   # then edit
   ```
   A `deploy` user in the `docker` group; its `~/.ssh/authorized_keys` holds the deploy key only
   in the form of `manager/authorized_keys.example`. Root owns the wrapper, the stack file and the
   configuration; the deploy user cannot change them.
4. **Group CI variable** on the Hub's namespace: `DEPLOY_SSH_KEY`, the deploy key's private key
   (type File or Variable, protected). The Hub never holds host credentials. One key per
   namespace can deploy every stack its `prefix=` lines allow; for strict isolation between apps,
   give each app its own key, prefix and project-level `DEPLOY_SSH_KEY`.
5. **Hub target.** GitLab address, namespace, this template + `template_ref`, `deploy_host`
   (`deploy@manager.example.com`), `manager_known_hosts` (`ssh-keyscan -t ed25519 <manager>`), the
   proxy network, and how names are made (wildcard DNS, or manual tickets).

## What a deploy does

1. Reads `.hub/app.env`: exactly the settings listed in `.hub/README.md`; any other key, a
   duplicate or a missing one stops the deploy. Read as data, never sourced. `ENV_KEY` must be
   the branch, the repository must be `<APP_KEY>-deploy`, `STACK_NAME` must be
   `<APP_KEY>-<ENV_KEY>` (hashed only when that is over 40 characters), and every host must end
   in `HUB_HOST_SUFFIX` when the Hub set one.
2. Reads the pin: refuses a missing pin, `latest`, and a line 2 that is not the image digest
   (`sha256:` + 64 hex). The image is always `nodeworks/nivaro@<digest>`.
3. Asks the manager who owns the stack; refuses one another app or environment runs.
4. Sends each `NIVARO_*_B64` value (decoded) on stdin as swarm secret
   `<STACK_NAME>_<name>_<first 8 hex of sha256(value)>`; the manager checks the hash. Secrets are
   immutable: a new value is a new secret, and the stack moves to it. The app reads each through
   `<SETTING>_FILE`. Values never reach argv or the job log.
5. Sends the settings; the manager checks them again, deploys its stack file
   (`--detach=false`, start-first, rollback on failure) and waits (40 × 15 s) until
   `http://web:3055/api/version`, read on the stack's own network, answers the pinned version.

## Changing the deploy job

Edit `scripts/deploy.sh`, run `sh scripts/sync-ci.sh`, commit both, tag, and move the Hub
target's `template_ref` to the new tag. A change to `manager/` is installed on the manager by
hand (step 3). The images are pinned by digest; re-pin with
`docker buildx imagetools inspect <image>:<tag>` and copy the `Digest:` line (CI job image in
`scripts/sync-ci.sh` and `.gitlab-ci.yml`, Redis in `manager/docker-stack.yml`).

## Limits of this template

- **One node.** web, worker and redis are placed on manager nodes so they share the `uploads`
  volume. For several nodes, use a shared volume driver and drop the constraints.
- **No host mounts, no privileged settings, no published ports.** Keep it that way.
- **Old secrets** stay after a value changes, so `docker service rollback` still works. Clear
  them on the manager when no longer needed:
  `docker secret ls --filter label=nivaro.hub.stack=<STACK_NAME>`, then `docker secret rm`.
- **Extensions** are not part of a created app.
