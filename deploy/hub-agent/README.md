# Nivaro Hub agent

A small service that runs on a Docker swarm **manager**. The Nivaro Hub calls it
to deploy, restart and remove app stacks. It is the only Hub component that
holds the Docker socket for writes.

- Image: `nodeworks/nivaro-hub-agent` (tag `@hub-agent-x.y.z` publishes `x.y.z`, and `latest` only for a plain `x.y.z`, never for a prerelease)
- Build locally: `docker build -f deploy/hub-agent/Dockerfile -t nivaro-hub-agent:dev .` (needs BuildKit, the default in current Docker: it reads `Dockerfile.dockerignore` next to the Dockerfile; the legacy builder would use the repo-root `.dockerignore`, which excludes the agent)
- Run it as a stack: `stack.example.yml` in this folder

## What it does

- Takes a validated stack spec from the Hub and turns it into Engine API calls
  (secrets, volumes, services, labels).
- Lists, reads, restarts and removes only stacks it created itself (labelled
  `nivaro.hub.managed`). Every write re-reads the live labels first.
- Unpacks app extensions from OCI images into a folder the app services mount
  read-only.
- Logs one JSON line per event with codes and names only.

## What it never does

- Run a container for an app, exec into one, or read logs. Its only container is
  a short-lived, never-started one used to read an extension out of an image.
  The Engine paths it may call are a fixed allow-list; anything else is refused
  in the agent before it reaches the socket.
- Use an image that is not in `HUB_AGENT_IMAGES`, or that is not pinned by digest.
- Bind a host path or device into an app service. Volume options with
  `o=bind` (also `rbind`, `remount`) or a `device` that is not an NFS export are
  refused at start.
- Touch services, secrets or volumes it did not create.
- Print or store a token, key or registry credential. A failed start prints only
  an error code (for example `TOKEN_MISSING`).

## Run it

1. Create the secrets and the extensions folder (see the top of `stack.example.yml`).
2. Edit `HUB_AGENT_IMAGES`, the edge settings and the host suffixes.
3. `docker stack deploy -c stack.example.yml nivaro-hub-agent` on a manager.

A Hub (0.3.215 or later) can also create a brand-new app straight onto this agent
(Apps → Create app → Docker). Its plan reads `GET /v1/health` and refuses before
anything is written when the agent would refuse the stack: the Hub image not in
`HUB_AGENT_IMAGES` (`IMAGE_NOT_ALLOWED`), an extension image not in it
(`EXTENSION_NOT_ALLOWED`), a hostname outside `HUB_AGENT_HOST_SUFFIXES`
(`HOSTNAME_NOT_ALLOWED`), a setting outside the known keys and
`HUB_AGENT_ENV_PREFIXES` (`SETTING_INVALID`), bundled Redis without
`HUB_AGENT_REDIS_IMAGE` (`REDIS_NOT_OFFERED`), a publish port outside
`HUB_AGENT_PUBLISH_PORTS` (`PUBLISH_PORT_NOT_ALLOWED`) or a stack name the swarm
already runs (`STACK_EXISTS`).

`cap_drop: [ALL]` is intended. The agent runs as root and root already owns the
socket's access path, so it needs no capability. A host whose socket is not
owned by root needs group access instead: run the service as `0:<docker gid>`
and give the socket that group.

The rootfs is read-only with a tmpfs on `/tmp`. The only writable mounts are the
socket and the extensions folder.

Some `docker stack deploy` versions silently ignore `security_opt`
(`no-new-privileges`) and the short `tmpfs:` key. If ignored, the agent runs
without `no-new-privileges` (it is root with no capabilities, so the gain is
small) and `/tmp` is not a tmpfs; with a read-only rootfs `/tmp` is then simply
not writable, which the agent does not need. Check `docker inspect` on the task
container, or mount a `type: tmpfs` volume instead.

## Environment

Secrets are read from files only (`*_FILE`). All values are read once at start.

