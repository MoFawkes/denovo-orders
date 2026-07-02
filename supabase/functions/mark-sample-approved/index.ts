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

  let query = supabase.from('orders').update({ sample_approved: true }).eq('po', po)
  if (styleNo) {
    query = query.eq('style_no', styleNo)
  }

  const { data, error } = await query.select('id, po, style_no')

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  return new Response(
    JSON.stringify({ matched: data?.length ?? 0, orders: data ?? [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
})
