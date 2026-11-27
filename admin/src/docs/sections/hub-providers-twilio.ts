import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: Twilio. Facts are from the adapter code:
// api/src/services/hub/providers/twilio/**. Nothing here ran against a live Twilio account yet.

export const hubProvidersTwilioDocs: DocSection = {
  id: 'hub-providers-twilio',
  label: 'Provider: Twilio',
  content: [
    { type: 'h1', id: 'hub-providers-twilio', text: 'Provider: Twilio — Hub mode only' },
    {
      type: 'p',
      text: 'Connection fields: `accountSid` (`AC…`, pinned: every path the Hub calls is built from it and every read checks the answer belongs to it), an optional `keySid` (`SK…`) and a secret `secret`. With a key SID the connection signs in as that API key (preferred); without one it signs in as the account SID with the auth token in `secret`. Hosts: `api.twilio.com` and `messaging.twilio.com`. Test reads the account, then probes phone numbers, messaging services and API keys, and lists what is missing. Managing API keys needs the main account’s auth token or a main API key; a standard key cannot.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`twilio.phone_number`',
          '`PN…`',
          'Buy a number (`cost`: a monthly rental plus per-message usage) by naming it or by searching an area code. Name, SMS webhook and status callback (https only) change in place; changing the number releases this one and buys another. Release is `destructive` and final: the number cannot be got back. It is refused (`IN_USE`) while any messaging service pool still holds it. Costed: the estimate is the dated list-price rental (US and Canada, local or toll-free) plus a note that messages are billed on top; any other country is "No estimate".'
        ],
        [
          '`twilio.messaging_service`',
          '`MG…`',
          'A sender pool: name, status callback (https only) and the numbers in the pool (links to phone-number resources). Delete is `destructive`; the numbers are kept. Not costed.'
        ],
        [
          '`twilio.subaccount`',
          '`AC…`',
          'Shared (Hub admins). Name and active or suspended (`downtime`). Delete closes the subaccount: Twilio never reopens it (`destructive` + `data_loss`). The new subaccount’s own auth token is never read or kept.'
        ],
        [
          '`twilio.api_key`',
          '`SK…`',
          'One per app. The name changes in place. The secret is shown by Twilio only when the key is made, so it is a once-only output. **Rotate the secret** makes a new key, removes the old one (`downtime`: the old secret stops working at once) and answers the new outputs. The key the Hub signs in with is never rotated or deleted by the Hub (`OWN_KEY`).'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Outputs: a number gives `phone_number` and `account_sid`; a messaging service gives `messaging_service_sid`; an API key gives `sid` and the once-only secret `secret`. Bind them to the app’s SMS settings: `phone_number` → `sms_from`, `account_sid` → `sms_account_sid`, and the key secret → `sms_auth_token` (a credential setting, so a secret output may land only there). Set `sms_provider` to `twilio` yourself. The app’s SMS sender signs in with the account SID, so an API key’s SID and secret work there only when the app’s own SMS code accepts them.',
        'Notify: a phone number or a messaging service can be named by a notify route. Each text goes to the resource’s `notify_numbers` (at most 10, `+15551234567`), from the number or through the messaging service. By default only critical events are texted (`critical_only`); other events are skipped without an error, so the route’s Test button (an info message) also sends nothing until you turn that off.',
        'A create that finds a number the account already holds, or a messaging service, subaccount or key of the same name that the Hub did not make, stops with `ALREADY_EXISTS`: adopt it instead. A buy by area code that was interrupted before the Hub recorded it is recognised for ten minutes by its name and age, so a resumed run does not buy a second number.',
        'Error text from Twilio is scrubbed of the connection’s secret before it is clipped to 300 characters.',
        'Prices are a dated table in the adapter, not read live; the run-rate also counts Twilio’s daily usage records (messages and calls) so usage-priced spend is not zero.'
      ]
    },
    {
      type: 'note',
      text: 'Buying a number is a real charge from the moment you apply; releasing one cannot be undone. Owners’ buys wait for a Hub admin to approve (the `cost` gate) and a release asks you to type the number’s name.'
    }
  ]
}
