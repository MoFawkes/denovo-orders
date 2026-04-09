import React from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { MaterialIcons } from '@expo/vector-icons'
import { colors, spacing, radius, typography } from '../theme/tokens'
import StatusChip from './StatusChip'

type Props = {
  orderId: string
  title: string
  qty: number | string
  status: 'CUTTING' | 'PRODUCTION' | 'PACKING' | 'READY' | 'COMPLETED'
  onPress?: () => void
}

export default function OrderRow({
  orderId,
  title,
  qty,
  status,
  onPress,
}: Props) {
  return (
    <TouchableOpacity activeOpacity={0.88} onPress={onPress} style={styles.row}>
      <View style={styles.leftAccent} />

      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.orderId}>{orderId}</Text>
          <StatusChip status={status} />
        </View>

        <Text style={styles.title}>{title}</Text>

        <View style={styles.footerRow}>
          <View>
            <Text style={styles.metaLabel}>Order Quantity</Text>
            <Text style={styles.qty}>{qty} units</Text>
          </View>

          <View style={styles.actionPill}>
            <Text style={styles.actionText}>View</Text>
            <MaterialIcons name="chevron-right" size={18} color={colors.primary} />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    flexDirection: 'row',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  leftAccent: {
    width: 5,
    backgroundColor: colors.primary,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  orderId: {
    ...typography.eyebrow,
    color: colors.primary,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
    lineHeight: 28,
  },
  metaLabel: {
    ...typography.eyebrow,
    color: colors.textSoft,
    marginBottom: spacing.xs,
  },
  qty: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  actionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
  },
  actionText: {
    ...typography.eyebrow,
    color: colors.primary,
  },
})
