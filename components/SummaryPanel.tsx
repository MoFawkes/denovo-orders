import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { MaterialIcons } from '@expo/vector-icons'
import { colors, spacing, radius, typography } from '../theme/tokens'

type Props = {
  output: string
  target: string
  progressText: string
}

export default function SummaryPanel({
  output,
  target,
  progressText,
}: Props) {
  return (
    <View style={styles.panel}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.label}>Efficiency Analytics</Text>
          <Text style={styles.subheading}>
            Snapshot of current throughput against today&apos;s plan.
          </Text>
        </View>
        <View style={styles.livePill}>
          <MaterialIcons name="graphic-eq" size={16} color={colors.success} />
          <Text style={styles.liveText}>Live</Text>
        </View>
      </View>

      <View style={styles.grid}>
        <View style={styles.metricBlock}>
          <Text style={styles.metaLabel}>Live Output</Text>
          <Text style={styles.output}>{output}</Text>
        </View>
        <View style={styles.metricBlock}>
          <Text style={styles.metaLabel}>Target Yield</Text>
          <Text style={styles.metaValue}>{target}</Text>
        </View>
        <View style={styles.metricBlock}>
          <Text style={styles.metaLabel}>Progress</Text>
          <Text style={styles.progressText}>{progressText}</Text>
        </View>
        <View style={styles.metricBlock}>
          <Text style={styles.metaLabel}>Quality Score</Text>
          <Text style={styles.metaValue}>A+</Text>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.xl,
    padding: spacing.xxl,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  label: {
    ...typography.title,
    color: colors.text,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  subheading: {
    marginTop: spacing.xs,
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 260,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.successTint,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
  },
  liveText: {
    ...typography.eyebrow,
    color: colors.success,
  },
  output: {
    ...typography.kpi,
    color: colors.text,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
    marginTop: spacing.md,
  },
  metricBlock: {
    minWidth: '45%',
  },
  metaLabel: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  metaValue: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
  },
  progressText: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.primary,
  },
})
