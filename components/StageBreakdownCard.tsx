import { StyleSheet, Text, View } from 'react-native'
import { getStageAccent, STAGES, type Order } from '../lib/order-workflow'
import { colors, radius, spacing, typography } from '../theme/tokens'

const ACTIVE_STAGES = STAGES.filter((stage) => stage !== 'Completed')

export default function StageBreakdownCard({ orders }: { orders: Order[] }) {
  const total = orders.length

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Stage Breakdown</Text>
      <Text style={styles.subtitle}>Active orders across the production pipeline.</Text>
      {ACTIVE_STAGES.map((stage) => {
        const count = orders.filter((order) => order.stage === stage).length
        return (
          <View key={stage} style={styles.row}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>{stage}</Text>
              <Text style={styles.count}>{count}</Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.bar, { width: `${total ? (count / total) * 100 : 0}%`, backgroundColor: getStageAccent(stage) }]} />
            </View>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { marginTop: spacing.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, padding: spacing.xl },
  title: { ...typography.title, color: colors.text },
  subtitle: { marginTop: spacing.xs, marginBottom: spacing.md, fontSize: 14, color: colors.textMuted },
  row: { marginTop: spacing.md },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xs },
  label: { fontSize: 14, fontWeight: '700', color: colors.text },
  count: { fontSize: 14, fontWeight: '800', color: colors.textMuted },
  track: { height: 5, overflow: 'hidden', borderRadius: 3, backgroundColor: colors.surfaceStrong },
  bar: { height: '100%', borderRadius: 3 },
})
