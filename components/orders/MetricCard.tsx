// KPI tile for the OPO list header (Active / Ready / Completed counts).
import { StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, typography } from '../../theme/tokens'

export default function MetricCard({
  label,
  value,
  tone = 'primary',
}: {
  label: string
  value: string | number
  tone?: 'primary' | 'success'
}) {
  return (
    <View style={[styles.metricCard, tone === 'success' ? styles.metricCardSuccess : null]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
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
})
