import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import ScreenContainer from '../components/layout/ScreenContainer'
import OperationalHeader from '../components/OperationalHeader'
import KpiCard from '../components/KpiCard'
import SectionHeader from '../components/SectionHeader'
import OrderRow from '../components/OrderRow'
import SummaryPanel from '../components/SummaryPanel'
import BottomTabBar from '../components/navigation/BottomTabBar'
import { supabase } from '../lib/supabase'
import type { Order } from '../lib/types'
import { colors, spacing, typography } from '../theme/tokens'

function getStageRank(stage: Order['stage']) {
  switch (stage) {
    case 'Ready':
      return 1
    case 'Packing':
      return 2
    case 'Production':
      return 3
    case 'Cutting':
      return 4
    case 'Pending':
      return 5
    case 'Completed':
      return 6
    case 'Cancelled':
      return 7
    default:
      return 5
  }
}

export default function IndexScreen() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadOrders()
  }, [])

  async function loadOrders() {
    setLoading(true)

    const { data, error } = await supabase.from('orders').select('*')

    if (error) {
      console.log('Load dashboard orders error:', error)
      setOrders([])
    } else {
      setOrders(((data as Order[]) || []).sort((a, b) => getStageRank(a.stage) - getStageRank(b.stage)))
    }

    setLoading(false)
  }

  const activeOrders = useMemo(
    () => orders.filter((order) => order.stage !== 'Completed' && order.stage !== 'Cancelled'),
    [orders]
  )

  const completedOrders = useMemo(
    () => orders.filter((order) => order.stage === 'Completed'),
    [orders]
  )

  const recentOrders = useMemo(() => activeOrders.slice(0, 3), [activeOrders])

  const inProgressCount = useMemo(
    () =>
      activeOrders.filter(
        (order) => order.stage === 'Cutting' || order.stage === 'Production'
      ).length,
    [activeOrders]
  )

  const totalUnits = useMemo(
    () =>
      activeOrders.reduce((sum, order) => sum + Number(order.qty || 0), 0),
    [activeOrders]
  )

  return (
    <ScreenContainer>
      <View style={styles.screen}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
        >
          <OperationalHeader />

        <View style={styles.kpiGrid}>
          <KpiCard
            label="Active Orders"
            value={activeOrders.length}
            subtext="Orders currently moving through the production pipeline"
            accentColor="#005EB8"
            tone="primary"
          />
          <KpiCard
            label="In Progress"
            value={inProgressCount}
            subtext="Orders currently in cutting or production"
            accentColor="#1B6D24"
            tone="success"
          />
          <KpiCard
            label="Completed"
            value={completedOrders.length}
            subtext="Orders already finished and moved out of the active queue"
            accentColor="#B86C00"
            tone="warning"
          />
        </View>

        <SectionHeader
          title="Recent Active Orders"
          actionText="View All Orders"
          onPress={() => router.push('/opo')}
        />

        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : recentOrders.length ? (
          recentOrders.map((order) => (
            <OrderRow
              key={order.id}
              orderId={`#${order.po || order.id.slice(0, 6)}`}
              title={order.description || order.style || 'Untitled order'}
              status={(order.stage?.toUpperCase() as
                | 'CUTTING'
                | 'PRODUCTION'
                | 'PACKING'
                | 'READY'
                | 'COMPLETED') || 'PRODUCTION'}
              qty={order.qty ?? '-'}
              onPress={() =>
                router.push({
                  pathname: '/opo',
                  params: { orderId: order.id },
                })
              }
            />
          ))
        ) : (
          <Text style={styles.emptyState}>No active orders found.</Text>
        )}

          <SectionHeader title="Production Summary" />
          <SummaryPanel
            output={totalUnits.toLocaleString()}
            target={Math.max(totalUnits, 1).toLocaleString()}
            progressText={`${activeOrders.length} active orders`}
          />
        </ScrollView>
        <BottomTabBar />
      </View>
    </ScreenContainer>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    paddingBottom: spacing.md,
  },
  kpiGrid: {
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  loadingState: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  emptyState: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
})
