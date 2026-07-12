import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { getStageAccent, type Order } from '../lib/order-workflow'
import { colors, radius, spacing } from '../theme/tokens'

export default function DueOrderRow({ order, days, onPress }: { order: Order; days: number; onPress: () => void }) {
  const timing = days < 0 ? `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}` : days === 0 ? 'Due today' : `${days} day${days === 1 ? '' : 's'} left`
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.8}>
      <View style={[styles.stageMark, { backgroundColor: getStageAccent(order.stage) }]} />
      <View style={styles.body}>
        <Text style={styles.po}>PO {order.po || '-'}</Text>
        <Text numberOfLines={1} style={styles.title}>{order.description || order.style || 'Untitled order'}</Text>
      </View>
      <View style={styles.dateSlot}>
        <Text style={styles.date}>{order.ex_factory}</Text>
        <Text style={[styles.timing, days < 0 && styles.overdue]}>{timing}</Text>
      </View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  stageMark: { width: 4, alignSelf: 'stretch', borderRadius: 2, marginRight: spacing.md },
  body: { flex: 1, marginRight: spacing.md },
  po: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: colors.primary },
  title: { marginTop: 3, fontSize: 14, fontWeight: '700', color: colors.text },
  dateSlot: { minWidth: 104, alignItems: 'flex-end' },
  date: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  timing: { marginTop: 3, fontSize: 12, fontWeight: '700', color: colors.success },
  overdue: { color: colors.danger },
})
