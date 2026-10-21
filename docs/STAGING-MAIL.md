# Staging mail

Staging sends all mail to a Mailpit container. Every message is caught in a web
inbox; a real email goes out only when someone releases it by hand. There is no
app change: the API reads `smtp_host` / `SMTP_HOST` as always
(`api/src/services/mail.ts` `getSmtpConfig`). **Production is unchanged** and
keeps sending through the corporate relay directly.

The kit is in `deploy/staging/mailpit/` (`stack.yml`, `relay.example.yml`,
`.env.example`); the staging deploy files live in `efp-nivaro/.docker` (see
[RELEASING.md](RELEASING.md)), so copy the kit there. Staging runs on Docker
Swarm: merge the `mailpit` service, `secrets` and `volumes` of `stack.yml` into
the staging stack and deploy with `docker stack deploy` (source the `.env` first,
so the `${MAILPIT_*}` values are substituted). The API reaches it by service
name on the stack overlay network: `SMTP_HOST=mailpit`, `SMTP_PORT=1025`,
`SMTP_SECURE=false`. Port 1025 is never published. Label the node that holds
the data volume once: `docker node update --label-add mailpit=true <node>`.

## Create and rotate the secrets

```
docker secret create mailpit_ui_auth_v1 ./htpasswd          # htpasswd -B file
docker secret create mailpit_relay_v1 ./relay.yml           # filled copy of relay.example.yml
```

Set `MAILPIT_UI_AUTH_SECRET` / `MAILPIT_RELAY_SECRET` to those names. Secrets
are immutable: to rotate, create a new name (`..._v2`), set the variable and
redeploy the stack (or `docker service update --secret-rm old --secret-add
source=new,target=... <stack>_mailpit`), then `docker secret rm` the old one.
The repo holds only the example files with placeholders.

## Open the inbox

The UI (port 8025) is **not published**. Swarm's routing mesh publishes on every
node's interfaces and ignores a host IP, so binding to a private address does
not work. Reach it through the stack's reverse proxy on the private network/VPN
(proxy to `mailpit:8025`; the proxy joins the overlay network; never a public
route), then sign in with the htpasswd login. The login is required either way.
Alternative: publish with `mode: host` (see the comment in `stack.yml`); then
the port is open on that node's interfaces, so a firewall rule must allow 8025
only from the VPN/private range and drop the rest.

## Release a message

- UI: open the message, press **Release**, choose the original recipients or
  type different ones.
- REST: `POST /api/v1/message/{ID}/release` with `{"To": ["person@nivaro.dev"]}`
  (same login).
- In tests: `GET /api/v1/search?query=...`, `GET /api/v1/messages`,
  `DELETE /api/v1/messages` (body `{"IDs": [...]}`, or everything with no body).

A release goes only to addresses matching `allowed-recipients` and not
matching `blocked-recipients`.

## Where the settings live

| Setting | Place |
| --- | --- |
| Relay host, port, STARTTLS, auth, username, password, return-path | the `mailpit_relay` Swarm secret (a filled copy of `relay.example.yml`) |
| `allowed-recipients` (our domains) | `MAILPIT_ALLOWED_RECIPIENTS` in the deploy `.env`; keep the relay secret file equal |
| `blocked-recipients` (customer domains, probed admins; every relay mode) | `MAILPIT_BLOCKED_RECIPIENTS`; keep the relay secret file equal |
| Optional auto-relay of one test mailbox | `MAILPIT_RELAY_MATCHING` (`matching` in the secret file) |

Change a variable and redeploy the stack; change the secret file by rotating the secret. Credentials
never go in a CLI flag, `stack.yml` or the repo. `--smtp-relay-all` is never
set: catching everything is the default. **Warning:** `allowed-recipients` does
not apply to auto-relay (matching); only `blocked-recipients` does, so keep the
matching regex to one exact mailbox.

## Turn relaying off

Remove the `mailpit_relay` secret and `MP_SMTP_RELAY_CONFIG` from the service (and unset
`MAILPIT_RELAY_MATCHING`), then redeploy. Catching keeps working; nothing can be released.

## Pitfalls

1. **DB `smtp_host` wins over `SMTP_HOST`.** A host saved in Settings → Mail
   (`nivaro_settings`) overrides the env. After restoring a prod DB into
   staging, check it and clear it or point it at `mailpit`, otherwise staging
   mails through the corporate relay directly.
2. **Mail test mode rewrites recipients before Mailpit sees them**
   (`MAIL_TEST_MODE` / Settings test mode). With it on, "release to original
   recipients" goes to the test recipient. Staging should run with test mode
   **off** so Mailpit holds the true recipients, and the allowed/blocked regexes
   do the protecting.
3. **Release sends real email.** That is why the UI is private and needs a login.
