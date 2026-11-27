import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 2: AWS part 3 (ECR, SES, Secrets Manager). Facts are from the
// adapter code: api/src/services/hub/providers/aws/{ecr,ses,secrets-manager,pricing-part3}.ts.
// Nothing here ran against a live AWS account yet.

const IAM_POLICY =
  '{\n  "Version": "2012-10-17",\n  "Statement": [\n    {\n      "Sid": "NivaroHubEcr",\n      "Effect": "Allow",\n      "Action": ["ecr:DescribeRepositories", "ecr:CreateRepository", "ecr:DeleteRepository", "ecr:ListImages", "ecr:DescribeImages", "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability", "ecr:TagResource", "ecr:ListTagsForResource", "ecr:GetLifecyclePolicy", "ecr:PutLifecyclePolicy", "ecr:DeleteLifecyclePolicy"],\n      "Resource": "*"\n    },\n    {\n      "Sid": "NivaroHubSes",\n      "Effect": "Allow",\n      "Action": ["ses:ListEmailIdentities", "ses:ListConfigurationSets", "ses:GetEmailIdentity", "ses:CreateEmailIdentity", "ses:DeleteEmailIdentity", "ses:PutEmailIdentityMailFromAttributes", "ses:PutEmailIdentityConfigurationSetAttributes", "ses:GetConfigurationSet", "ses:CreateConfigurationSet", "ses:DeleteConfigurationSet", "ses:PutConfigurationSetSendingOptions", "ses:PutConfigurationSetReputationOptions", "ses:PutConfigurationSetDeliveryOptions", "ses:GetAccount", "ses:TagResource"],\n      "Resource": "*"\n    },\n    {\n      "Sid": "NivaroHubSecrets",\n      "Effect": "Allow",\n      "Action": ["secretsmanager:ListSecrets", "secretsmanager:DescribeSecret", "secretsmanager:CreateSecret", "secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue", "secretsmanager:TagResource", "secretsmanager:DeleteSecret", "secretsmanager:RestoreSecret", "secretsmanager:GetSecretValue"],\n      "Resource": "*"\n    },\n    {\n      "Sid": "NivaroHubSmtpUsersOnly",\n      "Effect": "Allow",\n      "Action": ["iam:GetUser", "iam:CreateUser", "iam:DeleteUser", "iam:TagUser", "iam:PutUserPolicy", "iam:GetUserPolicy", "iam:DeleteUserPolicy", "iam:CreateAccessKey", "iam:DeleteAccessKey", "iam:ListAccessKeys"],\n      "Resource": "arn:aws:iam::*:user/nivaro-hub/*"\n    },\n    {\n      "Sid": "NivaroHubListSmtpUsers",\n      "Effect": "Allow",\n      "Action": "iam:ListUsers",\n      "Resource": "*"\n    }\n  ]\n}'

