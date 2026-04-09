import React from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native'
import { router } from 'expo-router'
import { useAppTheme } from '../providers/ThemeProvider'
import { useAuth } from '../providers/AuthProvider'

export default function MainMenuScreen() {
  const { colors } = useAppTheme()
  const { role, signOut } = useAuth()

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.title, { color: colors.text }]}>Denovo Orders</Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>
            {role ? `Role: ${role}` : 'Factory operations'}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.signOutButton, { backgroundColor: colors.blackButton }]}
          onPress={signOut}
        >
          <Text
            style={[styles.signOutButtonText, { color: colors.blackButtonText }]}
          >
            Sign Out
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.cards}>

        {/* OPO */}
        <TouchableOpacity
          style={[
            styles.card,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
          ]}
          onPress={() => router.push('/opo')}
        >
          <Text style={styles.cardEmoji}>📋</Text>
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            OPO
          </Text>
          <Text style={[styles.cardSubtitle, { color: colors.textMuted }]}>
            Orders Production Operations
          </Text>
        </TouchableOpacity>

        {/* Production Summary */}
        <TouchableOpacity
          style={[
            styles.card,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
          ]}
          onPress={() => router.push('/production-summary')}
        >
          <Text style={styles.cardEmoji}>📊</Text>
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Production Summary
          </Text>
          <Text style={[styles.cardSubtitle, { color: colors.textMuted }]}>
            Weekly production metrics
          </Text>
        </TouchableOpacity>

        {/* Settings */}
        <TouchableOpacity
          style={[
            styles.card,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
          ]}
          onPress={() => router.push('/settings')}
        >
          <Text style={styles.cardEmoji}>⚙️</Text>
          <Text style={[styles.cardTitle, { color: colors.text }]}>
            Settings
          </Text>
          <Text style={[styles.cardSubtitle, { color: colors.textMuted }]}>
            App preferences and device options
          </Text>
        </TouchableOpacity>

      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 40,
    paddingBottom: 24,
  },

  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 28,
  },

  title: {
    fontSize: 34,
    fontWeight: '700',
    marginBottom: 6,
  },

  subtitle: {
    fontSize: 16,
  },

  signOutButton: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 14,
  },

  signOutButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },

  cards: {
    gap: 18,
  },

  card: {
    minHeight: 160,
    borderRadius: 18,
    borderWidth: 1,
    padding: 24,
    justifyContent: 'center',
  },

  cardEmoji: {
    fontSize: 38,
    marginBottom: 10,
  },

  cardTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 10,
  },

  cardSubtitle: {
    fontSize: 18,
    lineHeight: 24,
  },
})
