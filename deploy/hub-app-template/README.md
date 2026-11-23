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

Anyone who can push to an app's deploy repository could rewrite its CI. Two things keep that
from deciding what runs on the swarm, and BOTH are required:

- **`ci_config_path` points at this template (mandatory).** At fork the Hub sets the app
  project's CI configuration file to `ci/deploy.yml@<template_project>:<template_ref>`, so
  GitLab reads the job from this Hub-owned project at a pinned tag or sha and ignores the app
  repository's own `.gitlab-ci.yml` (and its copies of `scripts/`, `ci/`, `manager/`). Without
  it, a pusher's `.gitlab-ci.yml` could override the included job: the `include:` the Hub also
  commits is only a fallback, not a boundary. The Hub also sets
  `ci_pipeline_variables_minimum_override_role = no_one_allowed`.
- **One deploy key per app, bound on the manager.** The key can only run `nivaro-hub-deploy`
  (forced command, `restrict`): three verbs (`stack-owner <stack>`, `secret-create
  <stack>_<name>_<sha8>`, `deploy <stack>`) for the exact `stack=` names and exact `host=`
  names in that app's key configuration, one proxy network, one image by digest. The first
  deploy labels the stack's services `nivaro.hub.key=<app>:<keyid>`; any other key is refused there
  afterwards. A hostname another stack already serves is refused. Ownership is never taken from
  the APP_KEY/ENV_KEY the job sends; those are only checked against the stack name. The stack
  file is the one installed on the manager; the job sends only settings and secret values, on
  stdin. No Docker socket forwarding, no shell.
- **The manager's host key is pinned.** The Hub pushes the target's `manager_known_hosts`
  (it must hold a key for `deploy_host`) as the masked project variable `DEPLOY_KNOWN_HOSTS`
  (base64) together with `DEPLOY_HOST`; the job connects with `StrictHostKeyChecking=yes` and
  refuses to run without it.

## One-time setup (operator)

1. **Import** this folder as a GitLab project (e.g. `platform/nivaro-template`), protect its
   tags, and tag a commit `v<major>.<minor>.<patch>` (the major is `HUB_TEMPLATE_MAJOR` in
   `scripts/deploy.sh` and `nivaro-hub-stack-major` in `manager/docker-stack.yml`). Only Hub
   operators get write access to it.
2. **GitLab and swarm.** GitLab 17.1 or newer: the Hub sets `restrict_user_defined_variables`
   with `ci_pipeline_variables_minimum_override_role = no_one_allowed` on every app project and
   stops with `CI_CONFIG_REFUSED` when GitLab does not keep both. A swarm manager running
   Traefik v3 with the swarm provider on an external overlay network (default `proxy`). Entry
   points `websecure` (https) and `web` (http), or set `entrypoint_https=` /
   `entrypoint_http=` in a key configuration. The stack's router asks for TLS and names no
   certificate resolver, so Traefik serves its **default certificate**: make the wildcard
   certificate (or a certificate covering the names you use) Traefik's default certificate
   (a `tls.stores.default` entry). With automatic names the wildcard DNS record must already
   point at the edge in front of Traefik; the Hub waits for a name to resolve but never makes
   DNS records.
3. **Manager setup** (as root on the manager, once per template major):
   ```sh
   install -m 0755 manager/nivaro-hub-deploy /usr/local/bin/nivaro-hub-deploy
   install -d -m 0755 /etc/nivaro-hub-deploy /etc/nivaro-hub-deploy/keys
   install -m 0644 manager/docker-stack.yml /etc/nivaro-hub-deploy/docker-stack.yml
   ```
   and a `deploy` user in the `docker` group. Root owns the wrapper, the stack file and the key
   configurations; the deploy user cannot change them. When the target's `template_ref` moves
   to a new major, install the new stack file first: the wrapper refuses a major mismatch
   ("update the stack file on the manager").
4. **Per app** (the Hub makes the key pair at creation and shows these lines):
   - `/etc/nivaro-hub-deploy/keys/<app>.conf` from `manager/key.conf.example`: the app's exact
     `stack=` names (`<app>--<env>`) and exact `host=` names.
   - one `~deploy/.ssh/authorized_keys` line as in `manager/authorized_keys.example`, with the
     app's public key and `keyid=` its fingerprint (`ssh-keygen -lf <key>.pub`).
   - The private key is the app project's masked, protected `DEPLOY_SSH_KEY` variable (base64),
     set by the Hub on that one project. It is not a group variable: no key reaches another app,
     and the Hub does not keep the private half after pushing it.
5. **Hub target** (Hub → Drivers → Where new apps go). GitLab address, a token with the `api`
   scope belonging to a Maintainer of the namespace, the namespace, this template as
   `namespace/project` (not a numeric id) + `template_ref` (a tag or a full commit sha, never a
   branch), `deploy_host` (`deploy@manager.example.com`), `manager_known_hosts`
   (`ssh-keyscan -t ed25519 <manager>`; `[host]:port` entries when the port is not 22), the proxy
   network, and how names are made (wildcard DNS, or manual tickets). Test checks the token, the
   namespace and that the template can be seen. Each app repository is created as
   `<namespace>/<app>-deploy`; no group variable is needed.

## The operator step (Installed)

