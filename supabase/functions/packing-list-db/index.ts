import { createClient } from 'jsr:@supabase/supabase-js@2'

type Body = Record<string, unknown> & { action?: string }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const normalisePo = (value: unknown) => {
  const digits = text(value).replace(/\D/g, '')
  return digits ? digits.padStart(10, '0') : null
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  const secret = request.headers.get('x-automation-secret')
  if (!secret || secret !== Deno.env.get('PACKING_LIST_DB_SECRET')) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: Body
  try { body = await request.json() } catch { return json({ error: 'invalid json body' }, 400) }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  try {
    switch (body.action) {
      case 'snapshot': {
        const [bookedResult, linkedResult] = await Promise.all([
          supabase.from('orders').select('id, po, style, style_no, description').eq('stage', 'Booked'),
          supabase.from('orders').select('packing_list_url').neq('packing_list_url', ''),
        ])
        if (bookedResult.error) throw bookedResult.error
        if (linkedResult.error) throw linkedResult.error
        const linkedFileIds = (linkedResult.data ?? [])
          .map((row) => row.packing_list_url?.match(/\/d\/([A-Za-z0-9_-]{20,})/)?.[1])
          .filter(Boolean)
        return json({ booked: bookedResult.data ?? [], linkedFileIds })
      }

      case 'orders-for-po': {
        const po = normalisePo(body.po)
        if (!po) return json({ error: 'po is required' }, 400)
        const result = await supabase
          .from('orders').select('id, po, style, style_no, description, stage').eq('po', po)
        if (result.error) throw result.error
        return json({ orders: result.data ?? [] })
      }

      case 'complete': {
        const fileId = text(body.fileId)
        const po = normalisePo(body.po)
        const sku = text(body.sku).toUpperCase()
        const invoice = text(body.invoice)
        if (!fileId || !po || !sku || !invoice) {
          return json({ error: 'fileId, po, sku, and invoice are required' }, 400)
        }
        const existing = await supabase
          .from('orders').select('id, po, style, style_no, description, stage')
          .eq('stage', 'Booked').eq('po', po)
        if (existing.error) throw existing.error
        const matched = (existing.data ?? []).filter(
          (order) => text(order.style).toUpperCase() === sku,
        )
        if (matched.length === 0) return json({ matched: 0, orders: [] })

        const ids = matched.map((order) => order.id)
        const packingListUrl = `https://docs.google.com/spreadsheets/d/${fileId}/edit?usp=sharing`
        const update = await supabase.from('orders').update({
          stage: 'Completed', packing_list_url: packingListUrl, invoice_no: invoice,
        }).in('id', ids)
        if (update.error) throw update.error

        const events = await supabase.from('order_events').insert(ids.map((orderId) => ({
          order_id: orderId, old_stage: 'Booked', new_stage: 'Completed', changed_by: null,
        })))
        if (events.error) console.error('order_events insert error:', events.error)
        return json({
          matched: matched.length,
          orders: matched,
          packingListUrl,
          eventWarning: events.error?.message ?? null,
        })
      }

      case 'invoice-allocate': {
        const rawStart = body.startAt
        const startAt = rawStart === undefined || rawStart === null || rawStart === ''
          ? null
          : Number(rawStart)
        if (startAt !== null && (!Number.isSafeInteger(startAt) || startAt < 1)) {
          return json({ error: 'startAt must be a positive integer' }, 400)
        }
        const result = await supabase.rpc('allocate_automation_counter', {
          counter_name: 'invoice_number',
          floor_value: startAt,
        })
        if (result.error) throw result.error
        return json({ invoice: String(result.data) })
      }

      case 'checkpoint-get': {
        const automation = text(body.automation), sourceId = text(body.sourceId), step = text(body.step)
        if (!automation || !sourceId || !step) return json({ error: 'checkpoint identity is required' }, 400)
        const result = await supabase.from('automation_executions')
          .select('status, attempt_count, result, last_error')
          .eq('automation', automation).eq('source_id', sourceId).eq('step', step).maybeSingle()
        if (result.error) throw result.error
        return json({ execution: result.data })
      }

      case 'checkpoint-complete':
      case 'checkpoint-fail': {
        const automation = text(body.automation), sourceId = text(body.sourceId), step = text(body.step)
        if (!automation || !sourceId || !step) return json({ error: 'checkpoint identity is required' }, 400)
        const previous = await supabase.from('automation_executions')
          .select('attempt_count, result').eq('automation', automation)
          .eq('source_id', sourceId).eq('step', step).maybeSingle()
        if (previous.error) throw previous.error
        const completed = body.action === 'checkpoint-complete'
        const now = new Date().toISOString()
        const upsert = await supabase.from('automation_executions').upsert({
          automation, source_id: sourceId, step,
          status: completed ? 'completed' : 'failed',
          attempt_count: (previous.data?.attempt_count ?? 0) + 1,
          result: completed ? (body.result ?? {}) : (previous.data?.result ?? {}),
          last_error: completed ? null : text(body.error),
          last_attempted_at: now,
          completed_at: completed ? now : null,
        })
        if (upsert.error) throw upsert.error
        return json({ ok: true })
      }

      case 'portal-submission-get': {
        const idempotencyKey = text(body.idempotencyKey)
        if (!idempotencyKey) return json({ error: 'idempotencyKey is required' }, 400)
        const result = await supabase.from('portal_submissions').select('*')
          .eq('idempotency_key', idempotencyKey).maybeSingle()
        if (result.error) throw result.error
        return json({ submission: result.data })
      }

      case 'portal-submission-claim': {
        if (!body.manifest || typeof body.manifest !== 'object' || !text(body.runnerId)) {
          return json({ error: 'manifest and runnerId are required' }, 400)
        }
        const result = await supabase.rpc('claim_portal_submission', {
          submission: body.manifest, runner_id: text(body.runnerId),
        })
        if (result.error) throw result.error
        return json({ submission: result.data })
      }

      case 'portal-submission-transition': {
        const idempotencyKey = text(body.idempotencyKey)
        const expectedState = text(body.expectedState), nextState = text(body.nextState)
        if (!idempotencyKey || !expectedState || !nextState) return json({ error: 'transition identity is required' }, 400)
        const result = await supabase.rpc('transition_portal_submission', {
          submission_key: idempotencyKey,
          expected_state: expectedState,
          next_state: nextState,
          patch: body.result ?? {},
          error_text: text(body.error) || null,
        })
        if (result.error) throw result.error
        return json({ submission: result.data })
      }

      default:
        return json({ error: 'unknown action' }, 400)
    }
  } catch (error) {
    console.error('packing-list-db error:', error)
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})
