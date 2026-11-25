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
| `HUB_AGENT_VOLUME_DRIVER` | `local` | Driver for the uploads volumes (and Redis, unless set below). `local` is per node: see the warning below. |
| `HUB_AGENT_VOLUME_OPTS_FILE` | none | JSON object of driver options for the uploads volumes. `o=bind` and `device` (unless an NFS export) are refused. From 0.2.3 an NFS `device` is the export ROOT: each stack gets its own folder under it (see Uploads on an NFS export). `device: "nas01:/volume1"` is taken as `":/volume1"` with `addr=nas01`; an `addr=` naming another host, or NFS on the `local` driver with no device, refuses to start (`VOLUME_OPTS_BAD`). |
| `HUB_AGENT_VOLUME_EXPORT_MOUNT` | none | 0.2.3: where the agent's own container mounts that same NFS export, so it can check and make each stack's folder before a deploy. Absolute, no `..`; only with an NFS `device` (else `VOLUME_EXPORT_MOUNT_BAD`). Without it, a stack on the export is refused (`EXPORT_MOUNT_MISSING`) and the Hub's plan says so. |
| `HUB_AGENT_REDIS_VOLUME_DRIVER` / `HUB_AGENT_REDIS_VOLUME_OPTS_FILE` | see below | 0.2.3: the bundled Redis volume's own driver and options. Default: the uploads driver and options, except `local` with none when those mount NFS. NFS options here are refused (`REDIS_VOLUME_OPTS_BAD`): Redis never sits on NFS. |
| `HUB_AGENT_REDIS_PIN_LABEL` | none | 0.2.3: `key=value` of a swarm node label; bundled Redis then runs only on nodes carrying it (`node.labels.<key>==<value>`), so its local volume is always there. Label the node yourself (`docker node update --label-add nivaro.redis=1 <node>`). Unset: Redis may run on any node and starts empty after it moves. Never the agent's own node. Bad form: `REDIS_PIN_LABEL_BAD`. |
| `HUB_AGENT_EXTENSIONS_ROOT` | `/var/lib/nivaro-hub-agent/extensions` | Where the agent unpacks extensions (path inside the container). |
| `HUB_AGENT_EXTENSIONS_HOST_ROOT` | the root | The same folder as the host sees it; app services bind this path. |
| `HUB_AGENT_EXTENSIONS_SHARED` | off | `on` when the folder is shared storage every node mounts. |
| `HUB_AGENT_REGISTRY_AUTH_FILE` | none | A docker `config.json` with `auths`, for private registries. |
| `HUB_AGENT_ENV_PREFIXES` | none | Comma list of env key prefixes a stack may set on top of the keys Nivaro reads, such as `EFP_` or `EFP_OPS_` for the EFP extension. Each entry is upper-case segments ending with `_` (`^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_$`). |
| `HUB_AGENT_CA_BUNDLE_FILE` | none | PEM file of extra CA certificates every app service trusts (see Company CA below). Read once at start; at most 256 KB, at least one `CERTIFICATE` block and no private key, else the agent refuses to start (`CA_BUNDLE_BAD`, never printing the file). |

## Volumes on a swarm of more than one node

**Warning:** the default `local` volume driver keeps one copy per node. On a
swarm with more than one node, each node a web, worker or importer task lands
on gets its own uploads, and a Redis task that moves to another node starts
empty. "Remove volumes" removes only this (the agent's) node's copies, because
the Engine's `/volumes` is node-local. Pin the stack to one node, or put the
uploads on an NFS export (below). `GET /v1/health` reports `swarm.nodes`,
`volume_driver` and (0.2.3) `volume_nfs`; the Hub's stack panel warns when the
swarm has more than one node and volumes are local and not on an NFS export.

## Uploads on an NFS export (0.2.3)

Give the agent the export ROOT, once:

```json
{"type": "nfs", "o": "addr=nas.example.com,rw,nfsvers=4", "device": ":/volume1/nivaro"}
```

in `HUB_AGENT_VOLUME_OPTS_FILE`, and mount the same export into the agent's own
container at `HUB_AGENT_VOLUME_EXPORT_MOUNT` (`stack.example.yml` shows both).
**One export per agent:** two Hub agents (two swarms) never share an export; the
agent refuses a stack folder another swarm made (below).

Before relying on it, check that the file server lets a client mount a folder
BELOW the export (every stack folder depends on that):

```sh
docker volume create --driver local --opt type=nfs \
  --opt o=addr=nas.example.com,rw,nfsvers=4 --opt device=:/volume1/nivaro/some-folder probe
docker run --rm -v probe:/x alpine ls /x && docker volume rm probe
```

- **One folder per stack.** Each stack's uploads volume mounts
  `<export>/<stack>/uploads` (`:/volume1/nivaro/acme-prod/uploads`). Two stacks
  never share a folder: a stack whose folder is, holds or sits inside the folder a
  running service of another Hub stack mounts is refused (`409
  UPLOADS_FOLDER_TAKEN`). Volume objects left behind do not count. The volume is
  named `nvh_<stack>_uploads-<10 hex>`, a digest of its driver and options: Docker
  never changes an existing volume's options, so a new folder takes a new volume.
  The engine guard lets a stack's uploads volume name only that stack's folder.
- **The folder is made before the deploy.** Docker's NFS driver does not create
  the folder a `device` names (every task would fail to mount), so before any
  Docker write the agent checks it through its export mount. It creates `<stack>`
  (mode 0755) with a marker file `.nivaro-hub-agent` naming its swarm and the
  stack, then `<stack>/uploads`, and hands `<stack>/uploads` (only that, and only
  when this run created it) to uid 1000 through a handle opened without following
  links, after checking the handle is the very folder it checked. A `<stack>`
  folder without its marker (another system's folder, another swarm's) is never
  used: `409 UPLOADS_FOLDER_NOT_OURS`; adopt it explicitly if you mean it. The
  agent runs without capabilities, so the hand-over works only when the export
  maps the agent's writes to uid 1000 already (Synology "map all users",
  `all_squash,anonuid=1000`), or with `no_root_squash` and `cap_add: [CHOWN]` on
  the agent. Otherwise create `<stack>/uploads` on the file server yourself, owned
  by 1000:1000, and apply again. Refusals: `409 UPLOADS_FOLDER_MISSING`,
  `UPLOADS_FOLDER_NOT_WRITABLE` (uid 1000 cannot write it, by mode bits; an
  existing folder is never chowned), `UPLOADS_FOLDER_UNCHECKED` (the agent cannot
  look), `UPLOADS_FOLDER_PARENT_WRITABLE`, `409 EXPORT_MOUNT_MISSING`.
