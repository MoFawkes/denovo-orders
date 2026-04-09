import React from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  useWindowDimensions,
} from 'react-native'
import { router } from 'expo-router'
import { MaterialIcons } from '@expo/vector-icons'
import ScreenContainer from '../components/layout/ScreenContainer'
import BottomTabBar from '../components/navigation/BottomTabBar'
import { useAppTheme } from '../providers/ThemeProvider'
import { useAuth } from '../providers/AuthProvider'
import { colors, radius, spacing, typography } from '../theme/tokens'

export default function SettingsScreen() {
  const { preference, setPreference, theme } = useAppTheme()
  const { signOut, role, user } = useAuth()
  const { width } = useWindowDimensions()
  const isCompact = width < 640

  return (
    <ScreenContainer>
      <View style={styles.screen}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
        >
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialIcons name="arrow-back" size={18} color={colors.primary} />
          <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>

        <Text style={styles.eyebrow}>System Configuration</Text>
        <Text style={styles.title}>Factory Settings</Text>
        <Text style={styles.subtitle}>
          Manage appearance, profile context, and the core controls operators
          actually use.
        </Text>

        <View style={[styles.heroPanel, isCompact && styles.stackColumn]}>
          <View style={styles.heroCard}>
            <Text style={styles.heroLabel}>Interface Mode</Text>
            <Text style={styles.heroValue}>{theme}</Text>
          </View>
          <View style={[styles.heroCard, styles.heroCardAccent]}>
            <Text style={styles.heroLabel}>Active Role</Text>
            <Text style={styles.heroValue}>{role || 'No role loaded'}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Appearance</Text>
          <Text style={styles.cardSubtitle}>
            Choose how the app presents itself on this device.
          </Text>

          <View style={styles.optionGrid}>
            {(['light', 'dark', 'system'] as const).map((option) => {
              const active = preference === option

              return (
                <TouchableOpacity
                  key={option}
                  style={[
                    styles.optionCard,
                    active && styles.optionCardActive,
                  ]}
                  onPress={() => setPreference(option)}
                >
                  <MaterialIcons
                    name={
                      option === 'light'
                        ? 'light-mode'
                        : option === 'dark'
                          ? 'dark-mode'
                          : 'brightness-auto'
                    }
                    size={22}
                    color={active ? '#FFFFFF' : colors.primaryDeep}
                  />
                  <Text
                    style={[
                      styles.optionTitle,
                      active && styles.optionTitleActive,
                    ]}
                  >
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </Text>
                  <Text
                    style={[
                      styles.optionMeta,
                      active && styles.optionMetaActive,
                    ]}
                  >
                    {option === 'system'
                      ? 'Match device setting'
                      : option === 'dark'
                        ? 'Reduce glare on low light'
                        : 'Keep the bright factory palette'}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>

          <View style={styles.statusPill}>
            <MaterialIcons name="palette" size={16} color={colors.primaryDeep} />
            <Text style={styles.statusPillText}>Current theme: {theme}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Operational Profile</Text>
          <Text style={styles.cardSubtitle}>
            Quick reference for the signed-in user and current access level.
          </Text>

          <View style={styles.infoGrid}>
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>Role</Text>
              <Text style={styles.infoValue}>{role || 'No role assigned'}</Text>
            </View>
            <View style={styles.infoBlock}>
              <Text style={styles.infoLabel}>Email</Text>
              <Text style={styles.infoValue}>{user?.email || 'No email loaded'}</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.signOutButton} onPress={signOut}>
            <MaterialIcons name="logout" size={18} color="#FFFFFF" />
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Planned Utilities</Text>
            <Text style={styles.cardSubtitle}>
              These still make sense, but they are intentionally kept out of the
              way until we need them.
            </Text>

            <View style={styles.utilityList}>
              <View style={styles.utilityRow}>
                <MaterialIcons name="bedtime" size={18} color={colors.primary} />
                <Text style={styles.utilityText}>Keep screen awake during shifts</Text>
              </View>
              <View style={styles.utilityRow}>
                <MaterialIcons name="task-alt" size={18} color={colors.primary} />
                <Text style={styles.utilityText}>Extra confirmation before completion</Text>
              </View>
              <View style={styles.utilityRow}>
                <MaterialIcons name="format-size" size={18} color={colors.primary} />
                <Text style={styles.utilityText}>Larger text mode for factory floor use</Text>
              </View>
              <View style={styles.utilityRow}>
                <MaterialIcons name="info-outline" size={18} color={colors.primary} />
                <Text style={styles.utilityText}>App version and build diagnostics</Text>
              </View>
            </View>
          </View>
        </ScrollView>
        <BottomTabBar />
      </View>
    </ScreenContainer>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  stackColumn: {
    flexDirection: 'column',
  },
  content: {
    paddingBottom: spacing.md,
  },
  backButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  backText: {
    ...typography.eyebrow,
    color: colors.primary,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.hero,
    color: colors.primaryDeep,
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    marginBottom: spacing.xl,
    maxWidth: 560,
  },
  heroPanel: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  heroCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
  },
  heroCardAccent: {
    backgroundColor: colors.surfaceMuted,
  },
  heroLabel: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  heroValue: {
    ...typography.kpi,
    color: colors.text,
    textTransform: 'capitalize',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.xl,
    marginBottom: spacing.lg,
  },
  cardTitle: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  cardSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  optionGrid: {
    gap: spacing.md,
  },
  optionCard: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
  },
  optionCardActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  optionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  optionTitleActive: {
    color: '#FFFFFF',
  },
  optionMeta: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.textMuted,
  },
  optionMetaActive: {
    color: '#DCEBFF',
  },
  statusPill: {
    marginTop: spacing.lg,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primaryTint,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
  },
  statusPillText: {
    ...typography.eyebrow,
    color: colors.primaryDeep,
  },
  infoGrid: {
    gap: spacing.md,
  },
  infoBlock: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  infoLabel: {
    ...typography.eyebrow,
    color: colors.textSoft,
    marginBottom: spacing.xs,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  signOutButton: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primaryDeep,
    borderRadius: 999,
    paddingVertical: spacing.md,
  },
  signOutText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  utilityList: {
    gap: spacing.md,
  },
  utilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  utilityText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
    fontWeight: '600',
  },
})
