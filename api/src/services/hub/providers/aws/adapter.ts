import { acmDefs } from './acm.js'
import { awsConnection, awsFixedJson, awsPriceList, awsQuery, connectionAccount } from './client.js'
import { getMetricData } from './cloudwatch.js'
import { computeDefs } from './compute.js'
import { awsCosts, costDefs } from './cost-explorer.js'
import { domainDefs } from './domains.js'
import { child, text } from './ec2.js'
import { ecrDefs } from './ecr.js'
import { elbDefs } from './elb.js'
import { type AwsTypeDef, makeAwsAdapter } from './kit.js'
import { networkDefs } from './network.js'
import { AWS_BUNDLED_PRICES } from './pricing.js'
import { AWS_PART3_BUNDLED_PRICES } from './pricing-part3.js'
import { AWS_PART4_BUNDLED_PRICES } from './pricing-part4.js'
import { rdsDefs } from './rds.js'
import { route53Defs } from './route53.js'
import { s3Defs } from './s3.js'
import { secretsManagerDefs } from './secrets-manager.js'
import { securityGroupDef } from './security-group.js'
import { sesDefs } from './ses.js'
import { snsDefs } from './sns.js'

/** The `aws` provider: every AWS type this build manages. */
export const AWS_DEFS: AwsTypeDef[] = [
  ...networkDefs,
  securityGroupDef,
  ...computeDefs,
  ...rdsDefs,
  ...s3Defs,
  ...route53Defs,
  ...elbDefs,
  ...acmDefs,
  ...ecrDefs,
  ...sesDefs,
  ...secretsManagerDefs,
  ...snsDefs,
  ...costDefs,
  ...domainDefs
]

export const awsProvider = makeAwsAdapter({
  key: 'aws',
  label: 'Amazon Web Services',
  connection: awsConnection,
  defs: AWS_DEFS,
  bundledPrices: {
    ...AWS_BUNDLED_PRICES,
    items: {
      ...AWS_BUNDLED_PRICES.items,
      ...AWS_PART3_BUNDLED_PRICES.items,
      ...AWS_PART4_BUNDLED_PRICES.items
    }
  },
  costs: awsCosts,
  optionalProbes: [
    {
      type: 'aws.sns_topic',
      need: 'sns:ListTopics',
      why: 'SNS topics, subscriptions and text settings',
      run: (ctx, region) => awsQuery(ctx, 'sns', 'ListTopics', {}, { region })
    },
    {
      type: 'aws.budget',
      need: 'budgets:ViewBudget',
      why: 'AWS Budgets',
      run: async (ctx) =>
        awsFixedJson(ctx, 'budgets', 'DescribeBudgets', {
          AccountId: await connectionAccount(ctx),
          MaxResults: 1
        })
    },
    {
      type: 'aws.domain',
      need: 'route53domains:ListDomains',
      why: 'Route 53 domains',
      run: (ctx) => awsFixedJson(ctx, 'route53domains', 'ListDomains', { MaxItems: 1 })
    },
    {
      type: 'costs',
      need: 'pricing:GetProducts',
      why: 'live list prices for cost estimates',
      run: (ctx) =>
        awsPriceList(ctx, 'GetProducts', {
          ServiceCode: 'AmazonRoute53',
          FormatVersion: 'aws_v1',
          MaxResults: 1
        })
    },
    {
      type: 'costs',
      need: 'cloudwatch:GetMetricData',
      why: 'measured data out and bucket sizes',
      run: (ctx, region) => {
        const end = ctx.now()
        return getMetricData(
          ctx,
          region,
          [
            {
              id: 'probe',
              namespace: 'AWS/EC2',
              metric: 'CPUUtilization',
              dimensions: [{ name: 'InstanceId', value: 'i-00000000000000000' }],
              stat: 'Average',
              periodSeconds: 3600
            }
          ],
          new Date(end.getTime() - 3600_000),
          end
        )
      }
    }
  ],
  async identity(ctx) {
    const r = await awsQuery(ctx, 'sts', 'GetCallerIdentity')
    return text(child(r, 'Arn')) || null
  }
})
