import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3: AWS part 4 (SNS, Cost Explorer, Budgets, Route 53 Domains).
// Facts are from the adapter code: api/src/services/hub/providers/aws/{sns,cost-explorer,domains,
// pricing-part4}.ts. Nothing here ran against a live AWS account yet.

const IAM_POLICY =
  '{\n  "Version": "2012-10-17",\n  "Statement": [\n    {\n      "Sid": "NivaroHubSns",\n      "Effect": "Allow",\n      "Action": ["sns:ListTopics", "sns:CreateTopic", "sns:DeleteTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:TagResource", "sns:ListTagsForResource", "sns:Subscribe", "sns:Unsubscribe", "sns:ListSubscriptions", "sns:ListSubscriptionsByTopic", "sns:GetSubscriptionAttributes", "sns:Publish", "sns:GetSMSAttributes", "sns:SetSMSAttributes", "sns:GetSMSSandboxAccountStatus"],\n      "Resource": "*"\n    },\n    {\n      "Sid": "NivaroHubCost",\n      "Effect": "Allow",\n      "Action": ["ce:GetCostAndUsage", "ce:ListCostAllocationTags", "ce:UpdateCostAllocationTagsStatus", "budgets:ViewBudget", "budgets:ModifyBudget", "budgets:ListTagsForResource", "budgets:TagResource"],\n      "Resource": "*"\n    },\n    {\n      "Sid": "NivaroHubDomains",\n      "Effect": "Allow",\n      "Action": ["route53domains:ListDomains", "route53domains:GetDomainDetail", "route53domains:GetOperationDetail", "route53domains:ListPrices", "route53domains:CheckDomainAvailability", "route53domains:RegisterDomain", "route53domains:EnableDomainAutoRenew", "route53domains:DisableDomainAutoRenew", "route53domains:EnableDomainTransferLock", "route53domains:DisableDomainTransferLock", "route53domains:UpdateDomainNameservers"],\n      "Resource": "*"\n    }\n  ]\n}'