The Hub makes the app's key pair when it creates the deploy repository, then waits before the
first deploy: the creation shows the app's `authorized_keys` line and `keys/<app>.conf` text
(step 4 above). Install both on the manager, then press **Installed**; the Hub runs the deploy
once. When the key is not installed yet or a stack is bound to another key, `deploy.sh` and
`nivaro-hub-deploy` stop with exit code 77 and print the single line
`NIVARO_HUB_KEY_NOT_INSTALLED`; the Hub reads only that line and goes back to waiting for
Installed. Every other failure is an ordinary deploy failure (Retry). There is no timeout and no
automatic re-deploy.

## What a deploy does

1. Reads `.hub/app.env`: exactly the settings listed in `.hub/README.md`; any other key, a
   duplicate or a missing one stops the deploy. Read as data, never sourced. `ENV_KEY` must be
   the branch, the repository must be `<APP_KEY>-deploy`, `STACK_NAME` must be
   `<APP_KEY>--<ENV_KEY>` (hashed only when that is over 40 characters), and every host must end
   in `HUB_HOST_SUFFIX` when the Hub set one.
2. Reads the pin: refuses a missing pin, `latest`, and a line 2 that is not the image digest
   (`sha256:` + 64 hex). The image is always `nodeworks/nivaro@<digest>`.
3. Asks the manager about the stack: it answers only for this key's own stacks, and only
   `free` or `mine` (bound to this key).
4. Sends each `NIVARO_*_B64` value (decoded) on stdin as swarm secret
   `<STACK_NAME>_<name>_<first 8 hex of sha256(value)>`; the manager checks the hash. Secrets are
   immutable: a new value is a new secret, and the stack moves to it. The app reads each through
   `<SETTING>_FILE`. Values never reach argv or the job log.
5. Sends the settings; the manager checks them again, deploys its stack file
   (`--detach=false`, start-first, rollback on failure) and waits (40 × 15 s) until
   `http://web:3055/api/version`, read on the stack's own network, answers the pinned version.

## Rotating an app's deploy key

The stack and its secrets are bound to `<app>:<old keyid>`, so the new key is refused until the
operator moves the binding. Secrets are immutable and keep their old label; once the stack is
bound to the new key the wrapper accepts them, and new values get the new label.

1. Make the new key pair by hand (`ssh-keygen -t ed25519`; the Hub makes a pair only once, when it
   creates the repository, and has no rotate action yet) and set it as the app project's
   `DEPLOY_SSH_KEY` variable (masked, protected, the base64 of the private key file).
2. On the manager, replace the app's `authorized_keys` line: same `<app>`, the new public key,
   `keyid=` the new fingerprint (`ssh-keygen -lf <new>.pub`).
3. Relabel every service of each of the app's stacks (a label change does not restart tasks):
   ```sh
   for svc in $(docker service ls --filter label=com.docker.stack.namespace=<stack> --format '{{.Name}}'); do
     docker service update --detach --label-add 'nivaro.hub.key=<app>:<new keyid>' "$svc"
   done
   ```
4. Run the deploy job once per environment: `stack-owner` answers `mine` and the deploy goes on.
   Until step 3, every deploy with the new key stops with "bound to another deploy key".

## Changing the deploy job

Edit `scripts/deploy.sh`, run `sh scripts/sync-ci.sh`, commit both, tag, and move the Hub
target's `template_ref` to the new tag (the Hub then updates each app's `ci_config_path`). A
change to the stack contract bumps the major in both files. A change to `manager/` is installed on the manager by
hand (step 3). The images are pinned by digest; re-pin with
`docker buildx imagetools inspect <image>:<tag>` and copy the `Digest:` line (CI job image in
`scripts/sync-ci.sh` and `.gitlab-ci.yml`, Redis in `manager/docker-stack.yml`).

## Traefik network label (P6-35)

The stack gives web exactly **one** Traefik network label: `traefik.swarm.network` for Traefik
v3 (the default) or `traefik.docker.network` for v2. Traefik v3 skips a service that carries both
("both Docker and Swarm labels are defined"), so a stack file from before this change is never
routed by v3. The Hub writes `TRAEFIK_VERSION` (the target's `traefik_version`, default 3) into
each new app's `.hub/app.env`; `nivaro-hub-deploy` picks the label from it.

- Update `manager/docker-stack.yml` and `manager/nivaro-hub-deploy` on the manager together
  (step 3). A deploy that sends `TRAEFIK_VERSION` to a manager whose stack file does not use
  `TRAEFIK_NETWORK_LABEL` is refused with "update the stack file on the manager".
- **Apps created earlier keep their pinned template** and their app.env until the target's
  `template_ref` is moved and the app is re-pinned. An app.env without `TRAEFIK_VERSION` deploys
  as v3 (the key is optional), so on a v3 swarm updating the manager's stack file is enough;
  on a v2 swarm keep the old stack file until those apps are re-created or their app.env
  carries `TRAEFIK_VERSION=2`.

## Limits of this template

- **One node.** web, worker and redis are placed on manager nodes so they share the `uploads`
  volume. For several nodes, use a shared volume driver and drop the constraints.
- **No host mounts, no privileged settings, no published ports.** Keep it that way.
- **Old secrets** stay after a value changes, so `docker service rollback` still works. Clear
  them on the manager when no longer needed:
  `docker secret ls --filter label=nivaro.hub.stack=<STACK_NAME>`, then `docker secret rm`.
- **Extensions** are not part of a created app.
