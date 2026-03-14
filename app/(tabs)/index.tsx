import { useEffect, useMemo, useState } from 'react'
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
} from 'react-native'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../providers/AuthProvider'

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
  updated_by?: string | null
}

const STAGES = ['Cutting', 'Production', 'Packing', 'Ready', 'Completed'] as const
type Stage = (typeof STAGES)[number]
type TabType = 'active' | 'completed'

export default function IndexScreen() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [selectedTab, setSelectedTab] = useState<TabType>('active')
  const [searchQuery, setSearchQuery] = useState('')
  const [orderNotes, setOrderNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

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
          console.log('Realtime change:', payload)

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
      .subscribe((status) => {
        console.log('Realtime status:', status)
      })

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

  function sortOrders(a: Order, b: Order) {
    const aPo = a.po || ''
    const bPo = b.po || ''

    return aPo.localeCompare(bPo, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  }

  const activeOrders = useMemo(() => {
    return orders.filter((order) => order.stage !== 'Completed')
  }, [orders])

  const completedOrders = useMemo(() => {
    return orders.filter((order) => order.stage === 'Completed')
  }, [orders])

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

  function openOrder(order: Order) {
    setSelectedOrder(order)
    setOrderNotes(order.notes ?? '')
  }

  async function updateStage(order: Order, newStage: Stage) {
    const previousOrders = [...orders]
    const previousStage = order.stage

    const optimisticOrder: Order = {
      ...order,
      stage: newStage,
      updated_by: user?.id ?? null,
    }

    setOrders((prev) =>
      prev
        .map((item) => (item.id === order.id ? optimisticOrder : item))
        .sort(sortOrders)
    )

    setSelectedOrder(optimisticOrder)

    const { error } = await supabase
      .from('orders')
      .update({
        stage: newStage,
        updated_by: user?.id ?? null,
      })
      .eq('id', order.id)

    if (error) {
      console.log('Update stage error:', error)
      setOrders(previousOrders)
      setSelectedOrder(order)
      Alert.alert('Error', 'Could not update stage.')
      return
    }

    await supabase.from('order_events').insert({
      order_id: order.id,
      old_stage: previousStage,
      new_stage: newStage,
      changed_by: user?.id ?? null,
    })

    if (newStage === 'Completed') {
      setSelectedOrder(null)
      setSelectedTab('active')
      setOrderNotes('')
      Alert.alert('Success', 'Order moved to Completed Orders.')
    }
  }

  function handleStagePress(order: Order, newStage: Stage) {
    if (order.stage === newStage) return

    if (newStage === 'Completed') {
      Alert.alert(
        'Mark order as completed?',
        'This will move the order to Completed Orders.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Confirm',
            onPress: () => updateStage(order, newStage),
          },
        ]
      )
      return
    }

    updateStage(order, newStage)
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

  function stageColor(stage: string | null): string {
    switch (stage) {
      case 'Cutting':
        return '#e74c3c'
      case 'Production':
        return '#f39c12'
      case 'Packing':
        return '#3498db'
      case 'Ready':
        return '#2ecc71'
      case 'Completed':
        return '#27ae60'
      default:
        return '#7f8c8d'
    }
  }

  async function openDocket(url: string | null) {
    if (!url) {
      Alert.alert('No docket linked', 'This order does not have a docket URL yet.')
      return
    }

    const supported = await Linking.canOpenURL(url)
    if (!supported) {
      Alert.alert('Invalid link', 'This docket URL cannot be opened.')
      return
    }

    await Linking.openURL(url)
  }

  function renderChip({ item }: { item: Order }) {
    return (
      <TouchableOpacity
        style={[styles.chip, { backgroundColor: stageColor(item.stage) }]}
        onPress={() => openOrder(item)}
      >
        <Text style={styles.chipText}>PO {item.po || '-'}</Text>
        <Text style={styles.chipSub}>
          {item.style || '-'} • {item.colour || '-'}
        </Text>
        <Text style={styles.chipSub}>Qty {item.qty ?? '-'}</Text>
        <Text style={styles.chipSub}>{item.stage || 'No Stage'}</Text>

        {!!item.notes?.trim() && (
          <Text style={styles.chipNote} numberOfLines={2}>
            Note: {item.notes}
          </Text>
        )}
      </TouchableOpacity>
    )
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (selectedOrder) {
    const notesChanged = orderNotes.trim() !== (selectedOrder.notes ?? '').trim()

    return (
      <ScrollView contentContainerStyle={styles.detailScrollContent}>
        <View style={styles.container}>
          <TouchableOpacity onPress={() => setSelectedOrder(null)}>
            <Text style={styles.back}>← Back</Text>
          </TouchableOpacity>

          <Text style={styles.title}>PO {selectedOrder.po || '-'}</Text>

          <Text style={styles.detail}>SKU: {selectedOrder.style || '-'}</Text>
          <Text style={styles.detail}>Style No: {selectedOrder.style_no || '-'}</Text>
          <Text style={styles.detail}>Colour: {selectedOrder.colour || '-'}</Text>
          <Text style={styles.detail}>Qty: {selectedOrder.qty ?? '-'}</Text>
          <Text style={styles.detail}>Fabric: {selectedOrder.fabric || '-'}</Text>
          <Text style={styles.detail}>Ex Factory: {selectedOrder.ex_factory || '-'}</Text>
          <Text style={styles.detail}>Stage: {selectedOrder.stage || '-'}</Text>
          <Text style={styles.detail}>
            {selectedOrder.description || 'No description'}
          </Text>

          <TouchableOpacity
            style={styles.docket}
            onPress={() => openDocket(selectedOrder.docket_url)}
          >
            <Text style={styles.docketText}>
              Open Docket {selectedOrder.docket ? `#${selectedOrder.docket}` : ''}
            </Text>
          </TouchableOpacity>

          <View style={styles.notesCard}>
            <Text style={styles.notesTitle}>Order Notes</Text>
            <Text style={styles.notesSubtitle}>
              Shared across all devices. Example: fabric ordered, trims pending,
              urgent packing, missing labels.
            </Text>

            <TextInput
              style={styles.notesInput}
              multiline
              value={orderNotes}
              onChangeText={setOrderNotes}
              placeholder="Write notes here..."
              placeholderTextColor="#999"
              textAlignVertical="top"
            />

            <TouchableOpacity
              style={[
                styles.saveNotesButton,
                (!notesChanged || savingNotes) && styles.saveNotesButtonDisabled,
              ]}
              onPress={saveOrderNotes}
              disabled={!notesChanged || savingNotes}
            >
              <Text style={styles.saveNotesButtonText}>
                {savingNotes ? 'Saving...' : 'Save Notes'}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.stageButtons}>
            {STAGES.map((stage) => {
              const isCurrentStage = selectedOrder.stage === stage

              return (
                <TouchableOpacity
                  key={stage}
                  style={[
                    styles.stageButton,
                    { backgroundColor: stageColor(stage) },
                    isCurrentStage && styles.currentStageButton,
                  ]}
                  onPress={() => handleStagePress(selectedOrder, stage)}
                >
                  <Text style={styles.stageText}>
                    {isCurrentStage ? `✓ ${stage}` : stage}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>
        </View>
      </ScrollView>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.title}>Denovo Orders</Text>
          <Text style={styles.roleText}>{role ? `Role: ${role}` : ''}</Text>
        </View>

        <TouchableOpacity style={styles.logoutButton} onPress={signOut}>
          <Text style={styles.logoutText}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.dashboardRow}>
        <View style={styles.dashboardCard}>
          <Text style={styles.dashboardNumber}>{activeOrders.length}</Text>
          <Text style={styles.dashboardLabel}>Active</Text>
        </View>

        <View style={styles.dashboardCard}>
          <Text style={styles.dashboardNumber}>{completedOrders.length}</Text>
          <Text style={styles.dashboardLabel}>Completed</Text>
        </View>
      </View>

      <View style={styles.tabs}>
        <TouchableOpacity
          style={[
            styles.tabButton,
            selectedTab === 'active' && styles.tabButtonActive,
          ]}
          onPress={() => setSelectedTab('active')}
        >
          <Text
            style={[
              styles.tabButtonText,
              selectedTab === 'active' && styles.tabButtonTextActive,
            ]}
          >
            Active ({activeOrders.length})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tabButton,
            selectedTab === 'completed' && styles.tabButtonActive,
          ]}
          onPress={() => setSelectedTab('completed')}
        >
          <Text
            style={[
              styles.tabButtonText,
              selectedTab === 'completed' && styles.tabButtonTextActive,
            ]}
          >
            Completed ({completedOrders.length})
          </Text>
        </TouchableOpacity>
      </View>

      <TextInput
        style={styles.searchInput}
        placeholder="Search PO, SKU, colour, fabric, notes..."
        value={searchQuery}
        onChangeText={setSearchQuery}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />

      <FlatList
        data={filteredOrders}
        renderItem={renderChip}
        keyExtractor={(item) => item.id}
        numColumns={1}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {searchQuery.trim()
              ? 'No matching orders found.'
              : selectedTab === 'active'
                ? 'No active orders.'
                : 'No completed orders.'}
          </Text>
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 50,
    paddingBottom: 20,
    backgroundColor: '#fff',
  },
  detailScrollContent: {
    paddingBottom: 30,
    backgroundColor: '#fff',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#111',
  },
  roleText: {
    color: '#666',
    marginTop: 4,
    fontSize: 15,
  },
  logoutButton: {
    backgroundColor: '#111',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
  },
  logoutText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  dashboardRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 18,
  },
  dashboardCard: {
    flex: 1,
    backgroundColor: '#f4f6f8',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  dashboardNumber: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#111',
  },
  dashboardLabel: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  tabs: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 12,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#ecf0f1',
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: '#111',
  },
  tabButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  tabButtonTextActive: {
    color: '#fff',
  },
  searchInput: {
    borderWidth: 1,
    borderColor: '#dcdfe4',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 16,
    fontSize: 15,
    backgroundColor: '#fafafa',
  },
  listContent: {
    paddingBottom: 30,
  },
  chip: {
    padding: 18,
    borderRadius: 14,
    marginBottom: 12,
    minHeight: 130,
    justifyContent: 'center',
  },
  chipText: {
    color: 'white',
    fontWeight: 'bold',
    marginBottom: 6,
    fontSize: 18,
  },
  chipSub: {
    color: 'white',
    fontSize: 14,
    marginBottom: 4,
  },
  chipNote: {
    color: 'white',
    fontSize: 13,
    marginTop: 8,
    opacity: 0.95,
  },
  back: {
    marginBottom: 20,
    color: '#3498db',
    fontSize: 18,
    fontWeight: '600',
  },
  detail: {
    fontSize: 17,
    marginBottom: 8,
    color: '#222',
  },
  docket: {
    marginTop: 22,
    backgroundColor: '#000',
    padding: 14,
    borderRadius: 10,
  },
  docketText: {
    color: 'white',
    textAlign: 'center',
    fontWeight: 'bold',
    fontSize: 15,
  },
  notesCard: {
    marginTop: 24,
    backgroundColor: '#f4f6f8',
    borderRadius: 14,
    padding: 16,
  },
  notesTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
    marginBottom: 6,
  },
  notesSubtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 12,
    lineHeight: 20,
  },
  notesInput: {
    minHeight: 130,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dcdfe4',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 15,
    color: '#111',
    marginBottom: 12,
  },
  saveNotesButton: {
    backgroundColor: '#111',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveNotesButtonDisabled: {
    opacity: 0.5,
  },
  saveNotesButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  stageButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 28,
    gap: 10,
  },
  stageButton: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    minWidth: 120,
  },
  currentStageButton: {
    borderWidth: 2,
    borderColor: '#111',
  },
  stageText: {
    color: 'white',
    textAlign: 'center',
    fontWeight: 'bold',
    fontSize: 15,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 40,
    color: '#7f8c8d',
    fontSize: 16,
  },
})