import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, typography, radius } from '../theme/tokens'

type Props = {
  label: string
  value: string | number
  subtext?: string
  accentColor?: string
  tone?: 'primary' | 'success' | 'warning'
}

export default function KpiCard({
  label,
  value,
  subtext,
  accentColor = colors.primary,
  tone = 'primary',
}: Props) {
  const backgroundColor =
    tone === 'success'
      ? colors.successTint
      : tone === 'warning'
        ? colors.warningTint
        : colors.surface

  return (
    <View style={[styles.card, { backgroundColor }]}>
      <View style={[styles.accent, { backgroundColor: accentColor }]} />

      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>

      {subtext && <Text style={styles.subtext}>{subtext}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    position: 'relative',
    minHeight: 132,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  accent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    borderTopLeftRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
  },
  label: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  value: {
    ...typography.kpi,
    color: colors.text,
  },
  subtext: {
    marginTop: spacing.sm,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
  },
})
