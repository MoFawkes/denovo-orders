// Marks orders.sample_approved = true for a given PO (and optionally style_no).
// Called by the "Sample Approved" Gmail-polling routine — never by end users.
// Auth is a scoped shared secret (x-automation-secret), not a user JWT, since
// the caller is an automation with no Supabase session. The service-role key
// used for the actual write comes from Supabase's auto-injected env var and
// never leaves this function.

import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 })
  }

  const secret = req.headers.get('x-automation-secret')
  if (!secret || secret !== Deno.env.get('SAMPLE_APPROVAL_SECRET')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  let body: { po?: string; style_no?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json body' }), { status: 400 })
  }

  const po = (body.po ?? '').trim()
  const styleNo = body.style_no ? body.style_no.trim() : null

  if (!po) {
    return new Response(JSON.stringify({ error: 'po is required' }), { status: 400 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  let data: { id: string; po: string; style_no: string | null }[] | null

  if (!styleNo) {
    // No style given at all: PO is the sole identifier.
    const result = await supabase
      .from('orders')
      .update({ sample_approved: true })
      .eq('po', po)
      .select('id, po, style_no')

    if (result.error) {
      return new Response(JSON.stringify({ error: result.error.message }), { status: 500 })
    }
    data = result.data
  } else {
    // Exact match first: same PO and same style_no on file.
    const exact = await supabase
      .from('orders')
      .update({ sample_approved: true })
      .eq('po', po)
      .eq('style_no', styleNo)
      .select('id, po, style_no')

    if (exact.error) {
      return new Response(JSON.stringify({ error: exact.error.message }), { status: 500 })
    }
    data = exact.data

    // PLT approval emails put the buyer SKU (e.g. CNQ4218) in their "Style"
    // column, which the extraction passes here as style_no — but on file that
    // value lives in the `style` column, with `style_no` holding our internal
    // number (e.g. D5723). Try the SKU column before giving up.
    if ((data?.length ?? 0) === 0) {
      const bySku = await supabase
        .from('orders')
        .update({ sample_approved: true })
        .eq('po', po)
        .ilike('style', styleNo)
        .select('id, po, style_no')

      if (bySku.error) {
        return new Response(JSON.stringify({ error: bySku.error.message }), { status: 500 })
      }
      data = bySku.data
    }

    // Fallback: a style was supplied but this PO has no style_no on file yet
    // — treat the PO as the sole identifier rather than leaving it unmatched.
    if ((data?.length ?? 0) === 0) {
      const fallback = await supabase
        .from('orders')
        .update({ sample_approved: true })
        .eq('po', po)
        .is('style_no', null)
        .select('id, po, style_no')

      if (fallback.error) {
        return new Response(JSON.stringify({ error: fallback.error.message }), { status: 500 })
      }
      data = fallback.data
    }
  }

  return new Response(
    JSON.stringify({ matched: data?.length ?? 0, orders: data ?? [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
})
