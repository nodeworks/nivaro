/**
 * The two read permissions the cost features add to the AWS connection's role (Task 44b). Neither
 * is needed to manage resources; without them estimates fall back to the Hub's dated price table
 * and measured data out / bucket sizes stay empty. The connection test shows a row for each and
 * never fails because one is missing. Both are account-wide reads (no resource-level scoping
 * exists for them), and neither can change anything.
 */
export const AWS_COST_ACTIONS = ['pricing:GetProducts', 'cloudwatch:GetMetricData'] as const

export const AWS_COST_IAM_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'NivaroHubCostEstimates',
      Effect: 'Allow',
      Action: [...AWS_COST_ACTIONS],
      Resource: '*'
    }
  ]
} as const
