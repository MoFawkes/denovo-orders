import React, { useMemo } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import ScreenContainer from '../components/layout/ScreenContainer'
import OperationalHeader from '../components/OperationalHeader'
import KpiCard from '../components/KpiCard'
import SectionHeader from '../components/SectionHeader'
import OrderRow from '../components/OrderRow'
import StageBreakdownCard from '../components/StageBreakdownCard'
import DueOrderRow from '../components/DueOrderRow'
import BottomTabBar from '../components/navigation/BottomTabBar'
import { useOrders } from '../hooks/use-orders'
import { parseExFactory } from '../lib/order-workflow'
import { colors, spacing, typography } from '../theme/tokens'

export default function IndexScreen() {
  const { orders, loading } = useOrders()

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

  const dueOrders = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dayMs = 24 * 60 * 60 * 1000

    return activeOrders
      .map((order) => ({ order, timestamp: parseExFactory(order.ex_factory) }))
      .filter(({ timestamp }) => timestamp > 0)
      .map(({ order, timestamp }) => ({ order, timestamp, days: Math.round((timestamp - today.getTime()) / dayMs) }))
      .filter(({ days }) => days <= 7)
      .sort((a, b) => Number(b.order.stage === 'Booked') - Number(a.order.stage === 'Booked') || a.timestamp - b.timestamp)
      .slice(0, 5)
  }, [activeOrders])

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

        <StageBreakdownCard orders={activeOrders} />

        <SectionHeader
          title="Due Soon / Overdue"
          actionText="View All Orders"
          onPress={() => router.push('/opo')}
        />
        {dueOrders.length ? dueOrders.map(({ order, days }) => (
          <DueOrderRow
            key={order.id}
            order={order}
            days={days}
            onPress={() => router.push({ pathname: '/opo', params: { orderId: order.id } })}
          />
        )) : <Text style={styles.emptyState}>No orders due within seven days.</Text>}

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
