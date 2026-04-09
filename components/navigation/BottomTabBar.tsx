import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Keyboard } from 'react-native'
import { router, usePathname } from 'expo-router'
import { MaterialIcons } from '@expo/vector-icons'
import { colors, spacing, typography } from '../../theme/tokens'

export const BOTTOM_TAB_BAR_HEIGHT = 88

const TABS = [
  { label: 'Dashboard', icon: 'dashboard', route: '/' },
  { label: 'OPO', icon: 'inventory-2', route: '/opo' },
  { label: 'Settings', icon: 'settings', route: '/settings' },
] as const

export default function BottomTabBar() {
  const pathname = usePathname()
  const [keyboardVisible, setKeyboardVisible] = useState(false)

  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true)
    })
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false)
    })

    return () => {
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [])

  if (keyboardVisible) return null

  return (
    <View style={styles.wrapper}>
      {TABS.map((tab) => {
        const active =
          tab.route === '/'
            ? pathname === '/'
            : pathname === tab.route || pathname.startsWith(`${tab.route}?`)

        return (
          <TouchableOpacity
            key={tab.route}
            style={[styles.tab, active && styles.activeTab]}
            onPress={() => router.replace(tab.route)}
          >
            <MaterialIcons
              name={tab.icon}
              size={20}
              color={active ? '#FFFFFF' : colors.primaryDeep}
            />
            <Text style={[styles.label, active && styles.activeLabel]}>{tab.label}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.background,
    minHeight: BOTTOM_TAB_BAR_HEIGHT,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    borderRadius: 18,
    backgroundColor: colors.surfaceMuted,
  },
  activeTab: {
    backgroundColor: colors.primary,
  },
  label: {
    ...typography.eyebrow,
    color: colors.primaryDeep,
    fontSize: 10,
  },
  activeLabel: {
    color: '#FFFFFF',
  },
})