| Variable | Default | Meaning |
|---|---|---|
| `HUB_AGENT_TOKEN_FILE` | required | File with the bearer token (32+ characters, 8+ distinct). Generate it: `openssl rand -hex 32`. |
| `HUB_AGENT_HMAC_KEY_FILE` | the token | File with a separate key for signed values (same strength; `openssl rand -hex 32`). |
| `HUB_AGENT_LISTEN` | `127.0.0.1:7480` | `host:port` or `[ipv6]:port`. |
| `HUB_AGENT_TLS_CERT_FILE` / `HUB_AGENT_TLS_KEY_FILE` | none | Serve HTTPS. Both or neither. |
| `HUB_AGENT_INSECURE_HTTP` | off | `1` allows a non-loopback listen without TLS. Only on a private network. |
| `HUB_AGENT_DOCKER_SOCKET` | `/var/run/docker.sock` | Engine socket path. |
| `HUB_AGENT_IMAGES` | `nodeworks/nivaro` | Comma list of image repositories (no tag, no digest) a stack may name. Extension images share this list. |
| `HUB_AGENT_EDGE` | `traefik` | `traefik` or `publish`. |
| `HUB_AGENT_EDGE_NETWORK` | required for traefik | Overlay network Traefik routes over. |
| `HUB_AGENT_TRAEFIK_VERSION` | `3` | `3` or `2`: which Traefik reads the labels. `3` sets `traefik.swarm.network` (the v3 swarm provider); `2` sets `traefik.docker.network` (the v2 docker provider in swarm mode). Any other value refuses to start (`TRAEFIK_VERSION_BAD`). |
| `HUB_AGENT_ENTRYPOINTS` | `websecure` | Traefik entrypoints for app routers. |
| `HUB_AGENT_CERT_RESOLVER` | none | Traefik certificate resolver for app routers. |
| `HUB_AGENT_HOST_SUFFIXES` | required for traefik | Comma list such as `.apps.example.com`; an app host must end in one. |
| `HUB_AGENT_PUBLISH_PORTS` | required for publish | Range `lo-hi` (1024-65535) the agent may publish. |
| `HUB_AGENT_REDIS_IMAGE` | none | `<repo>[:<tag>]@sha256:<digest>` to offer a bundled Redis (the digest pins it; a tag alone is refused); omit to not offer it. |
| `HUB_AGENT_VOLUME_DRIVER` | `local` | Driver for uploads and Redis volumes. `local` is per node: see the warning below. |
| `HUB_AGENT_VOLUME_OPTS_FILE` | none | JSON object of driver options (for example an NFS export). `o=bind` and `device` (unless an NFS export) are refused. |
| `HUB_AGENT_EXTENSIONS_ROOT` | `/var/lib/nivaro-hub-agent/extensions` | Where the agent unpacks extensions (path inside the container). |
| `HUB_AGENT_EXTENSIONS_HOST_ROOT` | the root | The same folder as the host sees it; app services bind this path. |
| `HUB_AGENT_EXTENSIONS_SHARED` | off | `on` when the folder is shared storage every node mounts. |
| `HUB_AGENT_REGISTRY_AUTH_FILE` | none | A docker `config.json` with `auths`, for private registries. |
| `HUB_AGENT_ENV_PREFIXES` | none | Comma list of env key prefixes a stack may set on top of the keys Nivaro reads, such as `EFP_` or `EFP_OPS_` for the EFP extension. Each entry is upper-case segments ending with `_` (`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_$`). |
| `HUB_AGENT_CA_BUNDLE_FILE` | none | PEM file of extra CA certificates every app service trusts (see Company CA below). Read once at start; at most 256 KB, at least one `CERTIFICATE` block and no private key, else the agent refuses to start (`CA_BUNDLE_BAD`, never printing the file). |
| `HUB_AGENT_STORAGE_PATH` | none | LOCAL volumes only: absolute path where the agent sees the node's `/var/lib/docker/volumes`, mounted READ-ONLY, for storage health (see Storage health below). Refused with NFS volume options (`STORAGE_PATH_BAD`): storage health reads `HUB_AGENT_VOLUME_EXPORT_MOUNT` there. A relative path or a `..` segment stops the agent (`STORAGE_PATH_BAD`). |
| `HUB_AGENT_STORAGE_WALK` | on (local), off (NFS) | `on` / `off`: whether bytes and file count under the path are walked (anything else stops the agent, `STORAGE_WALK_BAD`). Off by default on NFS: a hung mount would pin the agent's I/O threads. |

## Volumes on a swarm of more than one node

