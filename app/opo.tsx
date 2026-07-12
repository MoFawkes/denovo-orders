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
  RefreshControl,
  Image,
  useWindowDimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { MaterialIcons } from '@expo/vector-icons'
import { OrderListSkeleton } from '../components/OrderCardSkeleton'
import ColourSwatch from '../components/ColourSwatch'
import ScreenContainer from '../components/layout/ScreenContainer'
import StatusChip from '../components/StatusChip'
import BottomTabBar from '../components/navigation/BottomTabBar'
import { persistStageChange, persistOrderFields, uploadOrderImage } from '../lib/order-mutations'
import {
  CANCELLED,
  isValidUrl,
  normaliseUrl,
  sortOrders,
  stageColor,
  toChipStatus,
  type Order,
  type OrderStatus,
  type OrderTab as TabType,
  type Stage,
} from '../lib/order-workflow'
import { useAuth } from '../providers/AuthProvider'
import { useOrders } from '../hooks/use-orders'
import CompleteOrderPrompt from '../components/orders/CompleteOrderPrompt'
import MetricCard from '../components/orders/MetricCard'
import OrderCard from '../components/orders/OrderCard'
import OrderNotesCard from '../components/orders/OrderNotesCard'
import PackingListLinkCard from '../components/orders/PackingListLinkCard'
import StageSelector from '../components/orders/StageSelector'
import OrderTimeline from '../components/orders/OrderTimeline'
import { useOrderEvents } from '../hooks/use-order-events'
import { colors, radius, spacing, typography } from '../theme/tokens'

// Persists search and tab state across navigation (component remounts)
let _savedSearchQuery = ''
let _savedTab: TabType = 'active'

