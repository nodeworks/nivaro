# .hub/

Files the Nivaro Hub writes on each environment branch. Do not edit them by hand on an
environment branch: the Hub rewrites them, and a promotion compares against them.

| File | What it holds |
|---|---|
| `app.env` | The environment's settings, one `KEY=value` per line (APP_KEY, ENV_KEY, STACK_NAME, APP_HOSTS, PUBLIC_URL, ADMIN_URL, HUB_URL, NIVARO_ENVIRONMENT, DB_CLIENT, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, PROXY_NETWORK, TRUST_PROXY). Never a secret. The deploy job refuses any other key. |
| `nivaro-version` | The pin: line 1 the Nivaro version, line 2 the image digest (`sha256:` + 64 hex, required). `latest` and a pin without a digest are refused. |

The project's CI configuration path is set by the Hub to `ci/deploy.yml@<template>:<ref>`, so the
deploy job always comes from the Hub-owned template at a pinned ref. The `.gitlab-ci.yml` the Hub
also commits (only an `include` of that file) is a fallback, never what decides.

`main` has neither file, so a push to `main` never deploys. The template's own copy of this
folder holds only this README.

Secrets never live in the repository. The Hub sets them as CI variables scoped to the
environment, masked and protected, each the base64 of its value:
`NIVARO_DB_URL_B64`, `NIVARO_HUB_TOKEN_B64`, `NIVARO_SESSION_SECRET_B64`,
`NIVARO_ENCRYPTION_KEY_B64`, `NIVARO_OIDC_CLIENT_SECRET_B64`. The session secret and the
encryption key are made once and never replaced: a new encryption key would make the app's
sealed values unreadable.
