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
      text: 'A person asks for administrator access to one environment of an app for a number of hours (1 up to the Hub’s longest grant, at most 24) and says why. Who may ask: the app’s owners, Hub administrators, and whoever is on call for the app during one of its open SEV 1 or SEV 2 incidents.'
    },
    {
      type: 'ul',
      items: [
        'A Hub administrator approves or denies it. Nobody approves their own request — except the person on call by the rota schedule (not by an override created in the last 24 hours) during an open SEV 1 or SEV 2 incident of the app that someone else opened. Such a grant ends when the incident resolves or its hours run out, whichever comes first, and every Hub administrator and owner is told at once.',
        'Requests and decisions are made only by the person on their own browser session: never while viewing as someone else, with an API key, from the phone or by a connected app or assistant (`OWN_SESSION_ONLY`). Ending a grant early is allowed to any Hub administrator credential that may write, and to the requester on their own session.',
        'The requester is judged again when the request is approved and again before the grant goes out: still an active Hub account, not offboarded, still an owner / administrator / on call (`REQUESTER_NOT_ALLOWED`). Offboard everywhere withdraws their requests and revokes their grants.',
        'The app is asked over the hub link by the requester’s proven identity. A Microsoft identity the Hub knows must be the app account’s own; an email alone counts only when neither side has one (`IDENTITY_MISMATCH`). Their EXISTING, active account gets the app’s administrator role; break-glass never creates, reactivates or un-suspends an account.',
        'The app keeps each grant in its own table (nivaro_break_glass_grants — the users table is never altered) and computes the end itself from the hours, so a clock difference cannot stretch it. Every request the person makes reads the grant in the same statement as their role: once it has ended — or if it cannot be read — they run with the role it replaced. The app ends grants by itself (a core job every minute, and its socket sweep), and the Hub revokes at the same time and retries until the app answers. A revoke that arrives before its grant leaves a marker, so a late grant is refused.',
        'While a grant holds, the person cannot change roles or policies, or anyone’s role including their own (`BREAK_GLASS_ACTIVE`). When it ends, the role it replaced comes back whenever the account’s role carries admin access — even another admin role someone set meanwhile; a change to a role without admin access stays. Either way the owners and administrators get an urgent notice naming who changed what.',
        'A break-glass administrator never counts as an administrator for the last-admin lock: a permanent administrator cannot be removed while only a grantee would be left, and an offboard of a grantee ends the grant first and is never refused because of it. Their sockets end when the grant does, and View-as tokens they started stop working.',
        'Every step is logged in the Hub and in the app (with who asked and who approved); the end notice says how many changes the account made during the grant, with a link to its activity in the app. A request nobody decided within 24 hours is withdrawn.'
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
        'Removals go through the app’s people suspend route — the same one Offboard everywhere uses: suspend only, never delete, refused for the app’s last active administrator (Kept: last admin there). Each removal names the reviewed account by its id and is refused (Changed since the review) when its email or Microsoft identity changed since the review was read; an account marked Keep is never touched. A service account is never suspended over the link: remove it in the app. Removals wait while the app is frozen (`FROZEN`).',
        'An environment the Hub cannot reach is named in the review and its accounts are not in it.',
        'Evidence: a CSV of every account with its decision, who decided and what the removal answered, and a PDF summary (when this Hub has Chromium or a render peer).',
        'Schedule: a Hub administrator sets per app how often a review starts by itself (monthly, quarterly, every 6 or 12 months) and how many days the owners have. A review starts on the first of the month; owners are told when it is ready and once when it is overdue.'
      ]
    },

    { type: 'h2', id: 'hub-tls-watch', text: 'Certificates and names' },
    {
      type: 'p',
      text: 'Every 6 hours the Hub resolves every environment address and hostname (DNS) and reads the certificate the server presents — a TLS handshake only, read even when it does not verify. Owners and Hub administrators are warned once at 30, 14 and 3 days before expiry, when it has expired, and once when a name stops resolving. A renewed certificate starts the warnings over. Each expiry is also an entry in the change calendar (kind tls).'
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
      text: 'The scanner is any service that speaks this contract — a small wrapper around Trivy, Grype or OSV-Scanner. The Hub agent runs no scanner: it stays the only, narrow Docker writer. The call goes through the SSRF guard: a scanner on this machine or a private address must be named in SSRF_ALLOW_HOSTS. Changing the scanner address drops the stored token unless a new one is given.'
    },

    { type: 'h2', id: 'hub-compliance-pack', text: 'Compliance pack' },
    {
      type: 'p',
      text: 'One zip per app for an auditor, covering the last 3–24 months: a summary PDF (an HTML summary when this Hub cannot make PDFs) and CSVs of deploys, access reviews, break-glass access, database and files backups and restore drills, secret rotations (names and when, never values), incidents, certificates and open vulnerabilities, with a README. The pack never carries a token, key, password, connection string or sealed value; error texts are reduced to their first line with addresses, hosts, emails and paths replaced. A pack is at most 50 000 rows (`PACK_TOO_BIG`: ask for fewer months) and is streamed. Owners and Hub administrators download it; every download is logged.'
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
      text: 'App side (0.3.215+, behind the hub link’s bearer): GET /api/hub-link/security/role-holders, POST /api/hub-link/security/break-glass and …/break-glass/revoke (on a shared deployment under /api/hub-deployment/apps/:id/security/*). Jobs: hub-break-glass (every minute), hub-security-tick (every 30 minutes), hub-vuln-scan (04:40) on the Hub; hub-break-glass-expire (every minute) on every install, linked to a Hub or not.'
    }
  ]
}
