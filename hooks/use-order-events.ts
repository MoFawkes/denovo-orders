import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export type OrderEvent = {
  id: string
  old_stage: string | null
  new_stage: string | null
  created_at: string
  changed_by: string | null
  metadata: Record<string, unknown> | null
  profiles: { full_name: string | null; role: string | null } | null
}

export function useOrderEvents(orderId: string | null) {
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!orderId) {
      setEvents([])
      setLoading(false)
      return
    }

    setLoading(true)
    const { data, error } = await supabase
      .from('order_events')
      .select('id, old_stage, new_stage, created_at, changed_by, metadata, profiles(full_name, role)')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Load order events error:', error)
      setEvents([])
    } else {
      setEvents((data as unknown as OrderEvent[]) || [])
    }
    setLoading(false)
  }, [orderId])

  useEffect(() => {
    reload()
  }, [reload])

  return { events, loading, reload }
}
