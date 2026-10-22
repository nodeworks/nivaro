# Staging mail

Staging keeps mail test mode on and catches mail in a Mailpit container. Mail
for an address on the test allowlist (Settings → Email) goes out for real
through the corporate relay, and a copy lands in Mailpit; mail for everyone
else goes only to Mailpit, addressed as it was, and never reaches them. The API
does this when `MAIL_CATCH_HOST` is set (`api/src/services/mail.ts`).
**Production is unchanged**: it sets neither, and sends through the corporate
relay directly.

The kit is in `deploy/staging/mailpit/` (`stack.yml`, `stack.relay.yml`,
`relay.example.yml`, `.env.example`). The staging deploy files live in
`efp-nivaro/.docker` (see [RELEASING.md](RELEASING.md)); copy the kit to
`.docker/mailpit/` there.

## Its own stack

Mailpit runs as its own Swarm stack, `efp_mail`, beside the `efp` stack. Do not
add it to `efp`: `.docker/deploy-swarm.sh` deploys `efp` from
`docker-stack.yml` alone with `--prune`, so a service added to that stack by
hand is removed on the next release, and `docker-stack.yml` is shared with
production.

On the staging manager, from `/var/efp/efp-nivaro`, after the `efp` stack exists
(it owns the `efp_internal` network that Mailpit joins):

```
docker node update --label-add mailpit=true <node>     # once: the node that holds the data volume
set -a; . .docker/mailpit/.env; set +a
docker stack deploy -c .docker/mailpit/stack.yml -c .docker/mailpit/stack.relay.yml efp_mail
```

(`stack.relay.yml` is optional; see "Turn relaying off".) The service is
`efp_mail_mailpit`. It joins `efp_internal` with the alias `mailpit`, so the API
(`efp_web`, `efp_worker`) reaches it as `mailpit:1025`. Port 1025 is never
published. A release of `efp` through `deploy-swarm.sh` leaves `efp_mail`
alone; `docker stack rm efp` cannot remove `efp_internal` while `efp_mail` is
attached, so remove `efp_mail` first.

## Point the API at it

In efp-nivaro's `../.env` (the `efp` stack's `env_file`), keep the corporate
relay as the SMTP host and test mode on, and add the catch host; then release
`efp` with `deploy-swarm.sh staging <release>`:

```
SMTP_HOST=mailrelay.example.com
SMTP_PORT=25
MAIL_TEST_MODE=true
MAIL_CATCH_HOST=mailpit
MAIL_CATCH_PORT=1025
```

`MAIL_TEST_RECIPIENT` is not used while `MAIL_CATCH_HOST` is set.

## Who gets real mail

Settings → Email → Test mode → **Allowlist**: comma-separated addresses and
`@domains`. Those get the real mail (and a copy shows in Mailpit, tagged
`delivered`); everyone else's is caught in Mailpit (tagged `caught`). The Email
tab says when a catch host is set. Change the list there at any time; it takes
effect on the next mail.

- `MAIL_TEST_MODE=true` in the env keeps test mode on whatever Settings says, so
  a prod database restored into staging cannot turn it off. Its allowlist
  comes with the restore (production's is normally empty), so after a restore
  nobody gets real mail until the list is set again.
- The allowlist and the SMTP settings live in the database; `MAIL_TEST_MODE` and
  `MAIL_CATCH_HOST` live in the env and survive a restore.
- If Mailpit is down, caught mail fails like any SMTP outage (logged
  `failed`, before anything goes out for real); a copy of delivered mail only
  logs a warning.

## Create and rotate the secrets

```
docker secret create mailpit_ui_auth_v1 ./htpasswd          # htpasswd -B file
docker secret create mailpit_relay_v1 ./relay.yml           # filled copy of relay.example.yml
```

Set `MAILPIT_UI_AUTH_SECRET` / `MAILPIT_RELAY_SECRET` in `.docker/mailpit/.env`
to those names. Secrets are immutable: to rotate, create a new name (`..._v2`),
set the variable and redeploy `efp_mail` (or `docker service update --secret-rm
<old> --secret-add source=<new>,target=<same target> efp_mail_mailpit`), then
`docker secret rm` the old one. The repo holds only the example files with
placeholders.

## Open the inbox

`https://efp-staging-api.cable.example.com/mailpit/` (`MAILPIT_UI_HOST`), then
sign in with the htpasswd login. Staging's Traefik v3 (`[providers.swarm]` on
`traefik_swarm`) reads the router from the service's `deploy.labels`: `Host` plus
`PathPrefix(/mailpit)`, priority 10 so it wins over the API's router (3), port
8025. Mailpit serves the UI and its API under `/mailpit/` (`MP_WEBROOT`), so no
prefix is stripped. The UI port is **not published**: Swarm's routing mesh
publishes on every node's interfaces and ignores a host IP. The kit test fails on
any live `ports:` entry on the mailpit service. The login is always required.

