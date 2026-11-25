import type { DocSection } from '../types.js'

export const hubSecurityDocs: DocSection = {
  id: 'hub-security',
  label: 'Security: access, certificates, scans',
  content: [
    { type: 'h1', id: 'hub-security', text: 'Security: access, certificates, scans' },
    {
      type: 'p',
      text: 'Two Apps hub tabs. Access holds break-glass access (temporary administrator access to one environment) and access reviews (an app’s owners confirm or remove every administrator and role holder). Security holds the certificate and DNS watch, image vulnerabilities, the compliance pack per app and the settings. Owners see their own apps; Hub administrators see every app and change the settings.'
    },

    { type: 'h2', id: 'hub-break-glass', text: 'Break-glass access' },
    {
      type: 'p',
      text: 'A person asks for administrator access to one environment of an app for a number of hours (1 up to the Hub’s longest grant, at most 24) and says why. Who may ask: the app’s owners and Hub administrators (and, once the incident feature is in the build, whoever is on call for the app during one of its open incidents).'
    },
    {
      type: 'ul',
      items: [
        'A Hub administrator approves or denies it. Nobody approves their own request — the one exception is the person on call during an open incident of the app, which the request records.',
        'Requests and decisions are made only by the person on their own browser session: never while viewing as someone else, with an API key, from the phone or by a connected app or assistant (`OWN_SESSION_ONLY`). Ending a grant early is allowed to any Hub administrator credential that may write, and to the requester on their own session.',
        'The app is asked over the hub link, by the requester’s proven identity (their Hub account’s email and Microsoft id). Their EXISTING, active account there gets the app’s administrator role; break-glass never creates, reactivates or un-suspends an account. An account already an administrator is left as it is (Not needed).',
        'The app stores the expiry and the role it replaced on the account itself. It puts the role back by itself when the time runs out — its own job every minute, and every request the person makes judges it first — so a grant ends on time even when the Hub cannot be reached. The Hub revokes at the same time and keeps retrying until the app answers. A grant the Hub could not confirm within 30 minutes is revoked anyway.',
        'An administrator who changes the person’s role during the grant decided on purpose: the role stays as they set it.',
        'Every step is logged in the Hub and in the app, and told to the app’s owners and Hub administrators; a request on production is urgent. A request nobody decided within 24 hours is withdrawn.'
      ]
    },

    { type: 'h2', id: 'hub-access-reviews', text: 'Access reviews' },
    {
      type: 'p',
      text: 'An access review reads, over each environment’s hub link, every account that holds a role there — administrators first, service accounts included — with its role, status and last sign-in. The app’s owners (or a Hub administrator) mark each one Keep or Remove, then Complete the review.'
    },
    {
      type: 'ul',
      items: [
        'Removals go through the app’s people suspend route — the same one Offboard everywhere uses: suspend only, never delete, refused for the app’s last active administrator (Kept: last admin there). A service account or an account without an email is never suspended over the link: remove it in the app.',
        'An environment the Hub cannot reach is named in the review and its accounts are not in it.',
        'Evidence: a CSV of every account with its decision, who decided and what the removal answered, and a PDF summary (when this Hub has Chromium or a render peer).',
        'Schedule: a Hub administrator sets per app how often a review starts by itself (monthly, quarterly, every 6 or 12 months) and how many days the owners have. A review starts on the first of the month; owners are told when it is ready and once when it is overdue.'
      ]
    },

    { type: 'h2', id: 'hub-tls-watch', text: 'Certificates and names' },
    {
      type: 'p',
      text: 'Every 6 hours the Hub resolves every environment address and hostname (DNS) and reads the certificate the server presents — a TLS handshake only, read even when it does not verify. Owners and Hub administrators are warned once at 30, 14 and 3 days before expiry, when it has expired, and once when a name stops resolving. A renewed certificate starts the warnings over. Each expiry is also a change-calendar entry when the change calendar is in the build.'
    },

    { type: 'h2', id: 'hub-image-scan', text: 'Image vulnerabilities' },
    {
      type: 'p',
      text: 'The Hub knows every image digest it pins: the Nivaro image of each environment’s newest Docker deploy, its extension pins, and a shared deployment’s image and extension pins (counted for every app placed on it). Each night at 04:40 — and on Scan now — it sends each digest to the scanner endpoint an administrator set, and keeps the known vulnerabilities per digest (resolved when a later scan no longer lists them). Without a scanner endpoint nothing is scanned and nothing leaves the Hub.'
    },
    {
      type: 'pre',
      code: 'POST {scanner}/scan   Authorization: Bearer <token>\n{"image": "nodeworks/nivaro@sha256:…"}\n\n200 {"vulnerabilities": [{"id": "CVE-2026-1234", "severity": "high",\n      "package": "openssl", "installed": "3.0.1", "fixed": "3.0.7",\n      "url": "https://…", "summary": "…"}]}'
    },
    {
      type: 'note',
      text: 'The scanner is any service that speaks this contract — a small wrapper around Trivy, Grype or OSV-Scanner. The Hub agent runs no scanner: it stays the only, narrow Docker writer. The call goes through the SSRF guard; a scanner on a private address needs SSRF_ALLOW_HOSTS.'
    },

    { type: 'h2', id: 'hub-compliance-pack', text: 'Compliance pack' },
    {
      type: 'p',
      text: 'One zip per app for an auditor, covering the last 3–24 months: a summary PDF (an HTML summary when this Hub cannot make PDFs) and CSVs of deploys, access reviews, break-glass access, database and files backups and restore drills, secret rotations (names and when, never values), incidents, certificates and open vulnerabilities, with a README. The pack never carries a token, key, password, connection string or sealed value. Owners and Hub administrators download it; every download is logged.'
    },

    { type: 'h2', id: 'hub-security-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        ['GET /api/hub/break-glass', 'Owner, admin', 'Requests (always your own)'],
        [
          'POST /api/hub/environments/:envId/break-glass',
          'Owner, admin (own session)',
          '{hours, reason}'
        ],
        ['POST /api/hub/break-glass/:id/approve | deny', 'Admin (own session)', 'Decide'],
        [
          'POST /api/hub/break-glass/:id/cancel | revoke',
          'Requester / admin',
          'Withdraw / end now'
        ],
        ['POST /api/hub/apps/:id/access-reviews', 'Owner, admin', 'Start a review (202)'],
        ['POST /api/hub/access-reviews/:id/decisions', 'Owner, admin', '{items: [{id, decision}]}'],
        ['POST /api/hub/access-reviews/:id/complete', 'Owner, admin', 'Run the removals (202)'],
        ['GET /api/hub/access-reviews/:id/evidence.csv | .pdf', 'Owner, admin', 'Evidence'],
        ['GET /api/hub/apps/:id/compliance-pack?months=', 'Owner, admin', 'Zip'],
        ['GET /api/hub/security/certificates · POST …/check', 'Owner · admin', 'TLS / DNS watch'],
        ['GET /api/hub/security/vulnerabilities · POST …/scan', 'Owner · admin', 'Image scan'],
        ['GET | PUT /api/hub/security/settings', 'Admin', 'Scanner, longest grant, TLS watch']
      ]
    },
    {
      type: 'p',
      text: 'App side (0.3.215+, behind the hub link’s bearer): GET /api/hub-link/security/role-holders, POST /api/hub-link/security/break-glass and …/break-glass/revoke (on a shared deployment under /api/hub-deployment/apps/:id/security/*). Jobs: hub-break-glass (every minute), hub-security-tick (every 30 minutes), hub-vuln-scan (04:40) on the Hub; hub-break-glass-expire (every minute) on every app linked to a Hub.'
    }
  ]
}
