import { useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Linking,
  Alert,
  TextInput,
  ScrollView,
  Image,
  useWindowDimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { MaterialIcons } from '@expo/vector-icons'
import DotsLoader from '../components/DotsLoader'
import ScreenContainer from '../components/layout/ScreenContainer'
import StatusChip from '../components/StatusChip'
import BottomTabBar from '../components/navigation/BottomTabBar'
import { supabase } from '../lib/supabase'
import { useAuth } from '../providers/AuthProvider'
import { colors, radius, spacing, typography } from '../theme/tokens'

type Order = {
  id: string
  source_tab: string | null
  company: string | null
  po: string | null
  style_no: string | null
  style: string | null
  description: string | null
  fabric: string | null
  colour: string | null
  qty: number | string | null
  ex_factory: string | null
  docket: number | string | null
  docket_url: string | null
  invoice_no: string | null
  packing_list_url: string | null
  stage: string | null
  notes: string | null
  image_url?: string | null
  product_url?: string | null
  updated_by?: string | null
}

const STAGES = ['Cutting', 'Production', 'Packing', 'Ready', 'Completed'] as const
type Stage = (typeof STAGES)[number]
type TabType = 'active' | 'completed'

function getStageRank(stage: string | null): number {
  switch (stage) {
    case 'Ready':
      return 1
    case 'Packing':
      return 2
    case 'Production':
      return 3
    case 'Cutting':
      return 4
    case 'Completed':
      return 5
    default:
      return 99
  }
}

function parseExFactory(val: string | null): number {
  if (!val) return 0
  const m = val.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) {
    const d = new Date(`${m[1]}-${m[3]}-${m[2]}`)
    return isNaN(d.getTime()) ? 0 : d.getTime()
  }
  return 0
}

