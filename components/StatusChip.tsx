import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing } from '../theme/tokens'

type Status =
  | 'PENDING'
  | 'CUTTING'
  | 'PRODUCTION'
  | 'PACKING'
  | 'READY'
  | 'COMPLETED'
  | 'CANCELLED'

export default function StatusChip({ status }: { status: Status }) {
  const getTone = () => {
    switch (status) {
      case 'PENDING':
        return {
          backgroundColor: colors.surfaceStrong,
          textColor: colors.textMuted,
        }
      case 'CUTTING':
        return {
          backgroundColor: colors.infoTint,
          textColor: colors.info,
        }
      case 'PRODUCTION':
        return {
          backgroundColor: colors.warningTint,
          textColor: colors.warning,
        }
      case 'PACKING':
        return {
          backgroundColor: colors.primaryTint,
          textColor: colors.primaryDeep,
        }
      case 'READY':
        return {
          backgroundColor: colors.surfaceStrong,
          textColor: colors.primaryDeep,
        }
      case 'COMPLETED':
        return {
          backgroundColor: colors.successTint,
          textColor: colors.success,
        }
      case 'CANCELLED':
        return {
          backgroundColor: colors.dangerTint,
          textColor: colors.danger,
        }
      default:
        return {
          backgroundColor: colors.surfaceStrong,
          textColor: colors.textMuted,
        }
    }
  }

  const tone = getTone()

  return (
    <View style={[styles.chip, { backgroundColor: tone.backgroundColor }]}>
      <Text style={[styles.text, { color: tone.textColor }]}>{status}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
})
