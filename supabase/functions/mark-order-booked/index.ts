// Marks all orders.stage = 'Booked' for a given PO, called by the Booking
// Confirmation Gmail-polling routine. Books from any current stage except
// 'Completed'/'Cancelled' (those stay off-limits per the documented
// lifecycle) -- orders in those two stages are returned under "skipped" so
// the caller can flag them for human review instead of silently touching a
// terminal order.
//
// Auth is a scoped shared secret (x-automation-secret), distinct from the
// sample-approval function's secret so a leak of one doesn't grant the other.

import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 })
  }

  const secret = req.headers.get('x-automation-secret')
  if (!secret || secret !== Deno.env.get('BOOKING_AUTOMATION_SECRET')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  let body: { po?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json body' }), { status: 400 })
  }

  const po = (body.po ?? '').trim()
  if (!po) {
    return new Response(JSON.stringify({ error: 'po is required' }), { status: 400 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const SELECT_COLS = 'id, po, style_no, style, colour, stage, ex_factory, company, description'

  const { data: existing, error: fetchError } = await supabase
    .from('orders')
    .select(SELECT_COLS)
    .eq('po', po)

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 })
  }

  if (!existing || existing.length === 0) {
    return new Response(
      JSON.stringify({ matched: 0, orders: [], skipped: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const TERMINAL_STAGES = ['Completed', 'Cancelled']
  const eligible = existing.filter((o) => !TERMINAL_STAGES.includes(o.stage ?? ''))
  const skipped = existing
    .filter((o) => TERMINAL_STAGES.includes(o.stage ?? ''))
    .map((o) => ({ id: o.id, po: o.po, style_no: o.style_no, current_stage: o.stage }))
  const oldStageById = new Map(eligible.map((o) => [o.id, o.stage]))

  let updated: typeof existing = []
  if (eligible.length > 0) {
    const ids = eligible.map((o) => o.id)
    const { data: updatedRows, error: updateError } = await supabase
      .from('orders')
      .update({ stage: 'Booked' })
      .in('id', ids)
      .select(SELECT_COLS)

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), { status: 500 })
    }

    updated = updatedRows ?? []

    if (updated.length > 0) {
      const { error: eventError } = await supabase.from('order_events').insert(
        updated.map((o) => ({
          order_id: o.id,
          old_stage: oldStageById.get(o.id) ?? null,
          new_stage: 'Booked',
          changed_by: null,
        }))
      )
      if (eventError) {
        console.error('order_events insert error:', eventError)
      }
    }
  }

  return new Response(
    JSON.stringify({ matched: updated.length, orders: updated, skipped }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
})
