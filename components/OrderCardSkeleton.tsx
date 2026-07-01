import { useEffect, useRef } from 'react'
import { Animated, View, StyleSheet } from 'react-native'
import { colors, radius, spacing } from '../theme/tokens'

function ShimmerBlock({ style }: { style?: any }) {
  const opacity = useRef(new Animated.Value(0.4)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 650, useNativeDriver: true }),
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [opacity])

  return <Animated.View style={[styles.block, style, { opacity }]} />
}

export default function OrderCardSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.accent} />
      <View style={styles.body}>
        <View style={styles.topRow}>
          <View style={styles.metaBlock}>
            <ShimmerBlock style={styles.eyebrow} />
            <ShimmerBlock style={styles.title} />
          </View>
          <ShimmerBlock style={styles.chip} />
        </View>

        <View style={styles.infoGrid}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.infoItem}>
              <ShimmerBlock style={styles.infoLabel} />
              <ShimmerBlock style={styles.infoValue} />
            </View>
          ))}
        </View>
      </View>
    </View>
  )
}

export function OrderListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <View>
      {Array.from({ length: count }).map((_, i) => (
        <OrderCardSkeleton key={i} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.borderSubtle,
    borderRadius: radius.md,
  },
  card: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  accent: {
    width: 5,
    backgroundColor: colors.borderSubtle,
  },
  body: {
    flex: 1,
    padding: spacing.lg,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  metaBlock: {
    flex: 1,
    gap: spacing.sm,
  },
  eyebrow: {
    width: 80,
    height: 12,
  },
  title: {
    width: '70%',
    height: 22,
  },
  chip: {
    width: 90,
    height: 24,
    borderRadius: 999,
  },
  infoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  infoItem: {
    minWidth: '46%',
    gap: spacing.xs,
  },
  infoLabel: {
    width: 60,
    height: 10,
  },
  infoValue: {
    width: '80%',
    height: 16,
  },
})
