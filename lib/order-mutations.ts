// Database writes for order mutations, split out of app/opo.tsx. Pure
// persistence only: optimistic UI updates, alerts, and rollbacks stay in
// the screen. Every stage change also records an order_events audit row,
// mirroring the website's behaviour.
import { supabase } from './supabase'
import type { OrderStatus } from './order-workflow'

export async function persistStageChange({
  orderId,
  oldStage,
  newStage,
  userId,
  packingListUrl,
}: {
  orderId: string
  oldStage: string | null
  newStage: OrderStatus
  userId: string | null
  packingListUrl?: string
}) {
  const updatePayload: Record<string, unknown> = {
    stage: newStage,
    updated_by: userId,
  }

  if (typeof packingListUrl === 'string') {
    updatePayload.packing_list_url = packingListUrl
  }

  const { error } = await supabase
    .from('orders')
    .update(updatePayload)
    .eq('id', orderId)

  if (error) throw error

  const { error: eventError } = await supabase.from('order_events').insert({
    order_id: orderId,
    old_stage: oldStage,
    new_stage: newStage,
    changed_by: userId,
    metadata:
      newStage === 'Completed' && packingListUrl
        ? { packing_list_url: packingListUrl }
        : null,
  })

  if (eventError) {
    console.error('Order event insert error:', eventError)
  }
}

export async function persistOrderFields(
  orderId: string,
  fields: Record<string, unknown>,
  userId: string | null
) {
  const { error } = await supabase
    .from('orders')
    .update({ ...fields, updated_by: userId })
    .eq('id', orderId)

  if (error) throw error
}

// Uploads the image to storage and links it on the order; returns the
// public URL for the caller's optimistic update.
export async function uploadOrderImage(orderId: string, file: File, userId: string | null) {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const path = `orders/${orderId}/image_${Date.now()}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from('order-images')
    .upload(path, file, { upsert: true, contentType: file.type })

  if (uploadError) throw uploadError

  const { data: { publicUrl } } = supabase.storage
    .from('order-images')
    .getPublicUrl(path)

  await persistOrderFields(orderId, { image_url: publicUrl }, userId)

  return publicUrl
}