function sortOrders(a: Order, b: Order) {
  if (a.stage === 'Completed' && b.stage === 'Completed') {
    return parseExFactory(b.ex_factory) - parseExFactory(a.ex_factory)
  }

  const stageDiff = getStageRank(a.stage) - getStageRank(b.stage)
  if (stageDiff !== 0) return stageDiff

  return (a.po || '').localeCompare(b.po || '', undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function normaliseUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  return `https://${trimmed}`
}

function isValidUrl(value: string) {
  try {
    const url = new URL(value)
    return !!url.protocol && !!url.host
  } catch {
    return false
  }
}

function toChipStatus(stage: string | null) {
  switch (stage) {
    case 'Cutting':
      return 'CUTTING'
    case 'Production':
      return 'PRODUCTION'
    case 'Packing':
      return 'PACKING'
    case 'Ready':
      return 'READY'
    case 'Completed':
      return 'COMPLETED'
    default:
      return 'PRODUCTION'
  }
}

function getStageAccent(stage: string | null) {
  switch (stage) {
    case 'Cutting':
      return colors.warning
    case 'Production':
      return colors.primary
    case 'Packing':
      return colors.info
    case 'Ready':
      return colors.success
    case 'Completed':
      return colors.success
    default:
      return colors.borderStrong
  }
}

function stageColor(stage: string | null): string {
  switch (stage) {
    case 'Cutting': return '#c0392b'
    case 'Production': return '#e67e22'
    case 'Packing': return '#2980b9'
    case 'Ready': return '#27ae60'
    case 'Completed': return '#1e8449'
    default: return '#7f8c8d'
  }
}

function MetricCard({
  label,
  value,
  tone = 'primary',
}: {
  label: string
  value: string | number
  tone?: 'primary' | 'success'
}) {
  return (
    <View
      style={[
        styles.metricCard,
        tone === 'success' ? styles.metricCardSuccess : null,
      ]}
    >
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  )
}

export default function OpoScreen() {
  const [packingListEditValue, setPackingListEditValue] = useState('')
  const [savingPackingList, setSavingPackingList] = useState(false)
  const [showCompletePrompt, setShowCompletePrompt] = useState(false)
  const [packingListInput, setPackingListInput] = useState('')
  const [completeLoading, setCompleteLoading] = useState(false)
  const [pendingCompleteOrderId, setPendingCompleteOrderId] = useState<string | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [selectedTab, setSelectedTab] = useState<TabType>('active')
  const [searchQuery, setSearchQuery] = useState('')
  const [orderNotes, setOrderNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)

  const listRef = useRef<FlatList<Order>>(null)
  const scrollOffsetRef = useRef(0)
  const lastOpenedOrderIdRef = useRef<string | null>(null)
  const { width } = useWindowDimensions()
  const isCompact = width < 720
  const isNarrow = width < 520
  const isDesktop = width >= 900
  const params = useLocalSearchParams<{ orderId?: string }>()
  const hasHandledInitialParam = useRef(false)

  const { signOut, role, user } = useAuth()

  useEffect(() => {
    loadOrders()

    const channel = supabase
      .channel('orders-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newOrder = payload.new as Order
            setOrders((prev) => {
              const exists = prev.some((order) => order.id === newOrder.id)
              if (exists) return prev
              return [...prev, newOrder].sort(sortOrders)
            })
            return
          }

          if (payload.eventType === 'UPDATE') {
            const updatedOrder = payload.new as Order
            setOrders((prev) =>
              prev
                .map((order) => (order.id === updatedOrder.id ? updatedOrder : order))
                .sort(sortOrders)
            )
            setSelectedOrder((prev) => {
              if (!prev || prev.id !== updatedOrder.id) return prev
              setOrderNotes(updatedOrder.notes ?? '')
              setPackingListEditValue(updatedOrder.packing_list_url ?? '')
              return updatedOrder
            })
            return
          }

          if (payload.eventType === 'DELETE') {
            const deletedOrder = payload.old as Order
            setOrders((prev) => prev.filter((order) => order.id !== deletedOrder.id))
            setSelectedOrder((prev) =>
              prev && prev.id === deletedOrder.id ? null : prev
            )
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function loadOrders() {
    setLoading(true)

    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('po', { ascending: true })

    if (error) {
      console.log('Load orders error:', error)
      Alert.alert('Error', 'Could not load orders.')
    } else {
      setOrders((data as Order[]) || [])
    }

    setLoading(false)
  }

  const activeOrders = useMemo(
    () => orders.filter((order) => order.stage !== 'Completed'),
    [orders]
  )

  const completedOrders = useMemo(
    () => orders.filter((order) => order.stage === 'Completed'),
    [orders]
  )

  const baseVisibleOrders =
    selectedTab === 'active' ? activeOrders : completedOrders

  const filteredOrders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return baseVisibleOrders
    return baseVisibleOrders.filter((order) => {
      const searchableFields = [
        order.po,
        order.style,
        order.style_no,
        order.colour,
        order.description,
        order.fabric,
        order.company,
        order.notes,
      ]
      return searchableFields.some((field) =>
        String(field || '').toLowerCase().includes(query)
      )
    })
  }, [baseVisibleOrders, searchQuery])

  const readyCount = useMemo(
    () => activeOrders.filter((order) => order.stage === 'Ready').length,
    [activeOrders]
  )

  useEffect(() => {
    if (!params.orderId || !orders.length || selectedOrder || hasHandledInitialParam.current) {
      return
    }
    const matchingOrder = orders.find((order) => order.id === params.orderId)
    if (matchingOrder) {
      hasHandledInitialParam.current = true
      openOrder(matchingOrder)
    }
  }, [params.orderId, orders, selectedOrder])

  function openOrder(order: Order) {
    lastOpenedOrderIdRef.current = order.id
    setSelectedOrder(order)
    setOrderNotes(order.notes ?? '')
    setPackingListEditValue(order.packing_list_url ?? '')
  }

  function handlePrint() {
    if (typeof window === 'undefined') return

    const printStyles = `
      @media print {
        body > * { display: none !important; }
        #denovo-print-table { display: block !important; }
        @page { size: A4 landscape; margin: 0; }
      }
      #denovo-print-table {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        transform-origin: top left;
      }
      #denovo-print-table .zebra-row:nth-child(even) td {
        background-color: #f9fafb;
      }
    `

    const styleTag = document.createElement('style')
    styleTag.innerHTML = printStyles
    document.head.appendChild(styleTag)

    const div = document.createElement('div')
    div.id = 'denovo-print-table'
    div.style.display = 'none'

    function stageBadge(stage: string | null): string {
      switch (stage) {
        case 'Cutting':    return 'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;'
        case 'Production': return 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;'
        case 'Packing':    return 'background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;'
        case 'Ready':      return 'background:#d1fae5;color:#065f46;border:1px solid #6ee7b7;'
        case 'Completed':  return 'background:#d1fae5;color:#065f46;border:1px solid #6ee7b7;'
        default:           return 'background:#f3f4f6;color:#374151;border:1px solid #d1d5db;'
      }
    }

    const rows = activeOrders.map((order, i) => `
      <tr class="zebra-row">
        <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:11px;">${order.po || '-'}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;">${order.description || order.style || '-'}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;">${order.style_no || order.style || '-'}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;">${order.colour || '-'}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;">${order.qty != null ? order.qty.toLocaleString() : '-'}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;">${order.ex_factory || '-'}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;text-align:center;">
          <span style="${stageBadge(order.stage)}padding:2px 8px;border-radius:999px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;">
            ${order.stage || '-'}
          </span>
        </td>
        <td style="padding:7px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:11px;font-style:italic;">${order.notes || '—'}</td>
      </tr>
    `).join('')

    const printDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase()

    div.innerHTML = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:0;color:#111;">
        <header style="display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:14px;margin-bottom:18px;border-bottom:2px solid #002d6e;">
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <div style="width:5px;height:56px;background:#002d6e;flex-shrink:0;"></div>
            <div>
              <div style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#002d6e;margin-bottom:4px;">Denovo Apparel Ltd</div>
              <div style="font-size:22px;font-weight:800;color:#001945;line-height:1.1;">Active Orders</div>
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px;color:#374151;margin-bottom:3px;">Internal Production Document</div>
            <div style="font-size:9px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;">${printDate} &nbsp;·&nbsp; ${activeOrders.length} TOTAL ORDERS</div>
          </div>
        </header>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#002d6e;color:#fff;">
              <th style="padding:8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">PO No.</th>
              <th style="padding:8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">Description</th>
              <th style="padding:8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">Style No</th>
              <th style="padding:8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">Colour</th>
              <th style="padding:8px;text-align:right;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">Qty</th>
              <th style="padding:8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">Ex Factory</th>
              <th style="padding:8px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">Stage</th>
              <th style="padding:8px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;">Notes</th>
            </tr>
          </thead>
          <tbody style="color:#111;">
            ${rows}
          </tbody>
        </table>
      </div>
    `

    document.body.appendChild(div)

    // Use zoom (affects layout, unlike transform) to fit everything on one A4 landscape page
    const A4_H = 794  // 210mm at 96dpi
    const PADDING = 40
    const inner = div.firstElementChild as HTMLElement
    if (inner) {
      const contentH = inner.scrollHeight
      const scale = Math.min((A4_H - PADDING * 2) / contentH, 1)
      inner.style.zoom = `${scale}`
      div.style.padding = `${PADDING}px`
    }

    window.print()

    setTimeout(() => {
      document.body.removeChild(div)
      document.head.removeChild(styleTag)
    }, 1500)
  }

  async function updateOrderStage(
    orderId: string,
    currentStage: string | null,
    nextStage: Stage,
    packingListUrl?: string
  ) {
    const updatePayload: Record<string, unknown> = {
      stage: nextStage,
      updated_by: user?.id ?? null,
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
      old_stage: currentStage,
      new_stage: nextStage,
      changed_by: user?.id ?? null,
      metadata:
        nextStage === 'Completed' && packingListUrl
          ? { packing_list_url: packingListUrl }
          : null,
    })

    if (eventError) {
      console.log('Order event insert error:', eventError)
    }
  }

  async function updateStage(order: Order, newStage: Stage, packingListUrl?: string) {
    const previousOrders = [...orders]
    const previousStage = order.stage

    const optimisticOrder: Order = {
      ...order,
      stage: newStage,
      updated_by: user?.id ?? null,
      packing_list_url:
        typeof packingListUrl === 'string'
          ? packingListUrl
          : order.packing_list_url ?? null,
    }

    setOrders((prev) =>
      prev
        .map((item) => (item.id === order.id ? optimisticOrder : item))
        .sort(sortOrders)
    )

    if (selectedOrder?.id === order.id) {
      setSelectedOrder(optimisticOrder)
      setPackingListEditValue(optimisticOrder.packing_list_url ?? '')
    }

    try {
      await updateOrderStage(order.id, previousStage, newStage, packingListUrl)

      if (newStage === 'Completed') {
        setSelectedOrder(null)
        setSelectedTab('completed')
        setOrderNotes('')
        setShowCompletePrompt(false)
        setPendingCompleteOrderId(null)
        setPackingListInput('')
        Alert.alert('Success', 'Order moved to Completed Orders.')
      }
    } catch (error) {
      console.log('Update stage error:', error)
      setOrders(previousOrders)

      if (selectedOrder?.id === order.id) {
        setSelectedOrder(order)
        setPackingListEditValue(order.packing_list_url ?? '')
      }

      Alert.alert('Error', 'Could not update stage.')
    }
  }

  function handleStagePress(order: Order, newStage: Stage) {
    if (order.stage === newStage) return

    if (newStage === 'Completed') {
      setPendingCompleteOrderId(order.id)
      setPackingListInput(order.packing_list_url ?? '')
      setShowCompletePrompt(true)
      return
    }

    setShowCompletePrompt(false)
    setPendingCompleteOrderId(null)
    setPackingListInput('')
    updateStage(order, newStage)
  }

  async function handleConfirmCompleteInline() {
    if (!pendingCompleteOrderId) return

    const targetOrder = orders.find((order) => order.id === pendingCompleteOrderId)

    if (!targetOrder) {
      Alert.alert('Error', 'Order not found.')
      return
    }

    const normalised = normaliseUrl(packingListInput)

    if (!isValidUrl(normalised)) {
      Alert.alert('Invalid link', 'Please enter a valid packing list URL.')
      return
    }

    try {
      setCompleteLoading(true)
      await updateStage(targetOrder, 'Completed', normalised)
      setShowCompletePrompt(false)
      setPendingCompleteOrderId(null)
      setPackingListInput('')
    } catch (error) {
      console.log('Complete order error:', error)
      Alert.alert('Error', 'Could not complete order.')
    } finally {
      setCompleteLoading(false)
    }
  }

  async function saveOrderNotes() {
    if (!selectedOrder) return

    try {
      setSavingNotes(true)

      const trimmedNotes = orderNotes.trim()

      const { error } = await supabase
        .from('orders')
        .update({
          notes: trimmedNotes,
          updated_by: user?.id ?? null,
        })
        .eq('id', selectedOrder.id)

      if (error) throw error

      const updatedOrder: Order = {
        ...selectedOrder,
        notes: trimmedNotes,
        updated_by: user?.id ?? null,
      }

      setOrders((prev) =>
        prev
          .map((item) => (item.id === selectedOrder.id ? updatedOrder : item))
          .sort(sortOrders)
      )

      setSelectedOrder(updatedOrder)
      Alert.alert('Saved', 'Order notes updated.')
    } catch (error: any) {
      console.log('Save notes error:', error)
      Alert.alert('Error', error?.message || 'Could not save notes.')
    } finally {
      setSavingNotes(false)
    }
  }

  async function savePackingListUrl() {
    if (!selectedOrder) return

    const normalised = normaliseUrl(packingListEditValue)

    if (!isValidUrl(normalised)) {
      Alert.alert('Invalid link', 'Please enter a valid packing list URL.')
      return
    }

    try {
      setSavingPackingList(true)

      const { error } = await supabase
        .from('orders')
        .update({
          packing_list_url: normalised,
          updated_by: user?.id ?? null,
        })
        .eq('id', selectedOrder.id)

      if (error) throw error

      const updatedOrder: Order = {
        ...selectedOrder,
        packing_list_url: normalised,
        updated_by: user?.id ?? null,
      }

      setOrders((prev) =>
        prev
          .map((item) => (item.id === selectedOrder.id ? updatedOrder : item))
          .sort(sortOrders)
      )

      setSelectedOrder(updatedOrder)
      setPackingListEditValue(normalised)

      Alert.alert('Saved', 'Packing list link updated.')
    } catch (error: any) {
      console.log('Save packing list error:', error)
      Alert.alert('Error', error?.message || 'Could not save packing list link.')
    } finally {
      setSavingPackingList(false)
    }
  }

  async function handleImageUpload(file: File) {
    if (!selectedOrder) return
    try {
      setUploadingImage(true)
      const ext = file.name.split('.').pop() ?? 'jpg'
      const path = `orders/${selectedOrder.id}/image_${Date.now()}.${ext}`

      const { error: uploadError } = await supabase.storage
        .from('order-images')
        .upload(path, file, { upsert: true, contentType: file.type })

      if (uploadError) throw uploadError

      const { data: { publicUrl } } = supabase.storage
        .from('order-images')
        .getPublicUrl(path)

      const { error: updateError } = await supabase
        .from('orders')
        .update({ image_url: publicUrl, updated_by: user?.id ?? null })
        .eq('id', selectedOrder.id)

      if (updateError) throw updateError

      const updatedOrder: Order = { ...selectedOrder, image_url: publicUrl }
      setOrders((prev) => prev.map((o) => (o.id === selectedOrder.id ? updatedOrder : o)))
      setSelectedOrder(updatedOrder)
    } catch (error: any) {
      Alert.alert('Upload failed', error?.message || 'Could not upload image.')
    } finally {
      setUploadingImage(false)
    }
  }

  async function openDocket(url: string | null) {
    if (!url) {
      Alert.alert('No docket linked', 'This order does not have a docket URL yet.')
      return
    }
    try {
      await Linking.openURL(url.trim())
    } catch (error) {
      console.log('Open docket error:', error)
      Alert.alert('Invalid link', 'Could not open docket link.')
    }
  }

  async function openPackingList(url: string | null) {
    if (!url) {
      Alert.alert(
        'No packing list linked',
        'This order does not have a packing list URL yet.'
      )
      return
    }
    try {
      await Linking.openURL(url.trim())
    } catch (error) {
      console.log('Open packing list error:', error)
      Alert.alert('Invalid link', 'Could not open packing list link.')
    }
  }

  function closeOrderDetail() {
    if (params.orderId) {
      hasHandledInitialParam.current = true
    }

    const targetOrderId = lastOpenedOrderIdRef.current

    setSelectedOrder(null)
    setShowCompletePrompt(false)
    setPendingCompleteOrderId(null)
    setPackingListInput('')
    setPackingListEditValue('')

    requestAnimationFrame(() => {
      setTimeout(() => {
        if (!targetOrderId) {
          listRef.current?.scrollToOffset({
            offset: scrollOffsetRef.current,
            animated: false,
          })
          return
        }

        const targetIndex = filteredOrders.findIndex(
          (order) => order.id === targetOrderId
        )

        if (targetIndex >= 0) {
          listRef.current?.scrollToIndex({
            index: targetIndex,
            animated: false,
            viewPosition: 0.18,
          })
        } else {
          listRef.current?.scrollToOffset({
            offset: scrollOffsetRef.current,
            animated: false,
          })
        }
      }, 50)
    })
  }

  function renderOrderCard({ item }: { item: Order }) {
    const accent = getStageAccent(item.stage)
    const hasPackingList = item.stage === 'Completed' && !!item.packing_list_url

    return (
      <TouchableOpacity
        activeOpacity={0.9}
        style={styles.orderCard}
        onPress={() => openOrder(item)}
      >
        <View style={[styles.orderAccent, { backgroundColor: accent }]} />

        <View style={styles.orderCardBody}>
          <View style={styles.orderCardTop}>
            <View style={styles.orderMetaBlock}>
              <Text style={styles.orderEyebrow}>PO {item.po || '-'}</Text>
              <Text style={styles.orderTitle}>
                {item.description || item.style || 'Untitled order'}
              </Text>
            </View>
            <StatusChip status={toChipStatus(item.stage)} />
          </View>

          <View style={styles.orderInfoGrid}>
            <View style={styles.orderInfoItem}>
              <Text style={styles.orderInfoLabel}>Style</Text>
              <Text style={styles.orderInfoValue}>{item.style_no || item.style || '-'}</Text>
            </View>
            <View style={styles.orderInfoItem}>
              <Text style={styles.orderInfoLabel}>Colour</Text>
              <Text style={styles.orderInfoValue}>{item.colour || '-'}</Text>
            </View>
            <View style={styles.orderInfoItem}>
              <Text style={styles.orderInfoLabel}>Quantity</Text>
              <Text style={styles.orderInfoValue}>{item.qty ?? '-'}</Text>
            </View>
            <View style={styles.orderInfoItem}>
              <Text style={styles.orderInfoLabel}>Ex Factory</Text>
              <Text style={styles.orderInfoValue}>{item.ex_factory || '-'}</Text>
            </View>
          </View>

          {!!item.notes?.trim() && (
            <View style={styles.noteBanner}>
              <MaterialIcons name="sticky-note-2" size={16} color={colors.primary} />
              <Text numberOfLines={2} style={styles.noteBannerText}>
                {item.notes}
              </Text>
            </View>
          )}

          <View style={styles.orderCardFooter}>
            <TouchableOpacity style={styles.secondaryAction} onPress={() => openOrder(item)}>
              <Text style={styles.secondaryActionText}>Open Details</Text>
              <MaterialIcons name="chevron-right" size={18} color={colors.primary} />
            </TouchableOpacity>

            {hasPackingList ? (
              <TouchableOpacity
                style={styles.packingListAction}
                onPress={() => openPackingList(item.packing_list_url)}
              >
                <Text style={styles.packingListActionText}>Packing List</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </TouchableOpacity>
    )
  }

  if (loading) {
    return (
      <View style={styles.loadingScreen}>
        <DotsLoader />
      </View>
    )
  }

  if (selectedOrder) {
    const notesChanged = orderNotes.trim() !== (selectedOrder.notes ?? '').trim()
    const packingListChanged =
      packingListEditValue.trim() !== (selectedOrder.packing_list_url ?? '').trim()

    return (
      <ScreenContainer>
        <KeyboardAvoidingView
          style={styles.keyboardFlex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.screen}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.detailScrollContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            >
              <TouchableOpacity onPress={closeOrderDetail} style={styles.backButton}>
                <MaterialIcons name="arrow-back" size={18} color={colors.primary} />
                <Text style={styles.backButtonText}>Back to orders</Text>
              </TouchableOpacity>

              <View style={styles.detailHero}>
                <View style={[styles.detailHeroTop, isCompact && styles.stackRow]}>
                  <View style={styles.detailHeroTextBlock}>
                    <Text style={styles.detailEyebrow}>PO {selectedOrder.po || '-'}</Text>
                    <Text style={styles.detailTitle}>
                      {selectedOrder.description || selectedOrder.style || 'Untitled order'}
                    </Text>
                  </View>
                  <StatusChip status={toChipStatus(selectedOrder.stage)} />
                </View>

                <View style={styles.detailMetaGrid}>
                  <View style={[styles.detailMetaCard, isCompact && styles.fullWidthCard]}>
                    <Text style={styles.detailMetaLabel}>Style</Text>
                    <Text style={styles.detailMetaValue}>
                      {selectedOrder.style_no || selectedOrder.style || '-'}
                    </Text>
                  </View>
                  <View style={[styles.detailMetaCard, isCompact && styles.fullWidthCard]}>
                    <Text style={styles.detailMetaLabel}>Colour</Text>
                    <Text style={styles.detailMetaValue}>{selectedOrder.colour || '-'}</Text>
                  </View>
                  <View style={[styles.detailMetaCard, isCompact && styles.fullWidthCard]}>
                    <Text style={styles.detailMetaLabel}>Quantity</Text>
                    <Text style={styles.detailMetaValue}>{selectedOrder.qty ?? '-'}</Text>
                  </View>
                  <View style={[styles.detailMetaCard, isCompact && styles.fullWidthCard]}>
                    <Text style={styles.detailMetaLabel}>Ex Factory</Text>
                    <Text style={styles.detailMetaValue}>{selectedOrder.ex_factory || '-'}</Text>
                  </View>
                </View>
              </View>

              <View style={styles.detailImageWrapper}>
                {selectedOrder.image_url && (
                  <Image
                    source={{ uri: selectedOrder.image_url }}
                    style={styles.detailImage}
                    resizeMode="cover"
                  />
                )}
                {Platform.OS === 'web' && (
                  <TouchableOpacity
                    style={styles.imageUploadButton}
                    onPress={() => {
                      const input = document.createElement('input')
                      input.type = 'file'
                      input.accept = 'image/*'
                      input.onchange = (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0]
                        if (file) handleImageUpload(file)
                      }
                      input.click()
                    }}
                    disabled={uploadingImage}
                  >
                    {uploadingImage ? (
                      <ActivityIndicator size="small" color={colors.primaryDeep} />
                    ) : (
                      <>
                        <MaterialIcons name="upload" size={14} color={colors.primaryDeep} />
                        <Text style={styles.imageUploadButtonText}>Upload image</Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.detailPanel}>
                <Text style={styles.detailPanelTitle}>Order Overview</Text>
                <Text style={styles.detailDescription}>
                  {selectedOrder.description || 'No description available.'}
                </Text>

                <View style={[styles.inlineMetaRow, isCompact && styles.stackRow]}>
                  <View style={styles.inlineMetaItem}>
                    <Text style={styles.inlineMetaLabel}>Fabric</Text>
                    <Text style={styles.inlineMetaValue}>{selectedOrder.fabric || '-'}</Text>
                  </View>
                  <View style={styles.inlineMetaItem}>
                    <Text style={styles.inlineMetaLabel}>Invoice</Text>
                    <Text style={styles.inlineMetaValue}>{selectedOrder.invoice_no || '-'}</Text>
                  </View>
                </View>

                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.primaryActionButton}
                    onPress={() => openDocket(selectedOrder.docket_url)}
                  >
                    <MaterialIcons name="description" size={18} color="#FFFFFF" />
                    <Text style={styles.primaryActionText}>
                      Open Docket {selectedOrder.docket ? `#${selectedOrder.docket}` : ''}
                    </Text>
                  </TouchableOpacity>

                  {selectedOrder.stage === 'Completed' && !!selectedOrder.packing_list_url ? (
                    <TouchableOpacity
                      style={styles.lightActionButton}
                      onPress={() => openPackingList(selectedOrder.packing_list_url)}
                    >
                      <Text style={styles.lightActionText}>Open Packing List</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>

              {selectedOrder.stage === 'Completed' ? (
                <View style={styles.formCard}>
                  <Text style={styles.formCardTitle}>Packing List Link</Text>
                  <Text style={styles.formCardSubtitle}>
                    Keep the final packing link up to date for downstream teams.
                  </Text>

                  <TextInput
                    style={styles.singleLineInput}
                    value={packingListEditValue}
                    onChangeText={setPackingListEditValue}
                    placeholder="Paste packing list link"
                    placeholderTextColor={colors.textSoft}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    editable={!savingPackingList}
                  />

                  <View style={styles.formActionRow}>
                    {!!selectedOrder.packing_list_url && (
                      <TouchableOpacity
                        style={styles.lightActionButton}
                        onPress={() => openPackingList(selectedOrder.packing_list_url)}
                      >
                        <Text style={styles.lightActionText}>Open Link</Text>
                      </TouchableOpacity>
                    )}

                    <TouchableOpacity
                      style={[
                        styles.primaryCompactButton,
                        (!packingListChanged || savingPackingList) && styles.buttonDisabled,
                      ]}
                      onPress={savePackingListUrl}
                      disabled={!packingListChanged || savingPackingList}
                    >
                      <Text style={styles.primaryCompactButtonText}>
                        {savingPackingList ? 'Saving...' : 'Save Packing List'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}

              <View style={styles.formCard}>
                <Text style={styles.formCardTitle}>Order Notes</Text>
                <Text style={styles.formCardSubtitle}>
                  Shared updates for trims, fabric arrivals, urgency, or packing context.
                </Text>

                <TextInput
                  style={styles.notesInput}
                  multiline
                  value={orderNotes}
                  onChangeText={setOrderNotes}
                  placeholder="Write notes here..."
                  placeholderTextColor={colors.textSoft}
                  textAlignVertical="top"
                />

                <TouchableOpacity
                  style={[
                    styles.primaryCompactButton,
                    (!notesChanged || savingNotes) && styles.buttonDisabled,
                  ]}
                  onPress={saveOrderNotes}
                  disabled={!notesChanged || savingNotes}
                >
                  <Text style={styles.primaryCompactButtonText}>
                    {savingNotes ? 'Saving...' : 'Save Notes'}
                  </Text>
                </TouchableOpacity>
              </View>

              {showCompletePrompt && pendingCompleteOrderId === selectedOrder.id ? (
                <View style={styles.formCard}>
                  <Text style={styles.formCardTitle}>Complete Order</Text>
                  <Text style={styles.formCardSubtitle}>
                    Add the packing list before moving this order into completed.
                  </Text>

                  <TextInput
                    style={styles.singleLineInput}
                    value={packingListInput}
                    onChangeText={setPackingListInput}
                    placeholder="Paste packing list link"
                    placeholderTextColor={colors.textSoft}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    editable={!completeLoading}
                  />

                  <View style={styles.formActionRow}>
                    <TouchableOpacity
                      style={styles.lightActionButton}
                      onPress={() => {
                        if (completeLoading) return
                        setShowCompletePrompt(false)
                        setPendingCompleteOrderId(null)
                        setPackingListInput('')
                      }}
                    >
                      <Text style={styles.lightActionText}>Cancel</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.primaryCompactButton,
                        completeLoading && styles.buttonDisabled,
                      ]}
                      onPress={handleConfirmCompleteInline}
                      disabled={completeLoading}
                    >
                      <Text style={styles.primaryCompactButtonText}>
                        {completeLoading ? 'Completing...' : 'Complete Order'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}

              <View style={styles.stageSection}>
                <Text style={styles.stageSectionLabel}>Move Order To</Text>
                <View style={styles.stageButtons}>
                  {STAGES.map((stage) => {
                    const isCurrentStage = selectedOrder.stage === stage
                    return (
                      <TouchableOpacity
                        key={stage}
                        style={[
                          styles.stageButton,
                          isCurrentStage && styles.currentStageButton,
                        ]}
                        onPress={() => handleStagePress(selectedOrder, stage)}
                      >
                        <Text
                          style={[
                            styles.stageButtonText,
                            isCurrentStage && styles.currentStageButtonText,
                          ]}
                        >
                          {isCurrentStage ? `Current: ${stage}` : stage}
                        </Text>
                      </TouchableOpacity>
                    )
                  })}
                </View>
              </View>
            </ScrollView>
            <BottomTabBar />
          </View>
        </KeyboardAvoidingView>
      </ScreenContainer>
    )
  }

  const TABLE_COLS = [
    { label: 'PO', flex: 1.2 },
    { label: 'Description', flex: 2.5 },
    { label: 'Style', flex: 1.2 },
    { label: 'Colour', flex: 1.2 },
    { label: 'Qty', flex: 0.7 },
    { label: 'Ex Factory', flex: 1.2 },
    { label: 'Stage', flex: 1.2 },
    { label: 'Notes', flex: 2 },
    { label: 'Docket', flex: 0.8 },
  ]

  const listHeader = (
    <View>
      <View style={[styles.heroTopRow, isCompact && styles.stackRow]}>
        <View style={styles.heroTextBlock}>
          <Text style={styles.heroEyebrow}>Production Pipeline</Text>
          <Text style={styles.heroTitle}>Order Management</Text>
          {!isDesktop && (
            <Text style={styles.heroSubtitle}>
              Track active purchase orders, update stages, and keep production
              notes aligned across the floor.
            </Text>
          )}
        </View>
        <View style={styles.headerActions}>
          {isDesktop && (
            <TouchableOpacity style={styles.printButton} onPress={handlePrint}>
              <MaterialIcons name="print" size={16} color={colors.primaryDeep} />
              <Text style={styles.printButtonText}>Print Sheet</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.signOutButton, isCompact && styles.compactButtonAlign]}
            onPress={signOut}
          >
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.rolePill}>
        <MaterialIcons name="badge" size={16} color={colors.primaryDeep} />
        <Text style={styles.rolePillText}>{role ? `Role: ${role}` : 'Factory user'}</Text>
      </View>

      <View style={[styles.metricsRow, isCompact && styles.stackRow]}>
        <MetricCard label="Active Orders" value={activeOrders.length} />
        <MetricCard label="Ready To Ship" value={readyCount} tone="success" />
        <MetricCard label="Completed" value={completedOrders.length} />
      </View>

      <View style={styles.searchShell}>
        <MaterialIcons name="search" size={20} color={colors.textSoft} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search PO, SKU, description, colour, notes..."
          placeholderTextColor={colors.textSoft}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      <View style={[styles.tabsRow, isNarrow && styles.stackRow]}>
        <TouchableOpacity
          style={[styles.tabButton, selectedTab === 'active' && styles.tabButtonActive]}
          onPress={() => setSelectedTab('active')}
        >
          <Text style={[styles.tabButtonText, selectedTab === 'active' && styles.tabButtonTextActive]}>
            Active ({activeOrders.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, selectedTab === 'completed' && styles.tabButtonActive]}
          onPress={() => setSelectedTab('completed')}
        >
          <Text style={[styles.tabButtonText, selectedTab === 'completed' && styles.tabButtonTextActive]}>
            Completed ({completedOrders.length})
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  )

  const emptyComponent = (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>
        {searchQuery.trim() ? 'No matching orders' : 'No orders to show'}
      </Text>
      <Text style={styles.emptySubtitle}>
        {searchQuery.trim()
          ? 'Try a different search term or clear the current filter.'
          : selectedTab === 'active'
            ? 'There are no active orders in the pipeline right now.'
            : 'No completed orders have been recorded yet.'}
      </Text>
    </View>
  )

  if (isDesktop) {
    return (
      <ScreenContainer>
        <ScrollView
          contentContainerStyle={styles.desktopContent}
          showsVerticalScrollIndicator={false}
        >
          {listHeader}

          <View style={styles.tableWrapper}>
            <View style={styles.tableHeaderRow}>
              {TABLE_COLS.map((col) => (
                <Text key={col.label} style={[styles.tableHeaderCell, { flex: col.flex }]}>
                  {col.label}
                </Text>
              ))}
            </View>

            {filteredOrders.length === 0 ? emptyComponent : filteredOrders.map((item, index) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.tableRow, index % 2 === 1 && styles.tableRowAlt]}
                onPress={() => openOrder(item)}
                activeOpacity={0.7}
              >
                <Text style={[styles.tableCell, styles.tableCellBold, { flex: TABLE_COLS[0].flex }]} numberOfLines={1}>
                  {item.po || '-'}
                </Text>
                <Text style={[styles.tableCell, { flex: TABLE_COLS[1].flex }]} numberOfLines={2}>
                  {item.description || item.style || '-'}
                </Text>
                <Text style={[styles.tableCell, { flex: TABLE_COLS[2].flex }]} numberOfLines={1}>
                  {item.style_no || item.style || '-'}
                </Text>
                <Text style={[styles.tableCell, { flex: TABLE_COLS[3].flex }]} numberOfLines={1}>
                  {item.colour || '-'}
                </Text>
                <Text style={[styles.tableCell, { flex: TABLE_COLS[4].flex }]} numberOfLines={1}>
                  {item.qty ?? '-'}
                </Text>
                <Text style={[styles.tableCell, { flex: TABLE_COLS[5].flex }]} numberOfLines={1}>
                  {item.ex_factory || '-'}
                </Text>
                <View style={[{ flex: TABLE_COLS[6].flex }, styles.tableCellCenter]}>
                  <View style={[styles.stagePill, { backgroundColor: stageColor(item.stage) }]}>
                    <Text style={styles.stagePillText}>{item.stage || '-'}</Text>
                  </View>
                </View>
                <Text style={[styles.tableCell, styles.tableCellMuted, { flex: TABLE_COLS[7].flex }]} numberOfLines={2}>
                  {item.notes || '—'}
                </Text>
                <View style={[{ flex: TABLE_COLS[8].flex }, styles.tableCellCenter]}>
                  {item.docket_url ? (
                    <TouchableOpacity
                      style={styles.docketButton}
                      onPress={() => openDocket(item.docket_url)}
                    >
                      <Text style={styles.docketButtonText}>Open</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.tableCellMuted}>—</Text>
                  )}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </ScreenContainer>
    )
  }

  return (
    <ScreenContainer>
      <View style={styles.screen}>
        <FlatList
          ref={listRef}
          data={filteredOrders}
          renderItem={renderOrderCard}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          onScroll={(event) => {
            scrollOffsetRef.current = event.nativeEvent.contentOffset.y
          }}
          scrollEventThrottle={16}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={emptyComponent}
        />
        <BottomTabBar />
      </View>
    </ScreenContainer>
  )
}

const styles = StyleSheet.create({
  keyboardFlex: {
    flex: 1,
  },
  screen: {
    flex: 1,
  },
  stackRow: {
    flexDirection: 'column',
  },
  fullWidthCard: {
    minWidth: '100%',
  },
  compactButtonAlign: {
    alignSelf: 'flex-start',
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  listContent: {
    paddingBottom: spacing.md,
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  heroTextBlock: {
    flex: 1,
  },
  heroEyebrow: {
    ...typography.eyebrow,
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  heroTitle: {
    ...typography.hero,
    color: colors.primaryDeep,
    marginBottom: spacing.sm,
  },
  heroSubtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    maxWidth: 520,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  printButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  printButtonText: {
    color: colors.primaryDeep,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  signOutButton: {
    backgroundColor: colors.primaryDeep,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  signOutText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  rolePill: {
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.primaryTint,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
  },
  rolePillText: {
    ...typography.eyebrow,
    color: colors.primaryDeep,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  metricCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  metricCardSuccess: {
    backgroundColor: colors.successTint,
  },
  metricLabel: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  metricValue: {
    ...typography.kpi,
    color: colors.text,
  },
  searchShell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  searchInput: {
    flex: 1,
    minHeight: 56,
    fontSize: 15,
    color: colors.text,
  },
  tabsRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  tabButton: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 999,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  tabButtonText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    color: colors.text,
    textTransform: 'uppercase',
  },
  tabButtonTextActive: {
    color: '#FFFFFF',
  },
  orderCard: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  orderAccent: {
    width: 5,
  },
  orderCardBody: {
    flex: 1,
    padding: spacing.lg,
  },
  orderCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  orderMetaBlock: {
    flex: 1,
  },
  orderEyebrow: {
    ...typography.eyebrow,
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  orderTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    color: colors.text,
  },
  orderInfoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  orderInfoItem: {
    minWidth: '46%',
  },
  orderInfoLabel: {
    ...typography.eyebrow,
    color: colors.textSoft,
    marginBottom: spacing.xs,
  },
  orderInfoValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  noteBanner: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  noteBannerText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
  },
  orderCardFooter: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  secondaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  secondaryActionText: {
    ...typography.eyebrow,
    color: colors.primary,
  },
  packingListAction: {
    backgroundColor: colors.primaryTint,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
  },
  packingListActionText: {
    ...typography.eyebrow,
    color: colors.primaryDeep,
  },
  emptyState: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  emptySubtitle: {
    maxWidth: 320,
    textAlign: 'center',
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
  },
  detailScrollContent: {
    paddingBottom: spacing.md,
  },
  backButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  backButtonText: {
    ...typography.eyebrow,
    color: colors.primary,
  },
  detailHero: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.xl,
    padding: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  detailHeroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  detailHeroTextBlock: {
    flex: 1,
  },
  detailEyebrow: {
    ...typography.eyebrow,
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  detailTitle: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '900',
    color: colors.text,
  },
  detailMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  detailMetaCard: {
    minWidth: '46%',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  detailMetaLabel: {
    ...typography.eyebrow,
    color: colors.textSoft,
    marginBottom: spacing.xs,
  },
  detailMetaValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  detailImageWrapper: {
    width: '100%',
    marginTop: spacing.lg,
    position: 'relative',
  },
  detailImage: {
    width: '100%',
    height: 260,
    borderRadius: radius.lg,
  },
  imageUploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.primaryDeep,
  },
  imageUploadButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primaryDeep,
  },
  detailPanel: {
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  detailPanelTitle: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  detailDescription: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
  },
  inlineMetaRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  inlineMetaItem: {
    flex: 1,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  inlineMetaLabel: {
    ...typography.eyebrow,
    color: colors.textSoft,
    marginBottom: spacing.xs,
  },
  inlineMetaValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  primaryActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  lightActionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryTint,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  lightActionText: {
    color: colors.primaryDeep,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  formCard: {
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  formCardTitle: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  formCardSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  singleLineInput: {
    minHeight: 56,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
  formActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  primaryCompactButton: {
    backgroundColor: colors.primaryDeep,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryCompactButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  notesInput: {
    minHeight: 150,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  stageSection: {
    marginTop: spacing.xl,
  },
  stageSectionLabel: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  stageButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  stageButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  currentStageButton: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  stageButtonText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    color: colors.text,
    textTransform: 'uppercase',
  },
  currentStageButtonText: {
    color: '#FFFFFF',
  },
  desktopContent: {
    paddingBottom: spacing.xl,
  },
  tableWrapper: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
    marginTop: spacing.md,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: colors.primaryDeep,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  tableHeaderCell: {
    fontSize: 11,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.sm,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  tableRowAlt: {
    backgroundColor: colors.surfaceMuted,
  },
  tableCell: {
    fontSize: 14,
    color: colors.text,
    paddingHorizontal: spacing.sm,
  },
  tableCellBold: {
    fontWeight: '700',
  },
  tableCellMuted: {
    color: colors.textMuted,
    fontSize: 13,
  },
  tableCellCenter: {
    paddingHorizontal: spacing.sm,
    alignItems: 'flex-start',
  },
  stagePill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  stagePillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  docketButton: {
    backgroundColor: colors.primaryTint,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  docketButtonText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.primaryDeep,
    letterSpacing: 0.5,
  },
})
