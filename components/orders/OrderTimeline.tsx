import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { getStageAccent } from '../../lib/order-workflow'
import type { OrderEvent } from '../../hooks/use-order-events'
import { colors, spacing } from '../../theme/tokens'
import { formStyles } from './form-styles'

function eventAuthor(event: OrderEvent) {
  return event.profiles?.full_name?.trim() || event.profiles?.role?.trim() || 'Automation'
}

function formatTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function OrderTimeline({ events, loading }: { events: OrderEvent[]; loading: boolean }) {
  return (
    <View style={formStyles.formCard}>
      <Text style={formStyles.formCardTitle}>Activity</Text>
      <Text style={formStyles.formCardSubtitle}>Stage changes recorded for this order.</Text>

      {loading ? (
        <ActivityIndicator color={colors.primary} />
      ) : events.length ? (
        events.map((event, index) => (
          <View key={event.id} style={[styles.event, index < events.length - 1 && styles.eventBorder]}>
            <View style={[styles.dot, { backgroundColor: getStageAccent(event.new_stage) }]} />
            <View style={styles.eventBody}>
              <Text style={styles.changeText}>
                {event.old_stage || 'Created'} <Text style={styles.arrow}>→</Text> {event.new_stage || 'Updated'}
              </Text>
              <Text style={styles.metaText}>{formatTimestamp(event.created_at)} · {eventAuthor(event)}</Text>
            </View>
          </View>
        ))
      ) : (
        <Text style={styles.emptyText}>No activity recorded yet.</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  event: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.md },
  eventBorder: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  eventBody: { flex: 1 },
  changeText: { fontSize: 15, lineHeight: 20, fontWeight: '700', color: colors.text },
  arrow: { color: colors.textSoft },
  metaText: { marginTop: spacing.xs, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  emptyText: { fontSize: 14, color: colors.textMuted },
})
