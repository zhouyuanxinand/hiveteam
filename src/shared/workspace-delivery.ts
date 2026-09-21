export type DeliveryFilter = 'all' | 'active' | 'waiting' | 'attention'
export interface DeliveryCounts {
  total: number
  active: number
  waiting: number
  attention: number
}
export interface DeliveryFlags {
  active: boolean
  waiting: boolean
  attention: boolean
}
export interface WorkspaceDeliveryPage<Item> {
  items: Array<Item & { delivery_flags: DeliveryFlags }>
  summary: DeliveryCounts
  filtered_total: number
  snapshot_sequence: number
  generated_at: number
  next_cursor: string | null
}