export default function OpoScreen() {
  const [packingListEditValue, setPackingListEditValue] = useState('')
  const [savingPackingList, setSavingPackingList] = useState(false)
  const [showCompletePrompt, setShowCompletePrompt] = useState(false)
  const [packingListInput, setPackingListInput] = useState('')
  const [completeLoading, setCompleteLoading] = useState(false)
  const [pendingCompleteOrderId, setPendingCompleteOrderId] = useState<string | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [selectedTab, setSelectedTab] = useState<TabType>(_savedTab)
  const [searchQuery, setSearchQuery] = useState(_savedSearchQuery)
  const [orderNotes, setOrderNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const { orders, setOrders, loading, refreshing, loadOrders } = useOrders({
    onUpdate(updatedOrder) {
      setSelectedOrder((previous) => {
        if (!previous || previous.id !== updatedOrder.id) return previous
        setOrderNotes(updatedOrder.notes ?? '')
        setPackingListEditValue(updatedOrder.packing_list_url ?? '')
        return updatedOrder
      })
    },
    onDelete(deletedOrder) {
      setSelectedOrder((previous) => previous?.id === deletedOrder.id ? null : previous)
    },
  })
  const { events: orderEvents, loading: eventsLoading, reload: reloadOrderEvents } = useOrderEvents(selectedOrder?.id ?? null)

  function updateSearchQuery(q: string) {
    _savedSearchQuery = q
    setSearchQuery(q)
  }

  function updateSelectedTab(tab: TabType) {
    _savedTab = tab
    setSelectedTab(tab)
  }

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
  const canEdit = role === 'manager' || role === 'admin'
  const canAdvanceStage = canEdit || role === 'packer'

  const activeOrders = useMemo(
    () => orders.filter((order) => order.stage !== 'Completed' && order.stage !== 'Cancelled'),
    [orders]
  )

  const completedOrders = useMemo(
    () => orders.filter((order) => order.stage === 'Completed'),
    [orders]
  )

  const cancelledOrders = useMemo(
    () => orders.filter((order) => order.stage === 'Cancelled'),
    [orders]
  )

  const baseVisibleOrders =
    selectedTab === 'active'
      ? activeOrders
      : selectedTab === 'completed'
        ? completedOrders
        : cancelledOrders

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
        case 'Pending':    return 'background:#e5e7eb;color:#374151;border:1px solid #d1d5db;'
        case 'Cutting':    return 'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;'
        case 'Production': return 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;'
        case 'Packing':    return 'background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;'
        case 'Ready':      return 'background:#d1fae5;color:#065f46;border:1px solid #6ee7b7;'
        case 'Booked':     return 'background:#1e3a8a;color:#ffffff;border:1px solid #1e3a8a;'
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

  async function updateStage(order: Order, newStage: OrderStatus, packingListUrl?: string) {
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
      await persistStageChange({
        orderId: order.id,
        oldStage: previousStage,
        newStage,
        userId: user?.id ?? null,
        packingListUrl,
      })
      await reloadOrderEvents()

      if (newStage === 'Completed') {
        setSelectedOrder(null)
        updateSelectedTab('completed')
        setOrderNotes('')
        setShowCompletePrompt(false)
        setPendingCompleteOrderId(null)
        setPackingListInput('')
        Alert.alert('Success', 'Order moved to Completed Orders.')
      }

      if (newStage === CANCELLED) {
        setSelectedOrder(null)
        updateSelectedTab('cancelled')
        Alert.alert('Order Cancelled', 'The order has been moved to Cancelled Orders.')
      }
    } catch (error) {
      console.error('Update stage error:', error)
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

  function handleCancelOrder(order: Order) {
    Alert.alert(
      'Cancel Order',
      `Are you sure you want to cancel PO ${order.po || 'this order'}? This can be reversed later by moving it to another stage.`,
      [
        { text: 'Keep Order', style: 'cancel' },
        {
          text: 'Cancel Order',
          style: 'destructive',
          onPress: () => updateStage(order, CANCELLED),
        },
      ]
    )
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
      console.error('Complete order error:', error)
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

      await persistOrderFields(selectedOrder.id, { notes: trimmedNotes }, user?.id ?? null)

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
      console.error('Save notes error:', error)
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

      await persistOrderFields(selectedOrder.id, { packing_list_url: normalised }, user?.id ?? null)

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
      console.error('Save packing list error:', error)
      Alert.alert('Error', error?.message || 'Could not save packing list link.')
    } finally {
      setSavingPackingList(false)
    }
  }

  async function handleImageUpload(file: File) {
    if (!selectedOrder) return
    try {
      setUploadingImage(true)
      const publicUrl = await uploadOrderImage(selectedOrder.id, file, user?.id ?? null)

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
      console.error('Open docket error:', error)
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
      console.error('Open packing list error:', error)
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
    return <OrderCard order={item} onOpen={openOrder} onOpenPackingList={openPackingList} />
  }

  if (loading) {
    return (
      <ScreenContainer>
        <View style={styles.screen}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
          >
            <View style={styles.skeletonHeroTitle} />
            <View style={styles.skeletonMetricsRow}>
              <View style={styles.skeletonMetricCard} />
              <View style={styles.skeletonMetricCard} />
              <View style={styles.skeletonMetricCard} />
            </View>
            <View style={styles.skeletonSearchBar} />
            <OrderListSkeleton />
          </ScrollView>
          <BottomTabBar />
        </View>
      </ScreenContainer>
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
                    <View style={styles.colourValueRow}>
                      {!!selectedOrder.colour && <ColourSwatch colour={selectedOrder.colour} size={16} />}
                      <Text style={styles.detailMetaValue}>{selectedOrder.colour || '-'}</Text>
                    </View>
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
                {Platform.OS === 'web' && canEdit && (
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
                <PackingListLinkCard
                  canEdit={canEdit}
                  value={packingListEditValue}
                  onChangeValue={setPackingListEditValue}
                  saving={savingPackingList}
                  changed={packingListChanged}
                  currentUrl={selectedOrder.packing_list_url}
                  onOpen={() => openPackingList(selectedOrder.packing_list_url)}
                  onSave={savePackingListUrl}
                />
              ) : null}

              <OrderNotesCard
                canEdit={canEdit}
                value={orderNotes}
                onChangeValue={setOrderNotes}
                saving={savingNotes}
                changed={notesChanged}
                onSave={saveOrderNotes}
              />

              {canEdit && showCompletePrompt && pendingCompleteOrderId === selectedOrder.id ? (
                <CompleteOrderPrompt
                  value={packingListInput}
                  onChangeValue={setPackingListInput}
                  loading={completeLoading}
                  onCancel={() => {
                    if (completeLoading) return
                    setShowCompletePrompt(false)
                    setPendingCompleteOrderId(null)
                    setPackingListInput('')
                  }}
                  onConfirm={handleConfirmCompleteInline}
                />
              ) : null}

              <StageSelector
                currentStage={selectedOrder.stage}
                canEdit={canEdit}
                canAdvanceStage={canAdvanceStage}
                onStagePress={(stage) => handleStagePress(selectedOrder, stage)}
              />

              <OrderTimeline events={orderEvents} loading={eventsLoading} />

              {canEdit &&
              selectedOrder.stage !== 'Completed' &&
              selectedOrder.stage !== 'Cancelled' ? (
                <TouchableOpacity
                  style={styles.cancelOrderButton}
                  onPress={() => handleCancelOrder(selectedOrder)}
                >
                  <MaterialIcons name="cancel" size={16} color={colors.danger} />
                  <Text style={styles.cancelOrderButtonText}>Cancel Order</Text>
                </TouchableOpacity>
              ) : null}
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
          onChangeText={updateSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      <View style={[styles.tabsRow, isNarrow && styles.stackRow]}>
        <TouchableOpacity
          style={[styles.tabButton, selectedTab === 'active' && styles.tabButtonActive]}
          onPress={() => updateSelectedTab('active')}
        >
          <Text style={[styles.tabButtonText, selectedTab === 'active' && styles.tabButtonTextActive]}>
            Active ({activeOrders.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, selectedTab === 'completed' && styles.tabButtonActive]}
          onPress={() => updateSelectedTab('completed')}
        >
          <Text style={[styles.tabButtonText, selectedTab === 'completed' && styles.tabButtonTextActive]}>
            Completed ({completedOrders.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, selectedTab === 'cancelled' && styles.tabButtonActive]}
          onPress={() => updateSelectedTab('cancelled')}
        >
          <Text style={[styles.tabButtonText, selectedTab === 'cancelled' && styles.tabButtonTextActive]}>
            Cancelled ({cancelledOrders.length})
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
            : selectedTab === 'completed'
              ? 'No completed orders have been recorded yet.'
              : 'No cancelled orders on record.'}
      </Text>
    </View>
  )

  if (isDesktop) {
    return (
      <ScreenContainer>
        <ScrollView
          contentContainerStyle={styles.desktopContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadOrders(true)}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
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
                <View style={[styles.colourValueRow, { flex: TABLE_COLS[3].flex }]}>
                  {!!item.colour && <ColourSwatch colour={item.colour} size={12} />}
                  <Text style={styles.tableCell} numberOfLines={1}>
                    {item.colour || '-'}
                  </Text>
                </View>
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
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadOrders(true)}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
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
  cancelOrderButton: {
    marginTop: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 999,
    paddingVertical: spacing.md,
  },
  cancelOrderButtonText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  colourValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  skeletonHeroTitle: {
    width: '60%',
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.borderSubtle,
    marginBottom: spacing.xl,
  },
  skeletonMetricsRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  skeletonMetricCard: {
    flex: 1,
    height: 90,
    borderRadius: radius.lg,
    backgroundColor: colors.borderSubtle,
  },
  skeletonSearchBar: {
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.borderSubtle,
    marginBottom: spacing.xl,
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
