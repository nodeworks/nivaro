# Nivaro CMS — E2E Tests

Playwright + axe-core accessibility test suite for Nivaro CMS.

## Prerequisites

Both the API and Admin UI must be running before executing tests:

```bash
pnpm dev        # starts Redis + Inngest + API (:3055) + Admin (:3056) concurrently
```

Or start services individually:

```bash
pnpm dev:redis
pnpm dev:api
pnpm dev:admin
```

## Running tests

```bash
# Run all tests (headless, single worker)
pnpm test:e2e

# Watch mode with interactive UI
pnpm test:e2e:ui

# Headed mode (see the browser)
pnpm test:e2e:headed

# Run a single file
pnpm test:e2e tests/e2e/a11y.spec.ts
```

## Test suites

| File | What it covers |
|---|---|
| `login.spec.ts` | Redirect to /login, title, Microsoft button, JS errors, a11y |
| `public.spec.ts` | API health, root redirect, broken links, WCAG 2.1 AA |
| `navigation.spec.ts` | All protected routes redirect unauthenticated; 404 handling |
| `a11y.spec.ts` | Full axe scan, lang attr, label coverage, keyboard nav, focus visibility, 3 viewports |
| `api-health.spec.ts` | API smoke: health 200, 401 on protected endpoints without token |

## Reports

HTML report is written to `tests/e2e/reports/` after each run. Open with:

```bash
pnpm playwright show-report tests/e2e/reports
```

## Auth note

Full OIDC flows require a real Microsoft tenant. The current suite covers all
**unauthenticated / public** paths thoroughly. To add authenticated tests, create
a test user with a static token (`nivaro_users.static_token`) and pass it as a
Bearer header in a custom `APIRequestContext` fixture or use
`page.setExtraHTTPHeaders({ Authorization: 'Bearer <token>' })`.

## CI

Add to your pipeline after `build_production`:

```yaml
e2e:
  stage: test
  script:
    - pnpm install
    - pnpm exec playwright install chromium --with-deps
    - pnpm dev &
    - wait-on http://localhost:3056 http://localhost:3055/api/health
    - pnpm test:e2e
  artifacts:
    paths:
      - tests/e2e/reports/
