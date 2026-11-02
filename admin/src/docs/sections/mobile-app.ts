import type { DocSection } from '../types.js'

export const mobileAppDocs: DocSection = {
  id: 'mobile-app',
  label: 'Mobile App',
  content: [
    { type: 'h1', id: 'mobile-app', text: 'Mobile App (sign-in and push)' },
    {
      type: 'p',
      text: 'The Nivaro phone app signs in to your instance the same way a connected assistant does: through the OAuth server, with no password typed into the app. The person opens the app, enters the instance address, signs in on the normal web page, and the app gets its own tokens. This page covers what the server offers the app: sign-in, the public instance info, the list of signed-in phones, and push alerts.'
    },

    { type: 'h2', id: 'mobile-sign-in', text: 'Phone sign-in' },
    {
      type: 'ul',
      items: [
        'The app is a built-in first-party OAuth client named nivaro-mobile. It uses the authorization-code flow with PKCE and the redirect dev.nivaro.app:/oauth/callback. You can allow more first-party apps with MOBILE_APP_CLIENTS (client_id|name|redirect-uri;...). Only custom app schemes are accepted, never http.',
        'Tokens are device tokens: an access token that starts nvd_ (valid one hour) and a refresh token that starts nvdr_ (valid 30 days, rotated on every use). A device token acts as the person, under their roles, on every route except the ones that mint new credentials (static tokens, View as, kiosk links, new API keys).',
        'Token answers include expires_in and refresh_expires_in (seconds), so the app can plan when the person must sign in again. If the role has a session policy (idle limit or maximum age) it applies to the phone like any browser session, on every request.',
        'The issuer (iss) in the authorize answer is the address the person signed in on, so the app can check it against the address it typed. On a cloud workspace that is the workspace address; self-hosted it is one of the configured addresses (PUBLIC_URL, ADMIN_URL, MCP_PUBLIC_URL, APP_URLS). The code can only be exchanged on that same address.',
        'A lost answer does not sign the phone out. If a refresh token is sent again within 10 seconds of its first use, the server returns the same new pair. The app should send install_id (a stable random id per install, 1 to 200 printable characters) with every refresh; when the first refresh sent one, a retry must send the same one. After the window a reused refresh token ends the phone sign-in.',
        'The authorize request can carry device_name and platform (ios or android); they label the phone in the signed-in list.',
        'MOBILE_SIGNIN=off turns phone sign-in off for the instance. It is independent of MCP_OAUTH. Phones already signed in are refused on their next request.'
      ]
    },
    {
      type: 'note',
      text: 'Device tokens (nvd_, nvdr_) are separate from the nvo_ tokens connected assistants get. On /api/mcp a device token acts as the person, never as a connected app, and an assistant token never works as a phone.'
    },

    { type: 'h2', id: 'mobile-app-info', text: 'GET /api/app-info' },
    {
      type: 'p',
      text: 'A public route (no sign-in) the app calls before sign-in to learn what this instance is and what it offers. It answers the object directly, not wrapped in data, and is cached for 60 seconds.'
    },
    {
      type: 'table',
      head: ['Field', 'Meaning'],
      rows: [
        ['name', 'Project name from Settings (Nivaro when unset).'],
        [
          'origin',
          'The address the app should use for this instance. Self-hosted: the admin address. Cloud: the workspace address.'
        ],
        ['color, logo_url', 'Brand colour and logo, or null.'],
        ['version', 'Server version.'],
        ['cloud', 'true on a Nivaro Cloud workspace.'],
        [
          'environment',
          'production, staging, development, test or other. Set with NIVARO_ENVIRONMENT; otherwise production when NODE_ENV is production.'
        ],
        [
          'min_app_version',
          'Oldest app version the server accepts (MOBILE_MIN_APP_VERSION), or null.'
        ],
        [
          'sign_in',
          '{ mobile: boolean, client_ids: string[] }: whether phone sign-in is on and which app client ids are allowed.'
        ],
        ['push', '{ mode: off | direct | relay }: how alerts reach phones.'],
        [
          'features',
          'Areas the app may show (chat, ask_ai, huddles, command_center, help_videos, support, session_replay, traffic_map, and, where enabled, infrastructure, chaos, teams_bot).'
        ],
        [
          'blocked',
          'null, or suspended, provisioning or maintenance. A suspended or provisioning cloud workspace still answers this route so the app can show a clear message instead of an error.'
        ]
      ]
    },

    { type: 'h2', id: 'mobile-devices', text: 'Signed-in phones' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          'GET /api/auth/devices',
          'The person',
          'Their phones: id, client_name, device_name, platform, created_at, last_used_at and current (the phone asking).'
        ],
        [
          'DELETE /api/auth/devices/:id',
          'The person',
          "Sign that phone out. Its push alerts stop with it. Another person's id answers 404."
        ],
        ['GET /api/users/:userId/devices', 'Admin', 'The same list for any person.'],
        [
          'DELETE /api/users/:userId/devices/:id',
          'Admin',
          "Sign out a person's phone. Logged as device-revoked with the admin id."
        ]
      ]
    },
    {
      type: 'p',
      text: 'Signing out on the phone (the app calls /oauth/revoke) ends that whole phone sign-in. "Sign out everywhere", an admin signing a person out, and "sign out other sessions" also end phones, and delete their push registrations. Phones never appear in the connected-assistant lists. Profile shows them under Signed-in phones; Settings has a Mobile app card with the address, a QR code for the app and Connect push.'
    },

    { type: 'h2', id: 'mobile-push', text: 'Push through the Nivaro push relay' },
    {
      type: 'p',
      text: 'A phone alert needs Apple or Google to deliver it, which needs credentials only the app publisher holds. So a self-hosted instance sends its phone alerts to the Nivaro push relay, which holds those credentials and forwards the alert. Notifications still arrive in the inbox first; a relay failure never loses one.'
    },
    {
      type: 'ul',
      items: [
        'Settings, Mobile app, Connect push registers this instance with the relay and stores the relay key (POST /api/push/relay, admin). The key is never shown again and never appears in config exports or restore points. Disconnect clears it.',
        'GET /api/push/relay (admin) answers connected, url, content, mode and phones (how many phone registrations the instance holds).',
        'MOBILE_PUSH_RELAY_KEY (or MOBILE_PUSH_RELAY_KEY_FILE) provides the key from the environment instead; the card is then read-only. MOBILE_PUSH_RELAY_URL changes the relay address (default https://push.nivaro.dev).',
        'Content: full sends the subject, message and where to open it. minimal sends only the project name, "You have a new notification" and the notification id, so the text never passes through Apple, Google or the relay. The app then reads the notification itself with GET /api/notifications/:id.',
        'Phones register with POST /api/push/phones using a relay_device id (16 to 64 letters, digits, - or _) or an Expo token. Registration is taken back (503 PUSH_RETRY) if it cannot be confirmed, and refused (401) if the phone was signed out meanwhile.',
        'On Nivaro Cloud the relay key is provisioned by the cloud service for each workspace, and Connect push is hidden. MOBILE_PUSH=off turns phone push off everywhere.'
      ]
    },

    { type: 'h2', id: 'mobile-routes', text: 'Other routes the app uses' },
    {
      type: 'ul',
      items: [
        "GET /api/notifications/:id answers one of your own notifications in the same shape as a list row. Someone else's id, an unknown id or a bad id answers 404.",
        'GET /api/auth/me includes access_pending: null, first_access or needs_authorization. It is set when the person has signed in but cannot use the instance yet because of the new-user flow, so the app can show a waiting screen without knowing role names. Older servers leave the field out.',
        'The web route /app/open redirects to the admin home. It is the target of the "open in the app" link in emails, so the link still works in a browser when the app is not installed.'
      ]
    },

    { type: 'h2', id: 'mobile-env', text: 'Settings in the environment' },
    {
      type: 'table',
      head: ['Variable', 'Effect'],
      rows: [
        ['MOBILE_SIGNIN=off', 'Turns phone sign-in off.'],
        [
          'MOBILE_APP_CLIENTS',
          'Extra first-party app clients: client_id|name|uri[,uri];... Cannot redefine nivaro-mobile.'
        ],
        ['MOBILE_MIN_APP_VERSION', 'Reported as min_app_version by app-info.'],
        [
          'NIVARO_ENVIRONMENT',
          'production, staging, development, test or other; shown in the app next to the instance name.'
        ],
        ['MOBILE_PUSH=off', 'No phone push.'],
        [
          'MOBILE_PUSH_RELAY_URL, MOBILE_PUSH_RELAY_KEY',
          'Relay address and key (self-hosted only).'
        ],
        ['CLOUD_BASE_DOMAIN', 'Cloud only: the domain workspaces live under (default nivaro.dev).']
      ]
    }
  ]
}
