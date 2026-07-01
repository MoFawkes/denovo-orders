export type OrderStage =
  | 'Pending'
  | 'Cutting'
  | 'Production'
  | 'Packing'
  | 'Ready'
  | 'Completed'
  | 'Cancelled'

export type Order = {
  id: string
  po: string | null
  style_no: string | null
  style: string | null
  description: string | null
  fabric: string | null
  colour: string | null
  qty: number | null
  ex_factory: string | null
  docket: string | null
  docket_url: string | null
  stage: OrderStage | null
  notes: string | null
  image_url: string | null
  updated_by: string | null
  packing_list_url: string | null
}