# Nivaro Hub agent

A small service that runs on a Docker swarm **manager**. The Nivaro Hub calls it
to deploy, restart and remove app stacks. It is the only Hub component that
holds the Docker socket for writes.

- Image: `nodeworks/nivaro-hub-agent` (tag `@hub-agent-x.y.z` publishes `x.y.z` and `latest`)
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
| `HUB_AGENT_TOKEN_FILE` | required | File with the bearer token (32+ characters, 8+ distinct). |
| `HUB_AGENT_HMAC_KEY_FILE` | the token | File with a separate key for signed values (same strength). |
| `HUB_AGENT_LISTEN` | `127.0.0.1:7480` | `host:port` or `[ipv6]:port`. |
| `HUB_AGENT_TLS_CERT_FILE` / `HUB_AGENT_TLS_KEY_FILE` | none | Serve HTTPS. Both or neither. |
| `HUB_AGENT_INSECURE_HTTP` | off | `1` allows a non-loopback listen without TLS. Only on a private network. |
| `HUB_AGENT_DOCKER_SOCKET` | `/var/run/docker.sock` | Engine socket path. |
| `HUB_AGENT_IMAGES` | `nodeworks/nivaro` | Comma list of image repositories (no tag, no digest) a stack may name. Extension images share this list. |
| `HUB_AGENT_EDGE` | `traefik` | `traefik` or `publish`. |
| `HUB_AGENT_EDGE_NETWORK` | required for traefik | Overlay network Traefik routes over. |
| `HUB_AGENT_ENTRYPOINTS` | `websecure` | Traefik entrypoints for app routers. |
| `HUB_AGENT_CERT_RESOLVER` | none | Traefik certificate resolver for app routers. |
| `HUB_AGENT_HOST_SUFFIXES` | required for traefik | Comma list such as `.apps.example.com`; an app host must end in one. |
| `HUB_AGENT_PUBLISH_PORTS` | required for publish | Range `lo-hi` (1024-65535) the agent may publish. |
| `HUB_AGENT_REDIS_IMAGE` | none | `<repo>@sha256:<digest>` to offer a bundled Redis; omit to not offer it. |
| `HUB_AGENT_VOLUME_DRIVER` | `local` | Driver for uploads and Redis volumes. |
| `HUB_AGENT_VOLUME_OPTS_FILE` | none | JSON object of driver options (for example an NFS export). `o=bind` and `device` (unless an NFS export) are refused. |
| `HUB_AGENT_EXTENSIONS_ROOT` | `/var/lib/nivaro-hub-agent/extensions` | Where the agent unpacks extensions (path inside the container). |
| `HUB_AGENT_EXTENSIONS_HOST_ROOT` | the root | The same folder as the host sees it; app services bind this path. |
| `HUB_AGENT_EXTENSIONS_SHARED` | off | `on` when the folder is shared storage every node mounts. |
| `HUB_AGENT_REGISTRY_AUTH_FILE` | none | A docker `config.json` with `auths`, for private registries. |

## Edge modes

- **`traefik`**: the agent adds the router, service and TLS labels and attaches
  the app to `HUB_AGENT_EDGE_NETWORK`. It sets **both** `traefik.docker.network`
  and `traefik.swarm.network` to that network, so Traefik with either provider
  picks the right one. Hosts outside `HUB_AGENT_HOST_SUFFIXES` are refused.
- **`publish`**: no labels; the app publishes a host port from
  `HUB_AGENT_PUBLISH_PORTS`.

## Secrets in the app

Secret files the agent creates for an app are owned by uid and gid 1000 with
mode 0400. The Nivaro image drops from root to uid 1000 before Node starts, so a
root-owned 0400 file could not be read.

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

The container healthcheck is a TCP connect to the listen port. `GET /v1/health`
needs the token and is what the Hub uses.
