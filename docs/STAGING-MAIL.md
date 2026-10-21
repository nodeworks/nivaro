# Staging mail

Staging sends all mail to a Mailpit container. Every message is caught in a web
inbox; a real email goes out only when someone releases it by hand. There is no
app change: the API reads `smtp_host` / `SMTP_HOST` as always
(`api/src/services/mail.ts` `getSmtpConfig`). **Production is unchanged** and
keeps sending through the corporate relay directly.

The kit is in `deploy/staging/mailpit/` (`compose.yml`, `relay.example.yml`,
`.env.example`); the staging deploy files live in `efp-nivaro/.docker` (see
[RELEASING.md](RELEASING.md)), so copy the kit there. Set the API to
`SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_SECURE=false`.

## Open the inbox

The UI is bound to `MAILPIT_UI_BIND` (loopback or the private/VPN address),
port 8025, and asks for a login from the htpasswd file at
`MAILPIT_UI_AUTH_FILE`. Connect to the VPN (or tunnel to the host), browse to
`http://<MAILPIT_UI_BIND>:8025` and sign in. It is never behind the public proxy.

## Release a message

- UI: open the message, press **Release**, choose the original recipients or
  type different ones.
- REST: `POST /api/v1/message/{ID}/release` with `{"To": ["person@nivaro.dev"]}`
  (basic auth as above).
- In tests: `GET /api/v1/search?query=...`, `GET /api/v1/messages`,
  `DELETE /api/v1/messages` (body `{"IDs": [...]}`, or everything with no body).

A release goes only to addresses matching `allowed-recipients` and not
matching `blocked-recipients`.

## Where the settings live

| Setting | Place |
| --- | --- |
| Relay host, port, STARTTLS, auth, username, password, return-path | the relay config file (`MAILPIT_RELAY_CONFIG_FILE`, from `relay.example.yml`) and/or `MP_SMTP_RELAY_*` in the host secrets env file (`MAILPIT_RELAY_ENV_FILE`) |
| `allowed-recipients` (our domains) | `MAILPIT_ALLOWED_RECIPIENTS` in the deploy `.env`; keep the relay file equal |
| `blocked-recipients` (customer domains, probed admins; every relay mode) | `MAILPIT_BLOCKED_RECIPIENTS`; keep the relay file equal |
| Optional auto-relay of one test mailbox | `MAILPIT_RELAY_MATCHING` (`matching` in the file) |

Change a value, then `docker compose up -d mailpit` to restart. Credentials
never go in a CLI flag, `compose.yml` or the repo. `--smtp-relay-all` is never
set: catching everything is the default. **Warning:** `allowed-recipients` does
not apply to auto-relay (matching); only `blocked-recipients` does, so keep the
matching regex to one exact mailbox.

## Turn relaying off

Remove or unset the relay config (and `MP_SMTP_RELAY_*`, `MAILPIT_RELAY_MATCHING`)
and restart Mailpit. Catching keeps working; nothing can be released.

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
