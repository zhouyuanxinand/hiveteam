export const deliveryQueueStates = [
  'blocked',
  'verification_failed',
  'review',
  'verify',
  'integrate',
  'publish_failed',
  'ci_failed',
  'pull_request',
  'publishing',
] as const
export type DeliveryQueueState = (typeof deliveryQueueStates)[number]