## Release a message

- UI: open the message, press **Release**, choose the original recipients or
  type different ones.
- REST: `POST /mailpit/api/v1/message/{ID}/release` with
  `{"To": ["person@nivaro.dev"]}` (same login).
- In tests: `GET /mailpit/api/v1/search?query=...`, `GET /mailpit/api/v1/messages`,
  `DELETE /mailpit/api/v1/messages` (body `{"IDs": [...]}`, or everything with no body).

A release goes only to addresses matching `allowed-recipients` and not
matching `blocked-recipients`.

## Where the settings live

| Setting | Place |
| --- | --- |
| Relay host, port, STARTTLS, auth, username, password, return-path | the `mailpit_relay` Swarm secret (a filled copy of `relay.example.yml`) |
| `allowed-recipients` (our domains) | the same relay YAML secret, `allowed-recipients:` |
| `blocked-recipients` (customer domains, probed admins; every relay mode) | the same relay YAML secret, `blocked-recipients:` |
| Optional auto-relay of one test mailbox | not enabled by this kit (see below) |

The relay settings, recipient regexes included, are kept in the YAML secret
only; `stack.yml` sets no `MP_SMTP_RELAY_*` variable (`MP_SMTP_RELAY_CONFIG` is
set in `stack.relay.yml`). Mailpit's per-setting relay env vars
(`MP_SMTP_RELAY_HOST`, `_PORT`, `_ALLOWED_RECIPIENTS`, …) are only read when
`MP_SMTP_RELAY_HOST` is set, so they are not used. To change any of these,
edit the file and rotate the secret. Credentials never go in a CLI flag, a
stack file or the repo. `--smtp-relay-all` is never set: catching everything is
the default.

The optional auto-relay (`MP_SMTP_RELAY_MATCHING`, a runtime option that works
with the YAML relay config) is **not part of this kit**: it would send every
matching message without anyone pressing Release. The kit test fails on any
`MP_SMTP_RELAY_*` variable other than `MP_SMTP_RELAY_CONFIG`, so enabling it is
a deliberate change to `scripts/mailpit-kit.test.mjs` and `stack.relay.yml`
together. **Warning:** `allowed-recipients` does not apply to auto-relay; only
`blocked-recipients` does, so keep the regex to one exact mailbox.

## Turn relaying off

Without a relay config Mailpit still catches every message; Release is simply
unavailable.

**Persistent way:** redeploy `efp_mail` without the relay fragment:

```
docker stack deploy -c .docker/mailpit/stack.yml efp_mail
```

`stack.relay.yml` is the only file that sets `MP_SMTP_RELAY_CONFIG` and the
`mailpit_relay` secret, so the redeploy removes both (and `MAILPIT_RELAY_SECRET`
need not be set). To turn it back on, deploy with `-c .docker/mailpit/stack.relay.yml`
again.

**Temporary stop only:** on the running stack

```
docker service update --env-rm MP_SMTP_RELAY_CONFIG --secret-rm <relay secret name> efp_mail_mailpit
```

The next `docker stack deploy` of `efp_mail` that includes `stack.relay.yml`
brings relaying back.

## Pitfalls

1. **Saved `smtp_*` settings win over `SMTP_*` env vars.** Host, port, secure,
   user and password from Settings → Email override the env; check them after
   a prod database restore. Caught mail does not depend on them (it goes to
   `MAIL_CATCH_HOST`), but allowlisted mail goes out through them.
2. **Keep `MAIL_TEST_MODE=true` on staging.** With test mode off the catch host
   does nothing and every mail goes out for real.
3. **Release sends real email** (only with `stack.relay.yml` deployed). That is
   why the UI is private and needs a login. The allowlist is the normal way to
   let mail through; Release is for one message.
4. **SMTP 1025 is reachable from every service on `traefik_swarm`, not only
   from the API.** Mailpit joins that shared overlay so Traefik can route the
   UI, and `MP_SMTP_AUTH_ACCEPT_ANY` accepts any login, so another service there
   could drop mail into the inbox. Accepted for staging: caught mail goes nowhere
   until someone signed in presses Release, and a release only reaches
   `allowed-recipients`. Read an unexpected message before releasing it. Closing
   this needs a dedicated overlay between Traefik and Mailpit (a change to the
   host-only proxy files) or real SMTP auth (`MP_SMTP_AUTH_FILE`, with an SMTP
   password secret added to the `efp` stack).
