import { colors } from '../theme/tokens'

export type Order = {
  id: string; source_tab: string | null; company: string | null; po: string | null
  style_no: string | null; style: string | null; description: string | null; fabric: string | null
  colour: string | null; qty: number | string | null; ex_factory: string | null
  docket: number | string | null; docket_url: string | null; invoice_no: string | null
  packing_list_url: string | null; stage: string | null; notes: string | null
  image_url?: string | null; product_url?: string | null; updated_by?: string | null
}

export const STAGES = ['Pending', 'Cutting', 'Production', 'Packing', 'Ready', 'Booked', 'Completed'] as const
export type Stage = (typeof STAGES)[number]
export const CANCELLED = 'Cancelled'
export type OrderStatus = Stage | typeof CANCELLED
export type OrderTab = 'active' | 'completed' | 'cancelled'

// This is the forward production sequence packers may advance through. It
// intentionally differs from the display sort order below and mirrors the
// database transition trigger.
const PACKER_FORWARD_STAGES: Stage[] = ['Pending', 'Cutting', 'Production', 'Packing', 'Ready']

export function canPackerAdvanceTo(current: string | null, target: Stage): boolean {
  if (current === 'Booked' || current === 'Completed' || current === CANCELLED) return false
  const targetRank = PACKER_FORWARD_STAGES.indexOf(target)
  const currentRank = PACKER_FORWARD_STAGES.indexOf(current as Stage)
  return targetRank > 0 && currentRank !== -1 && targetRank > currentRank
}

export function parseExFactory(value: string | null): number {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return 0
  const date = new Date(`${match[1]}-${match[3]}-${match[2]}`)
  return Number.isNaN(date.getTime()) ? 0 : date.getTime()
}

function getStageRank(stage: string | null): number {
  return ({ Booked: 0, Ready: 1, Packing: 2, Production: 3, Cutting: 4, Pending: 5, Completed: 6, Cancelled: 7 } as Record<string, number>)[stage ?? ''] ?? 5
}

export function sortOrders(a: Order, b: Order) {
  if (a.stage === 'Completed' && b.stage === 'Completed') return parseExFactory(b.ex_factory) - parseExFactory(a.ex_factory)
  const difference = getStageRank(a.stage) - getStageRank(b.stage)
  return difference || (a.po || '').localeCompare(b.po || '', undefined, { numeric: true, sensitivity: 'base' })
}

export function normaliseUrl(value: string) {
  const trimmed = value.trim()
  return !trimmed || /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

export function isValidUrl(value: string) {
  try { const url = new URL(value); return Boolean(url.protocol && url.host) } catch { return false }
}

type ChipStatus = 'PENDING' | 'CUTTING' | 'PRODUCTION' | 'PACKING' | 'READY' | 'BOOKED' | 'COMPLETED' | 'CANCELLED'

export function toChipStatus(stage: string | null): ChipStatus {
  const known = ['Pending', 'Cutting', 'Production', 'Packing', 'Ready', 'Booked', 'Completed', 'Cancelled']
  return (known.includes(stage ?? '') ? stage! : 'Pending').toUpperCase() as ChipStatus
}

export function getStageAccent(stage: string | null) {
  return ({ Pending: colors.textSoft, Cutting: colors.warning, Production: colors.primary, Packing: colors.info, Ready: colors.success, Booked: colors.primaryDeep, Completed: colors.success, Cancelled: colors.danger } as Record<string, string>)[stage ?? ''] ?? colors.textSoft
}

export function stageColor(stage: string | null): string {
  return ({ Pending: '#7f8c8d', Cutting: '#c0392b', Production: '#e67e22', Packing: '#2980b9', Ready: '#27ae60', Booked: '#1e3a8a', Completed: '#1e8449', Cancelled: '#4a4a4a' } as Record<string, string>)[stage ?? ''] ?? '#7f8c8d'
}
