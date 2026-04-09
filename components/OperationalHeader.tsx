import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/tokens'

type Props = {
  title?: string
  label?: string
  meta?: string
  badge?: string
}

export default function OperationalHeader({
  title = 'FACTORY DASHBOARD',
  label = 'OPERATIONAL OVERVIEW',
  meta = 'Production pipeline and live floor visibility',
  badge = 'DeNovo Sourcing',
}: Props) {
  return (
    <View style={styles.wrapper}>
      <View style={styles.topRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      </View>

      <Text style={styles.label}>{label}</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.metaText}>{meta}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: spacing.xl,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  badge: {
    backgroundColor: colors.primaryTint,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  badgeText: {
    ...typography.eyebrow,
    color: colors.primaryDeep,
  },
  label: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.hero,
    color: colors.primaryDeep,
    marginBottom: spacing.sm,
  },
  metaText: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    maxWidth: 520,
  },
})
