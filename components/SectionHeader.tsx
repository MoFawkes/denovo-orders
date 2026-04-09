import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { colors, spacing, typography } from '../theme/tokens'

type Props = {
  title: string
  actionText?: string
  onPress?: () => void
}

export default function SectionHeader({
  title,
  actionText,
  onPress,
}: Props) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>

      {actionText && (
        <TouchableOpacity onPress={onPress}>
          <Text style={styles.action}>{actionText}</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  title: {
    ...typography.eyebrow,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  action: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
})
