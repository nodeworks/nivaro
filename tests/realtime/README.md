# Realtime CI

Black-box tests of the realtime tier (`NIVARO_ROLE=realtime`, web with `SOCKETS=off`) against
an isolated Docker stack — its own SQL Server, Redis, toxiproxy and Traefik. Nothing here touches
a dev, staging or production database.

## Stack

```bash
pnpm install                                   # the suites resolve socket.io-client, ws, ioredis from the workspace
deploy/realtime-ci/rtci.sh up tier             # build the worktree's slim image, start, migrate, seed
deploy/realtime-ci/rtci.sh up single --image nivaro-rtci:main   # today's shape: sockets on web
deploy/realtime-ci/rtci.sh up tier --v2        # also Traefik v2.4 on :24082 (run suites with --v2)
deploy/realtime-ci/rtci.sh build <tag> [<git ref>]               # e.g. an image of main for mixed versions
deploy/realtime-ci/rtci.sh down                # stop and remove volumes
```

Ports are in `deploy/realtime-ci/rtci.env` (Traefik v3 `127.0.0.1:24080`). The first boot runs
every migration on an empty database (about two minutes). On an arm64 Mac whose Docker has no
Rosetta, SQL Server 2022 crashes under qemu, so the stack uses Azure SQL Edge there.

The seed (`tests/realtime/seed.mjs`, run by `up`) works through the API as a bootstrap admin that
`rtci.sh` inserts by SQL, together with the default workspace row and the two legacy tables
presence and chat write to (`deploy/realtime-ci/legacy-tables.sql`) — a fresh install has none.

## Suites

```bash
node tests/realtime/run.mjs --suite parity     # every realtime feature, tier vs single
node tests/realtime/run.mjs --suite auth       # sign-in paths, sign-out/revoke → socket closed, room authz
node tests/realtime/run.mjs --suite failover [--alt-image nivaro-rtci:main]
node tests/realtime/run.mjs --suite load --users 250 --ramp-min 5 --hold-min 5
node tests/realtime/run.mjs --suite load --users 250 --ramp-min 10 --soak-min 60
node tests/realtime/run.mjs --suite all        # parity, auth, failover
```

`--only <text,…>` runs the cases whose name contains one of the strings. Results go to
`reports/realtime/<run id>/<suite>.json` plus `summary.md` / `summary.json`. Compare two runs
(e.g. single vs tier):

```bash
node tests/realtime/report.mjs reports/realtime/<tier run> --compare reports/realtime/<single run>
```

Each suite lists what it does not cover in its result (`untested`).