- **Links are never followed, and nobody else may write above the folder.** The
  app writes inside its folder, so every segment from the export mount down is
  read without following links; a link or a file where a folder should be is
  refused (`409 UPLOADS_FOLDER_LINK`), and the folder's real path must be exactly
  `<export>/<folder>`. Every folder ABOVE the uploads folder, the export root
  included, must not be group- or other-writable (`409
  UPLOADS_FOLDER_PARENT_WRITABLE`; `chmod go-w` on the file server). **These
  checks hold when the stack is applied.** Docker resolves the device again every
  time a task starts, on every node: keep the export root and each `<stack>`
  writable by the file server's administrators only, and let no service mount the
  export root itself once Hub stacks share it.
- **Adopt an existing folder.** A stack's `uploads_folder` (a relative path under
  the export, 1–8 parts of letters, digits, `.`, `_` and `-`, no `..`) is used as
  it is instead of `<stack>/uploads`: never created, chowned, changed or deleted.
  It must exist and uid 1000 must be able to write it. The export root itself
  cannot be adopted. `files_subfolder` says where the files sit inside the
  volume: `STORAGE_LOCAL_ROOT` becomes `/app/uploads/<files_subfolder>`; the agent
  only checks it (an adopted folder must already hold it; in the stack's own
  folder the app creates it).
- **Who runs the app.** The image starts as root and steps down to uid 1000. On
  an export with root squash root in the container is `nobody` there, so the
  step-down only works while the folder's top level holds nothing uid 1000 cannot
  write; a stray root-owned file keeps the server root, and root can then write
  nothing. A stack's `run_as: app` makes every app service run as `1000:1000`
  from the start (ContainerSpec.User; the only user the agent ever sets). The
  secret files already belong to uid 1000.
- **Redis never on NFS.** Bundled Redis gets a `local` volume (or
  `HUB_AGENT_REDIS_VOLUME_*`). It is not pinned unless you set
  `HUB_AGENT_REDIS_PIN_LABEL`: then it runs only on the nodes you labelled. An
  unpinned Redis that moves to another node starts empty (sign-ins and locks
  reset; the data is rebuildable); a pinned one waits for a labelled node. The
  agent's own node never enters a stack, so an agent that moves changes nothing.
- **Remove never touches the share.** With "Remove volumes" the agent deletes the
  stack's Redis volume but keeps every volume on the NFS export (answered as
  `kept_volumes`, listed apart as `share_volumes` in leftovers; they hold nothing
  themselves and block nothing). Its files stay on the file server. A move, its
  rollback and "Finish and stop the old home" keep volumes anyway. Delete a
  folder on the file server when you mean it; `docker volume rm` the volume
  object by hand if you want it gone.
- **Stack hashes.** An agent with an NFS `device` (or a Redis volume or pin of its
  own) hashes every stack differently from 0.2.1: apply each stack once after
  the upgrade. An agent without NFS keeps every hash.

### Upgrading from an agent before 0.2.3 with an NFS device

Older agents mounted the export ROOT itself into every stack, so their files are
there, mixed. While a stack's running service still mounts the export root, an
apply is refused (`409 UPLOADS_LAYOUT_CHANGED`) instead of starting the app on an
empty folder. For each such stack: move its files into a folder of their own on
the file server (owned by uid 1000), set the stack's uploads folder to it in the
Hub, then apply.

### Example: an app whose files are already on the NAS

EFP production mounts the NFS export itself at `/app/uploads` and reads its files
from `directus-uploads/` (owned by uid 1000). The export root cannot be adopted,
so give the agent that export as `device` and adopt the files folder directly:
`uploads_folder: directus-uploads`, no files sub-folder (the app's
`STORAGE_LOCAL_ROOT` becomes `/app/uploads`, which is that folder), and
`run_as: app`. Run the sub-folder probe above against `directus-uploads` first,
and check the export root is not group- or other-writable.

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

**0.2.2.** Takes the `exporter` role and a split shared deployment.

**0.2.3 (files on an NFS export).** One uploads folder per stack under the
export, the `uploads_folder` / `files_subfolder` / `run_as` stack fields,
`HUB_AGENT_VOLUME_EXPORT_MOUNT`, `HUB_AGENT_REDIS_VOLUME_*`,
`HUB_AGENT_REDIS_PIN_LABEL`, and `volume_nfs`, `export_mount`,
`redis_volume_driver`, `redis_pin_label` in `GET /v1/health` (see Uploads on an
NFS export). The Hub sends those stack fields only to a 0.2.3 agent (else the
plan stops with `AGENT_TOO_OLD`). Hashes change only on an agent with an NFS
export or a Redis volume or pin of its own.

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