**Warning:** the default `local` volume driver keeps one copy per node. On a
swarm with more than one node, each node a web, worker or importer task lands
on gets its own uploads, and a Redis task that moves to another node starts
empty. "Remove volumes" removes only this (the agent's) node's copies, because
the Engine's `/volumes` is node-local. Pin the stack to one node, or set a
shared volume driver (`HUB_AGENT_VOLUME_DRIVER` + `HUB_AGENT_VOLUME_OPTS_FILE`,
for example an NFS export). `GET /v1/health` reports `swarm.nodes` and
`volume_driver`; the Hub's stack panel warns when the swarm has more than one
node and volumes are local.

## Which env keys a stack may set

A stack's settings and secrets become env vars and `/run/secrets` files, so the
agent takes only an allow-list: the config keys the Nivaro app reads (a list
generated from the API's sources and shipped inside the agent) plus keys under
`HUB_AGENT_ENV_PREFIXES`. Anything else is refused with `SPEC_INVALID`
(`ENV_NOT_ALLOWED` on the field, which names the key and never the value). The
deny rules stay as a second layer, so a prefix never opens a refused key: `PATH`,
`LD_*`, `NODE_*` (except `NODE_ENV`), the library loader paths and every
`<KEY>_FILE` stay refused, and so do `HUB_SHARED_DEPLOYMENT` and
`HUB_DEPLOYMENT_TOKEN` (a deployment's mode and identity belong to the Hub).
`HUB_TOKEN` and `HUB_CLIENT_SECRET` are taken only as secrets, never as env. The Hub reads the prefixes from `GET /v1/health`
(`env_prefixes`) and refuses the same keys when stack settings are saved; when it
cannot reach the agent, no prefix counts. To let an extension read its own
settings, add its prefix here and restart the agent.

**Warning:** never choose a prefix that loader or toolkit variables share, such as
`GIO_`, `GTK_`, `GST_`, `QT_`, `MESA_` or `LD_`. Those variables make the app or
the programs it runs (Chromium, ffmpeg) load code from a path. The agent refuses
to start (`ENV_PREFIX_DENIED`) with a prefix that is a prefix of, or starts with,
any refused key or refused prefix, and the Hub ignores such a prefix too.

## Edge modes

- **`traefik`**: the agent adds the router, service and TLS labels and attaches
  the app to `HUB_AGENT_EDGE_NETWORK`. It sets exactly **one** network label to
  that network, chosen by `HUB_AGENT_TRAEFIK_VERSION`: `traefik.swarm.network`
  for Traefik v3 (the default), `traefik.docker.network` for v2. Never both:
  Traefik v3 skips a service that carries both ("both Docker and Swarm labels
  are defined"), so it would route nothing. Hosts outside
  `HUB_AGENT_HOST_SUFFIXES` are refused. A shared deployment's host pattern is a
  v3 `HostRegexp` router, so with `HUB_AGENT_TRAEFIK_VERSION=2` a `host_pattern`
  is refused (`HOSTNAME_NOT_ALLOWED`).
  A `large` stack runs web with sockets off and a `realtime` role: the
  realtime router takes `/socket.io/`, `/api/graphql-ws`, `/api/graphql/stream`,
  `/api/events/stream` and `/api/events/views/<id>/stream` (the same paths as
  `deploy/realtime`). It uses `PathRegexp`, so it needs Traefik v3: with
  `HUB_AGENT_TRAEFIK_VERSION=2` a `realtime` role is refused
  (`ROLE_NEEDS_TRAEFIK_V3`) instead of deploying without its realtime routes.
- **`publish`**: no labels; the app publishes a host port from
  `HUB_AGENT_PUBLISH_PORTS`.

**Upgrading the agent to 0.2.0 changes every stack hash.** The Traefik version
is part of each stack's hash, so after the upgrade every existing stack reads as
another spec: Restart answers `SPEC_MISMATCH` until the stack is applied again.
Apply each stack once after upgrading the agent (Apply now on a dedicated
environment; an upgrade or re-apply at the same version on a shared
deployment). That apply is also what removes the second network label older
agents set, which Traefik 3.5 and later skip the whole service for.

**0.2.1 (Hub move "Finish and stop the old home").** `GET /v1/stacks/:name/leftovers`
also answers `tasks_active`: the stack's tasks, across the swarm, whose containers
have not ended yet (a removed service's containers that are still shutting down
count). Removing a stack now deletes the app's services first and the stack's
Redis last. Stack hashes do not change. A Hub refuses "Finish and stop the old
home" for a Docker old home whose agent is older (it cannot prove the stop).

## Secrets in the app

Secret files the agent creates for an app are owned by uid and gid 1000 with
mode 0400. The Nivaro image drops from root to uid 1000 before Node starts, so a
root-owned 0400 file could not be read.

## Company CA

App services call the Hub over https (sign-in through the Hub, reports, a shared
deployment's tenant list). When a company or internal CA signs the Hub's
certificate, Node in the app container rejects it. A stack cannot fix that
itself: `NODE_EXTRA_CA_CERTS` and every `*_FILE` key stay refused as stack
settings. The operator hands the CA to the agent instead:

1. Put the CA certificates (root and any intermediates, PEM) in one file and
   mount it into the agent, for example as a secret:
   `docker secret create hub_agent_ca ./company-ca.pem`, then
   `HUB_AGENT_CA_BUNDLE_FILE=/run/secrets/hub_agent_ca`.
2. Restart the agent. `GET /v1/health` answers `ca_bundle: true`.
3. Apply each stack again from the Hub. Every app service (all roles of an app
   stack and of a shared deployment; not the bundled Redis, not the extension
   unpack container) gets a swarm secret `nvh_<stack>_ca-<sha12>` (the first 12
   hex of the bundle's sha256; uid/gid 1000, mode 0400) and
   `NODE_EXTRA_CA_CERTS=/run/secrets/nvh_<stack>_ca-<sha12>`, set by the agent.

The bundle's hash is part of each stack's spec hash, so after setting or
changing the bundle the stacks show a different spec and Restart answers
`SPEC_MISMATCH` until they are applied again. A changed bundle gets a new secret
name; the old secret is removed once nothing can roll back to it, like any
rotated secret. An agent without a bundle renders and hashes stacks exactly as
before.

## TLS

Without TLS the agent only listens on loopback (anything else needs
`HUB_AGENT_INSECURE_HTTP=1`). For a remote Hub, mount a certificate and key as
secrets and set the two `HUB_AGENT_TLS_*_FILE` variables. The Hub verifies the
certificate; use one its trust store accepts.

## Rotating the token

1. Create a new secret: `docker secret create hub_agent_token_v2 ./token.txt`.
2. In the stack file, point the `hub_agent_token` entry at it
   (`name: hub_agent_token_v2`, `external: true`) and deploy. The service restarts.
3. Update the token in the Hub's agent connection at the same time.
   Between the restart and the Hub update the Hub shows the agent as unreachable;
   nothing else changes.
4. Remove the old secret: `docker secret rm hub_agent_token`.

## Shared extensions storage

The agent unpacks extensions on its own node. By default an app that uses
extensions is pinned to that node so it finds the folder. If the folder is
shared storage that every node mounts (NFS, for example), set
`HUB_AGENT_EXTENSIONS_SHARED=on` and the pin is dropped. Keep
`HUB_AGENT_EXTENSIONS_ROOT` and `HUB_AGENT_EXTENSIONS_HOST_ROOT` pointing at the
same mount.

On start the agent removes leftovers of a crash: unpack containers and `.tmp-*`
folders more than five minutes old. A younger one may still be in use.

## Registry auth

For private registries mount a docker `config.json` as a secret and set
`HUB_AGENT_REGISTRY_AUTH_FILE`. Credentials are sent only to the registry that
matches the image being pulled, never anywhere else.

## Health

The container healthcheck is a TCP connect to the listen port (every 30 s, 15 s
timeout, 3 retries, 30 s start period: a short timeout got the agent killed on a
loaded host). `GET /v1/health` needs the token and is what the Hub uses. It
answers `traefik_version` too, so a shared deployment's upgrade plan refuses a
host pattern on a Traefik v2 agent before anything is applied. `ca_bundle` says
whether `HUB_AGENT_CA_BUNDLE_FILE` is set (never its contents).

## Storage health

The storage path is `HUB_AGENT_VOLUME_EXPORT_MOUNT` with NFS volume options (the
same export-root mount the volume work uses) and `HUB_AGENT_STORAGE_PATH` with
local volumes. With it set, `GET /v1/health` carries `storage`:
`{configured, kind: nfs|local, state: ok|pending|not_configured|unreadable|timeout,
total_bytes, free_bytes, used_bytes, used_pct, tree: {bytes, files, complete,
walked_at} | null, checked_at}`. The health call never waits on it: it answers
the last reading at once (`pending` before the first) and refreshes it in the
background every 30 s; a refresh still out after 5 s (a hung NFS mount) reads as
`timeout` with the last good figures, and no second one starts while it is out.
The tree (off by default on NFS) is walked in the background at most every 15
minutes, one directory at a time, links never followed, stopped at 2 million
entries or 2 minutes (`complete: false`). Figures and fixed words only: never a
path or a file name. Read-only: it creates, changes and removes nothing. For
local volumes, for example:

```yaml
    volumes:
      - type: bind
        source: /var/lib/docker/volumes
        target: /storage
        read_only: true
    environment:
      HUB_AGENT_STORAGE_PATH: /storage
```

The Hub reads it every 15 minutes (Apps hub → Storage, and each Docker driver's
page) and warns administrators and the owners of the apps on the driver at
80 % and 90 %.
