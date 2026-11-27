import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3: Firebase. Facts are from the adapter code:
// api/src/services/hub/providers/firebase/**. Nothing here ran against a live Google project yet.

export const hubProvidersFirebaseDocs: DocSection = {
  id: 'hub-providers-firebase',
  label: 'Provider: Firebase',
  content: [
    { type: 'h1', id: 'hub-providers-firebase', text: 'Provider: Firebase — Hub mode only' },
    {
      type: 'p',
      text: 'Two connection fields: `projectId` (the Google Cloud project this connection is pinned to) and the secret `serviceAccountJson` (the JSON key of a service account of that project, sealed and never shown again). The Hub signs a short RS256 token request with the key (never the `token_uri` inside the JSON), caches the token and calls only `firebase.googleapis.com`, `oauth2.googleapis.com`, `iam.googleapis.com` and `fcm.googleapis.com`. The key must belong to the pinned project, and every read and write stays inside it (`FIREBASE_OUT_OF_PROJECT` for anything else). The private key never reaches a log, a plan or an error: provider text is masked before it is clipped. Test checks the project, the apps and key APIs, and a dry-run FCM send with a made-up token (a "bad token" answer proves the send permission is there).'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`firebase.project`',
          '`<project id>`',
          'Shared (Hub administrators). Adds Firebase to the pinned Google Cloud project, or adopts it when Firebase is already there (a create onto a project that already has Firebase stops with `ALREADY_EXISTS`). Only the display name changes. Firebase cannot be taken off a project from here, so there is no delete. The Hub does not create Google Cloud projects.'
        ],
        [
          '`firebase.android_app`, `firebase.ios_app`, `firebase.web_app`',
          '`<app id>`',
          'A registered app. Android is identified by its package name, iOS by its bundle id (and an optional App Store id); a different package or bundle is a replace. The app’s config file (`google-services.json`, `GoogleService-Info.plist` or the web config JSON) comes out as the outputs `config_file` and `config_filename`. They are not secret and can be read again at any time. Remove is `destructive`: Firebase keeps a removed app for 30 days.'
        ],
        [
          '`firebase.fcm_service_account`',
          '`<service account>/<key id>`',
          'A NEW key for an existing service account of the pinned project that already holds a Firebase Cloud Messaging send role; the Hub grants no roles. Google shows the key JSON once, so it is the output `service_account_json` (secret, once-only). **Make a new key** (`rotate_outputs`) makes another and leaves the old one valid until it is deleted. Delete is `destructive` + `downtime` (pushes sent with it are refused at once); the key the connection itself uses is never deleted from here (`CONNECTION_KEY`).'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Phone push: the phone app’s alerts go through the Expo push service (`MOBILE_PUSH`, `EXPO_ACCESS_TOKEN`); Nivaro’s own code does not change. The Android FCM key reaches Expo through the Expo provider’s type `expo.android_push_credentials`: a Hub administrator sets the Firebase connection on the Expo connection, and the credentials name this FCM key resource (same app, same connection). The Hub uploads its sealed copy to EAS and the key is never shown (see “Expo push credentials”). Bindings themselves still reach only stack settings, stack secrets and the app-setting allow-list. iOS (APNs) credentials are not covered.',
        'Creating apps and the project is a long-running Google operation. The Hub waits a short while; if Google is not done the step fails as retryable (`OPERATION_PENDING`) and a re-run picks up the finished app. An interrupted create that never recorded its id is refused as `ALREADY_EXISTS` on the next run: adopt the app.',
        'Nothing here is priced (Firebase’s free tier covers these), so no type has an estimate, and no type sends Hub messages.',
        'Needs a live check: the permission names Test reports, the operation polling, config file shapes for iOS and web, and whether the service account may list keys of other accounts in the project.'
      ]
    }
  ]
}