export const hubProvidersAwsPart4Docs: DocSection = {
  id: 'hub-providers-aws-part4',
  label: 'Provider: AWS — SNS, costs, domains',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-aws-part4',
      text: 'Provider: AWS — SNS, Cost Explorer, Budgets, Route 53 Domains — Hub mode only'
    },
    {
      type: 'p',
      text: 'More types on the same `aws` connection (see **Provider: Amazon Web Services**). SNS types carry the usual required `region` field and add `sns.<region>` hosts for the allowed regions. Cost Explorer (`ce`), AWS Budgets and Route 53 Domains answer from ONE place whatever the connection’s regions (`ce.us-east-1`, `budgets.amazonaws.com`, `route53domains.us-east-1`), so their types have no region field. The connection test adds three optional rows (`sns:ListTopics`, `budgets:ViewBudget`, `route53domains:ListDomains`): a missing one never fails the connection. It never calls Cost Explorer, which AWS bills per request. New connection field `sms_countries` (default `US,CA`): the countries a Hub notification text may go to.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`aws.sns_topic`',
          'topic ARN',
          'A topic (name fixed at creation), display name, KMS key and "Let AWS Budgets publish here" (adds a topic policy statement for `budgets.amazonaws.com`, limited to this account). `sends`: a Hub event routed to the topic is published to every subscriber. Delete is destructive (subscribers go with it). A topic the Hub did not make is `ALREADY_EXISTS`. **Health:** a warning when nobody has confirmed a subscription.'
        ],
        [
          '`aws.sns_subscription`',
          'subscription ARN',
          'Email, email-JSON, https or sms. `http` is refused; an https endpoint carries no user name or password. Every field is fixed at creation (a change replaces). Email and https stay pending until the recipient confirms (a warning; AWS removes an unconfirmed one after three days). An SMS number follows the Twilio rules (written +country, only in `sms_countries`, else `COUNTRY_NOT_ALLOWED`) and the plan is admin only. A subscription that already exists is `ALREADY_EXISTS` (subscriptions have no tags).'
        ],
        [
          '`aws.sns_sms_settings`',
          '`sms:<region>`',
          'The account’s text settings in one region: monthly spend limit, default sender id, transactional or promotional. **Shared** (Hub administrators only) and never deleted by the Hub. Raising the spend limit is a cost change. Settings someone already changed are `ALREADY_EXISTS` on a create: adopt them. `sends`: a Hub event is texted to `notify_numbers` (at most 10, E.164, allowed countries only, **20 texts an hour per resource**, critical events only unless turned off). **Health:** a warning while the account is in the SMS sandbox (only verified numbers receive texts); leaving it is a person’s step in the SNS console. AWS caps the spend limit at the account quota (1 USD on a new account; raising it is an AWS support request).'
        ],
        [
          '`aws.sns_sms_user`',
          'IAM user name',
          'The narrow IAM exception (as the SES SMTP user). An IAM user under `/nivaro-hub/`, tagged `nivaro-hub:managed`, `nivaro-hub:kind=sns_sms` and `nivaro-hub:resource=<row>` at creation, whose ONLY policy allows `sns:Publish` to phone numbers and denies it on every topic. Every read, rotate, policy write and delete first proves path, kind and row. Admin only: the key can text any number worldwide (the account spend limit is the cap; the Hub’s country list does not bind the app).'
        ],
        [
          '`aws.cost_allocation_tag`',
          'tag key',
          'Activates a `nivaro-hub:*` tag (shared). AWS lists a tag only after a resource carries it (up to 24 hours) and splits costs by it only from activation on: health says so, and a create for an unlisted tag says `TAG_NOT_VISIBLE`. Only `nivaro-hub:*` keys are ever read or changed; "delete" only deactivates.'
        ],
        [
          '`aws.budget`',
          'budget name',
          'An AWS Budget limited to one app’s tag (`user:nivaro-hub:app$<app>`), with ACTUAL and optional FORECASTED alerts at up to four percentages, sent to an SNS topic and/or emails. Made with the Hub’s tags. **Health** carries limit, spent and forecast; warning at 80 % or a forecast over the limit, down when over. The Hub’s own per-app budget (Costs page) raises `cost.over_budget` separately; this one is AWS’s guard.'
        ],
        [
          '`aws.domain`',
          'domain name',
          'A Route 53 domain registration (shared, administrators only, never deleted by the Hub). **Registering** is a cost change (one-time now plus yearly renewal, estimated from the registrar’s list prices), asks for the typed confirm "register <domain>", checks availability first and never registers what is unavailable, already yours or already being registered. Needs a registration contact (used for admin, registrant and technical, privacy protection on). Auto-renew off and nameserver changes are `downtime`; **turning the transfer lock off is `destructive`** (it allows a transfer away). There is no transfer-out operation: no auth code is read or shown. **Health** answers `expiresAt`, `autoRenew` and `locked` for the domain watch.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-aws4-outputs', text: 'Text messages for an app' },
    {
      type: 'p',
      text: 'The SMS user’s outputs are `sms_provider` (`aws-sns`, the app’s own provider value), `sms_account_sid` (the access key id, once only), `sms_auth_token` (the secret access key, secret, once only) and `sms_region`. Bind them to the app settings of the same names; the secret goes to the credential setting only. A lost key is replaced with "Make a new access key" (the previous key stays valid until the next rotation).'
    },
    { type: 'h2', id: 'hub-aws4-costs', text: 'The cost feed' },
    {
      type: 'p',
      text: 'The adapter’s `costs()` makes ONE Cost Explorer `GetCostAndUsage` call (DAILY, UnblendedCost) grouped by the cost allocation tag `nivaro-hub:app` and by record type, so each row says usage, tax, credit, discount or refund; the price book learns the connection’s tax and discount rates from those. AWS bills each Cost Explorer request (about 1 cent), so the daily job asks once per connection (a long answer is read page by page, at most 10 pages). Rows name the app tag, not a resource: resource-level cost covers only 14 days and needs an opt-in at AWS. Cost Explorer must be turned on in the billing console (`COST_EXPLORER_OFF` otherwise), and costs split by app only for an active `nivaro-hub:app` tag.'
    },
    { type: 'h2', id: 'hub-aws4-iam', text: 'Permissions' },
    {
      type: 'p',
      text: 'Add this to the connection’s role (the SMS user also needs the IAM statement of **Provider: AWS — ECR, SES, Secrets Manager**). Drop the `RegisterDomain` action if the Hub should never register domains.'
    },
    { type: 'pre', code: IAM_POLICY },
    {
      type: 'note',
      text: 'Needs a live check on a throwaway account: the SNS, Budgets, Cost Explorer and Route 53 Domains request shapes and the SNS price filter are written from AWS’s public API descriptions and recorded sample answers, not from a real account. Nothing registers a domain in tests.'
    }
  ]
}
