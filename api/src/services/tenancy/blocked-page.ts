/**
 * Neutral pages a Hub shared deployment answers with (Hub phase 5): an app that is suspended or
 * still being set up, and an address that serves no app. Nivaro Cloud keeps its own branded pages
 * (billing, nivaro.dev links) in middleware/tenant.ts; these name no product, link nowhere and
 * load nothing from outside, so any operator can run them.
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function page(title: string, heading: string, body: string, extraHead = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  ${extraHead}
  <title>${title}</title>
  <style>
    :root { --bg: #f8fafc; --card: #ffffff; --text: #0f172a; --muted: #475569; --line: #e2e8f0; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0f172a; --card: #1e293b; --text: #f1f5f9; --muted: #94a3b8; --line: #334155; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 24px 16px; background: var(--bg); color: var(--text);
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; line-height: 1.5;
    }
    main {
      width: 100%; max-width: 440px; padding: 32px 28px; background: var(--card);
      border: 1px solid var(--line); border-radius: 12px;
    }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 12px; overflow-wrap: anywhere; }
    p { font-size: 15px; color: var(--muted); }
    p + p { margin-top: 10px; }
  </style>
</head>
<body>
  <main>
    <h1>${heading}</h1>
    ${body}
  </main>
</body>
</html>`
}

/** The page for an app that is suspended or still being set up. Names the app (escaped). */
export function blockedPage(name: string, kind: 'suspended' | 'provisioning'): string {
  const app = escapeHtml(name.trim() || 'This app')
  if (kind === 'provisioning')
    return page(
      `${app} is being set up`,
      `${app} is being set up`,
      '<p>This usually takes a few minutes. This page checks again by itself.</p>',
      '<meta http-equiv="refresh" content="15" />'
    )
  return page(
    `${app} is not available`,
    `${app} is not available right now`,
    '<p>The people who run this app have paused it. Try again later, or ask them when it will be back.</p>'
  )
}

/** The page for an address that serves no app on this deployment. */
export function unknownHostPage(): string {
  return page(
    'No app here',
    'No app is served at this address',
    '<p>Check the address you opened, or ask the person who sent it to you for the right one.</p>'
  )
}
