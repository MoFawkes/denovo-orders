import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Alert } from 'react-native'
import { supabase } from '../lib/supabase'
import { sortOrders, type Order } from '../lib/order-workflow'

type RealtimeCallbacks = {
  onUpdate?: (order: Order) => void
  onDelete?: (order: Order) => void
}

export function useOrders(callbacks: RealtimeCallbacks = {}): {
  orders: Order[]
  setOrders: Dispatch<SetStateAction<Order[]>>
  loading: boolean
  refreshing: boolean
  loadOrders: (isRefresh?: boolean) => Promise<void>
} {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const loadOrders = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)

    const { data, error } = await supabase.from('orders').select('*').order('po', { ascending: true })
    if (error) {
      console.error('Load orders error:', error)
      Alert.alert('Error', 'Could not load orders.')
    } else {
      setOrders((data as Order[]) || [])
    }
    if (isRefresh) setRefreshing(false)
    else setLoading(false)
  }, [])

  useEffect(() => {
    loadOrders()
    const channel = supabase.channel('orders-realtime').on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'orders' },
      (payload) => {
        if (payload.eventType === 'INSERT') {
          const order = payload.new as Order
          setOrders((previous) => previous.some((item) => item.id === order.id)
            ? previous
            : [...previous, order].sort(sortOrders))
        } else if (payload.eventType === 'UPDATE') {
          const order = payload.new as Order
          setOrders((previous) => previous.map((item) => item.id === order.id ? order : item).sort(sortOrders))
          callbacksRef.current.onUpdate?.(order)
        } else if (payload.eventType === 'DELETE') {
          const order = payload.old as Order
          setOrders((previous) => previous.filter((item) => item.id !== order.id))
          callbacksRef.current.onDelete?.(order)
        }
      },
    ).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadOrders])

  return { orders, setOrders, loading, refreshing, loadOrders }
}
