import type { DocSection } from '../types.js'

// Hub third-party providers, gap G-C: Expo Android push credentials. Facts are from the adapter
// code: api/src/services/hub/providers/expo/push.ts. Tested against recorded (fake) EAS answers
// only; every EAS GraphQL shape used here is unverified against a live Expo account.

export const hubProvidersExpoPushDocs: DocSection = {
  id: 'hub-providers-expo-push',
  label: 'Expo push credentials',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-expo-push',
      text: 'Expo Android push credentials — Hub mode only'
    },
    {
      type: 'p',
      text: 'The type `expo.android_push_credentials` (per app, on the Expo connection) uploads a Firebase **FCM V1 service-account key** to the Expo account (EAS) and links it as the push key of one Android application id. It carries the key made by a `firebase.fcm_service_account` resource, so a phone app’s Android pushes work without anyone downloading the key or pasting it into Expo. The key comes from the Hub’s sealed copy of that Firebase resource’s output `service_account_json`; it is never shown, never in a plan, a step, an error or the stored state.'
    },
    {
      type: 'table',
      head: ['Field', 'What it is'],
      rows: [
        [
          'Project',
          'The `expo.project` it belongs to (a reference on the same Expo connection). Changing it is a replace.'
        ],
        [
          'Android application id',
          'The package name, e.g. `com.example.fieldapp`. Changing it is a replace.'
        ],
        [
          'Firebase key (Hub resource id)',
          'The Hub id of a Firebase FCM key resource. A reference cannot cross connections, so this is a plain number; the Hub checks it (below).'
        ],
        [
          'Upload the key again',
          'A one-shot switch: uploads the Firebase key to Expo once more on the next apply (use it after rotating the Firebase key). It clears itself.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-providers-expo-push-connection', text: 'Setting it up' },
    {
      type: 'ul',
      items: [
        'A Hub administrator edits the **Expo connection** and picks the **Firebase connection** (`firebase_connection_id`, the connection’s id). Only that connection is ever used for push keys, and only an administrator can change it. Empty means push credentials are refused (`EXPO_FIREBASE_CONNECTION`).',
        'The app must be allowed to use the Firebase connection. The Firebase key resource must be an FCM key of **the same app** on **that Firebase connection**; a key of another app, another connection, a deleted one, or a resource that is not an FCM key is refused with one message (`EXPO_FIREBASE_KEY`) that does not say what exists elsewhere.',
        'Make the Firebase key first (Firebase provider, FCM service account), then the credentials. Google shows a key once: if the Hub has no stored copy the change stops with `EXPO_FIREBASE_KEY_UNAVAILABLE`. Make a new key on the Firebase resource (**Make a new key**) and apply again.'
      ]
    },
    { type: 'h2', id: 'hub-providers-expo-push-behaviour', text: 'What it does' },
    {
      type: 'ul',
      items: [
        '**Create**: makes the credentials row for the application id when Expo has none, uploads the key, links it. A row that already carries a push key the Hub did not set stops with `ALREADY_EXISTS`: adopt it instead. A row that exists but has no push key is used as it is (nothing is replaced). If linking fails the uploaded copy is removed again.',
        '**Rotate / re-upload**: the new key is uploaded and linked; the previous key stays in the Expo account (it may be shared with another app), so remove it there when it is no longer used. The Hub does not see which Firebase resource a key came from after a fresh read, so a different key resource is detected from the last apply only; the **Upload the key again** switch always works.',
        '**Delete / replace** are `destructive` + `downtime`: the linked push key is removed from the Expo account and Android devices of the app stop receiving pushes until another key is linked. The credentials row itself (and any build keystore on it) stays. Expo may share one uploaded key between apps, so check before deleting.',
        'What Expo reports back is identifiers only (key linked, the service account’s email). A later read never shows the key.'
      ]
    },
    {
      type: 'note',
      text: 'iOS (APNs) push credentials are not part of this: they need an Apple developer login and are not managed by the Hub. The phone app’s alerts themselves still go through the Expo push service (`MOBILE_PUSH`, `EXPO_ACCESS_TOKEN`); Nivaro’s own sending code does not change.'
    },
    {
      type: 'warn',
      text: 'Not verified against a live Expo account: the names of the EAS GraphQL calls (`createGoogleServiceAccountKey`, `createAndroidAppCredentials`, `setGoogleServiceAccountKeyForFcmV1`, `deleteGoogleServiceAccountKey`, `App.androidAppCredentials`) and their fields. They are all in `expo/queries.ts` and need a live check on a throwaway Expo account before this is relied on.'
    }
  ]
}