export const hubProvidersAwsPart3Docs: DocSection = {
  id: 'hub-providers-aws-part3',
  label: 'Provider: AWS — ECR, SES, Secrets Manager',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-aws-part3',
      text: 'Provider: AWS — ECR, SES, Secrets Manager — Hub mode only'
    },
    {
      type: 'p',
      text: 'Six more types on the same `aws` connection (see **Provider: Amazon Web Services**): the connection’s account, allowed regions, role and keys are unchanged. Every type has the same required `region` field. The connection’s host list now also holds `api.ecr.<region>`, `email.<region>`, `secretsmanager.<region>` for each allowed region, and `iam.amazonaws.com` (used only by the SES SMTP user, below). The connection test adds one read-only row each for `ecr:DescribeRepositories`, `ses:ListEmailIdentities`, `ses:ListConfigurationSets`, `secretsmanager:ListSecrets` and `iam:ListUsers`.'
    },
    {
      type: 'table',
      head: ['Type', 'Provider id', 'What it does'],
      rows: [
        [
          '`aws.ecr_repository`',
          'repository name',
          'Scan on push (default on), immutable tags (default off) and encryption (AES-256 or a KMS key; both fixed at creation, so changing encryption replaces the repository). Calls always use the connection’s own registry. Delete of a repository that still holds images is refused (`REPOSITORY_NOT_EMPTY`) unless an admin types "delete all objects in <name>"; that delete is `data_loss`, and the plan already shows `data_loss` when images are there. **Health:** the latest pushed image’s scan findings by severity (critical, high, medium, low, informational); critical or high findings make it a warning. The same counts are what the Hub’s vulnerability tab reads as source `ecr`.'
        ],
        [
          '`aws.ecr_lifecycle_policy`',
          'repository name',
          'The one lifecycle policy of a Hub-managed repository (`repository` ref). The JSON is stored and compared in a canonical form (keys sorted), so formatting is never a change. A new or changed policy is `data_loss`: AWS deletes the images the rules expire.'
        ],
        [
          '`aws.ses_identity`',
          'the domain',
          'A domain identity with Easy DKIM (RSA 2048) and an optional MAIL FROM subdomain and default configuration set. Give it a `zone` (an adopted `aws.route53_zone`) and the Hub writes the three DKIM CNAMEs (and the MAIL FROM MX and SPF TXT) there; a record that already exists with other values stops the create (`ALREADY_EXISTS`), and a zone that does not hold the domain is refused (`ZONE_MISMATCH`). The records are also shown on the resource (`dkim_records`, `mail_from_records`) so they can be made by hand or in Cloudflare: a reference cannot cross connections, so the AWS adapter writes only into Route 53. **Health:** pending or failed DNS verification, and a warning while the account is in the SES sandbox. Leaving the sandbox is a support request in the AWS console that only a person can make; the Hub cannot do it.'
        ],
        [
          '`aws.ses_configuration_set`',
          'name',
          'TLS policy (optional or required), sending on or off and reputation metrics. Turning sending off is `downtime`.'
        ],
        [
          '`aws.ses_smtp_user`',
          'IAM user name',
          'The one IAM exception to the Hub’s "no IAM" rule (see below). Outputs for the app’s mail settings.'
        ],
        [
          '`aws.secret`',
          'the secret’s ARN',
          'AWS Secrets Manager. The `value` is write-only. Name, description, KMS key and a recovery window of 7–30 days (default 30, kept as a tag on the secret). Rotation (function, schedule) is read and shown, not configured by the Hub.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-aws3-smtp', text: 'The SES SMTP user' },
    {
      type: 'p',
      text: 'An app that sends mail through SES SMTP needs an access key, so this type makes an IAM user. It is deliberately narrow: the user is created under the path `/nivaro-hub/`, tagged `nivaro-hub:managed=true`, and its only policy is `ses:SendRawEmail` and `ses:SendEmail` on that one identity (`arn:aws:ses:<region>:<account>:identity/<domain>`). No managed policy is ever attached. Every IAM call first proves the user is the Hub’s (path and tag); a same-named user made any other way, or by another Hub resource (its `nivaro-hub:resource` tag must be this resource’s id before any rotation, policy rewrite or delete), is refused (`NOT_HUB_USER`) and never read or changed. If someone widens the policy, the resource shows the identity as changed and the next apply puts the Hub’s policy back. The identity must exist in the same region as the user (`IDENTITY_NOT_FOUND`).'
    },
    {
      type: 'table',
      head: ['Output', 'Value', 'Notes'],
      rows: [
        ['`smtp_host`', '`email-smtp.<region>.amazonaws.com`', 'Plain; can be re-read.'],
        ['`smtp_port`', '`587`', 'Plain (STARTTLS).'],
        [
          '`smtp_user`',
          'the access key id',
          'Once only: it belongs to the key AWS showed at creation.'
        ],
        [
          '`smtp_pass`',
          'derived from the secret access key',
          'Secret and once only. Made with AWS’s documented SES SMTP algorithm for the user’s region; the raw secret access key is never handed out or stored.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Bind `smtp_host`, `smtp_port`, `smtp_user` and `smtp_pass` to the app settings of the same names (`smtp_pass` is a credential setting, so it needs a secret target).',
        'A lost value cannot be read again. Switch on **Make a new access key** (`rotate_outputs`): the Hub makes a new key and hands out its password. An IAM user holds two keys at most, so when two exist the older one is deleted first; the previous key stays valid until the next rotation, so the app keeps sending until the new password is applied.',
        'A create that fails half way removes what it made (policy, keys, user), so a retry starts clean.',
        'Delete removes the keys, the Hub’s policy and the user. If anything else is attached to the user, IAM refuses and says so.'
      ]
    },
    { type: 'h2', id: 'hub-aws3-secret', text: 'Secrets Manager' },
    {
      type: 'ul',
      items: [
        'The value is a write-only secret field. It exists in plain only while the change applies, is never put in the plan, the stored state, the steps or an error (provider text is scrubbed first), and a changed value is written with a token derived from its fingerprint, so a retry is the same write.',
        'Output `value` (secret) and `arn` let any binding fill a stack secret or setting from Secrets Manager. The value is re-read only for the secret this very resource created: the secret’s `nivaro-hub:resource` tag must equal this resource’s id. An adopted secret, another resource’s secret and a secret waiting for deletion answer only their ARN; an adopted secret is never tagged as managed, so its value is never read.',
        'An ARN that belongs to another AWS account than the connection is refused on every read and write (`AWS_OUT_OF_ACCOUNT`).',
        'Delete uses Secrets Manager’s own scheduled deletion with the secret’s recovery window, never "delete without recovery". Until the window ends the secret is `pending_deletion` (a warning) and can be restored: undoing the delete, or creating the same resource again, restores it and brings it up to date instead of failing. A secret waiting for deletion that the Hub did not make is `ALREADY_EXISTS`, never restored.',
        'A create that finds a secret of that name the Hub did not make stops with `ALREADY_EXISTS`: adopt it instead.'
      ]
    },
    { type: 'h2', id: 'hub-aws3-costs', text: 'Costs' },
    {
      type: 'p',
      text: 'All six types are estimated; none is "costed", so none needs an owner approval for cost. ECR is usage priced: storage per GB-month from the repository’s image sizes (measured), plus data out. Secrets Manager is a fixed price per secret-month plus a price per 10,000 API calls (named in the note). SES: the identity, configuration set and IAM user are free; mail is a price per 1,000 emails sent. Prices come from the AWS Price List (needs `pricing:GetProducts`, optional) with a dated bundled fallback for us-east-1. The Price List filter names for ECR, Secrets Manager and SES are from memory of the public schema and need one live check; a wrong filter falls back to the bundled table or "No estimate", never a wrong figure shown silently.'
    },
    { type: 'h2', id: 'hub-aws3-iam', text: 'Permissions' },
    {
      type: 'p',
      text: 'Add this to the connection’s role. Narrow the Secrets Manager statement further with a resource tag condition (`aws:ResourceTag/nivaro-hub:managed`) if the account holds secrets the Hub must never read. The IAM actions are limited to users under `/nivaro-hub/`.'
    },
    { type: 'pre', code: IAM_POLICY },
    {
      type: 'note',
      text: 'Needs a live check on a throwaway account: the SES v2 request shapes, the IAM tag and policy calls, the ECR and Secrets Manager JSON calls and the Price List filters are written from AWS’s public API descriptions and recorded sample answers, not from a real account.'
    }
  ]
}
