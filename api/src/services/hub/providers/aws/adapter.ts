import { acmDefs } from './acm.js'
import { awsConnection, awsPriceList, awsQuery } from './client.js'
import { getMetricData } from './cloudwatch.js'
import { computeDefs } from './compute.js'
import { child, text } from './ec2.js'
import { elbDefs } from './elb.js'
import { type AwsTypeDef, makeAwsAdapter } from './kit.js'
import { networkDefs } from './network.js'
import { AWS_BUNDLED_PRICES } from './pricing.js'
import { rdsDefs } from './rds.js'
import { route53Defs } from './route53.js'
import { s3Defs } from './s3.js'
import { securityGroupDef } from './security-group.js'

/** The `aws` provider: every AWS type this build manages. */
export const AWS_DEFS: AwsTypeDef[] = [
  ...networkDefs,
  securityGroupDef,
  ...computeDefs,
  ...rdsDefs,
  ...s3Defs,
  ...route53Defs,
  ...elbDefs,
  ...acmDefs
]

export const awsProvider = makeAwsAdapter({
  key: 'aws',
  label: 'Amazon Web Services',
  connection: awsConnection,
  defs: AWS_DEFS,
  bundledPrices: AWS_BUNDLED_PRICES,
  optionalProbes: [
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
