import { awsConnection, awsQuery } from './client.js'
import { computeDefs } from './compute.js'
import { child, text } from './ec2.js'
import { type AwsTypeDef, makeAwsAdapter } from './kit.js'
import { networkDefs } from './network.js'
import { securityGroupDef } from './security-group.js'

/** The `aws` provider: every AWS type this build manages. */
export const AWS_DEFS: AwsTypeDef[] = [...networkDefs, securityGroupDef, ...computeDefs]

export const awsProvider = makeAwsAdapter({
  key: 'aws',
  label: 'Amazon Web Services',
  connection: awsConnection,
  defs: AWS_DEFS,
  async identity(ctx) {
    const r = await awsQuery(ctx, 'sts', 'GetCallerIdentity')
    return text(child(r, 'Arn')) || null
  }
})
