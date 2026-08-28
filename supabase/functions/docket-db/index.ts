import { createClient } from 'jsr:@supabase/supabase-js@2'

type Body = Record<string, unknown> & { action?: string }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const FALLBACK_DOCKET_BASE = 241

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const secret = request.headers.get('x-automation-secret')
  if (!secret || secret !== Deno.env.get('DOCKET_DB_SECRET')) return json({ error: 'unauthorized' }, 401)
  let body: Body
  try { body = await request.json() } catch { return json({ error: 'invalid json body' }, 400) }
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    switch (body.action) {
      case 'po-exists': {
        const po = text(body.po)
        if (!po) return json({ error: 'po is required' }, 400)
        const result = await supabase.from('orders').select('id').eq('po', po).not('docket', 'is', null).limit(1)
        if (result.error) throw result.error
        return json({ exists: (result.data?.length ?? 0) > 0 })
      }
      case 'next-docket': {
        const result = await supabase.from('orders').select('docket')
          .eq('source_tab', 'OPO').not('docket', 'is', null)
          .order('docket', { ascending: false }).limit(1)
        if (result.error) throw result.error
        return json({ docketNumber: (result.data?.[0]?.docket ?? FALLBACK_DOCKET_BASE) + 1 })
      }
      case 'lookup-costing': {
        const sku = text(body.sku), styleNo = text(body.styleNo)
        if (sku) {
          const bySku = await supabase.from('style_costings').select('style_no, cmt, price').ilike('style', sku).limit(1)
          if (bySku.error) throw bySku.error
          if (bySku.data?.[0]) return json({ costing: bySku.data[0] })
        }
        if (styleNo) {
          const byStyle = await supabase.from('style_costings').select('style_no, cmt, price').ilike('style_no', styleNo).limit(1)
          if (byStyle.error) throw byStyle.error
          if (byStyle.data?.[0]) return json({ costing: byStyle.data[0] })
        }
        return json({ costing: null })
      }
      case 'save': {
        const storagePath = text(body.storagePath), fileBase64 = text(body.fileBase64)
        const buyerReferencePo = text(body.buyerReferencePo), buyerReferenceCsv = text(body.buyerReferenceCsv)
        const rows = Array.isArray(body.rows) ? body.rows : []
        if (!storagePath || !fileBase64 || rows.length === 0) {
          return json({ error: 'storagePath, fileBase64, and rows are required' }, 400)
        }
        const bytes = Uint8Array.from(atob(fileBase64), (character) => character.charCodeAt(0))
        const upload = await supabase.storage.from('orders').upload(storagePath, bytes, {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          upsert: true,
        })
        let buyerReferenceSaveError: string | null = null
        if (buyerReferencePo || buyerReferenceCsv) {
          if (!/^\d{10}$/.test(buyerReferencePo) || !buyerReferenceCsv) {
            buyerReferenceSaveError = 'buyerReferencePo must be ten digits and buyerReferenceCsv is required'
          } else {
            const buyerReferenceSave = await supabase.from('buyer_po_references').upsert({
              po: buyerReferencePo, csv_text: buyerReferenceCsv, source: 'docket-email', updated_at: new Date().toISOString(),
            })
            buyerReferenceSaveError = buyerReferenceSave.error?.message ?? null
          }
        }
        const docketUrl = upload.error
          ? null
          : supabase.storage.from('orders').getPublicUrl(storagePath).data.publicUrl
        const errors: string[] = []
        for (const row of rows) {
          const result = await supabase.from('orders').upsert(
            { ...(row as Record<string, unknown>), docket_url: docketUrl },
            { onConflict: 'po,style,colour' },
          )
          if (result.error) errors.push(result.error.message)
        }
        return json({
          docketUrl, uploadError: upload.error?.message ?? null,
          buyerReferenceSaveError, rowErrors: errors,
        })
      }
      default:
        return json({ error: 'unknown action' }, 400)
    }
  } catch (error) {
    console.error('docket-db error:', error)
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})
