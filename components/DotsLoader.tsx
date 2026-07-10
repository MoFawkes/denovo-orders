import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import { colors } from '../theme/tokens'

const DOT_SIZE = 7
const DOTS = [0, 1, 2, 3]
const STAGGER = 120 // ms between each dot
const DURATION = 500

export default function DotsLoader() {
  const anims = useRef(DOTS.map(() => new Animated.Value(0))).current

  useEffect(() => {
    const animations = DOTS.map((_, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * STAGGER),
          Animated.timing(anims[i], {
            toValue: 1,
            duration: DURATION,
            useNativeDriver: true,
          }),
          Animated.timing(anims[i], {
            toValue: 0,
            duration: DURATION,
            useNativeDriver: true,
          }),
          Animated.delay((DOTS.length - 1 - i) * STAGGER),
        ])
      )
    )
    Animated.parallel(animations).start()
    return () => animations.forEach((a) => a.stop())
  }, [anims])

  return (
    <View style={styles.row}>
      {DOTS.map((_, i) => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            {
              transform: [
                {
                  translateY: anims[i].interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -10],
                  }),
                },
              ],
              opacity: anims[i].interpolate({
                inputRange: [0, 0.5, 1],
                outputRange: [0.3, 1, 0.3],
              }),
            },
          ]}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: colors.primary,
  },
})
