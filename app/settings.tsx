import React, { useMemo } from 'react'
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
import { radius, spacing, typography } from '../theme/tokens'

export default function SettingsScreen() {
  const { preference, setPreference, theme, colors } = useAppTheme()
  const { signOut, role, user } = useAuth()
  const { width } = useWindowDimensions()
  const isCompact = width < 640

  const s = useMemo(() => makeStyles(colors), [colors])

  return (
    <ScreenContainer>
      <View style={s.screen}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.content}
        >
          <TouchableOpacity onPress={() => router.back()} style={s.backButton}>
            <MaterialIcons name="arrow-back" size={18} color={colors.primary} />
            <Text style={s.backText}>Back</Text>
          </TouchableOpacity>

          <Text style={s.eyebrow}>System Configuration</Text>
          <Text style={s.title}>Factory Settings</Text>
          <Text style={s.subtitle}>
            Manage appearance, profile context, and the core controls operators
            actually use.
          </Text>

          <View style={[s.heroPanel, isCompact && s.stackColumn]}>
            <View style={s.heroCard}>
              <Text style={s.heroLabel}>Interface Mode</Text>
              <Text style={s.heroValue}>{theme}</Text>
            </View>
            <View style={[s.heroCard, s.heroCardAccent]}>
              <Text style={s.heroLabel}>Active Role</Text>
              <Text style={s.heroValue}>{role || 'No role loaded'}</Text>
            </View>
          </View>

          <View style={s.card}>
            <Text style={s.cardTitle}>Appearance</Text>
            <Text style={s.cardSubtitle}>
              Choose how the app presents itself on this device.
            </Text>

            <View style={s.optionGrid}>
              {(['light', 'dark', 'system'] as const).map((option) => {
                const active = preference === option

                return (
                  <TouchableOpacity
                    key={option}
                    style={[s.optionCard, active && s.optionCardActive]}
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
                      color={active ? '#FFFFFF' : colors.primary}
                    />
                    <Text style={[s.optionTitle, active && s.optionTitleActive]}>
                      {option.charAt(0).toUpperCase() + option.slice(1)}
                    </Text>
                    <Text style={[s.optionMeta, active && s.optionMetaActive]}>
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

            <View style={s.statusPill}>
              <MaterialIcons name="palette" size={16} color={colors.primary} />
              <Text style={s.statusPillText}>Current theme: {theme}</Text>
            </View>
          </View>

          <View style={s.card}>
            <Text style={s.cardTitle}>Operational Profile</Text>
            <Text style={s.cardSubtitle}>
              Quick reference for the signed-in user and current access level.
            </Text>

            <View style={s.infoGrid}>
              <View style={s.infoBlock}>
                <Text style={s.infoLabel}>Role</Text>
                <Text style={s.infoValue}>{role || 'No role assigned'}</Text>
              </View>
              <View style={s.infoBlock}>
                <Text style={s.infoLabel}>Email</Text>
                <Text style={s.infoValue}>{user?.email || 'No email loaded'}</Text>
              </View>
            </View>

            <TouchableOpacity style={s.signOutButton} onPress={signOut}>
              <MaterialIcons name="logout" size={18} color="#FFFFFF" />
              <Text style={s.signOutText}>Sign Out</Text>
            </TouchableOpacity>
          </View>

          <View style={s.card}>
            <Text style={s.cardTitle}>Planned Utilities</Text>
            <Text style={s.cardSubtitle}>
              These still make sense, but they are intentionally kept out of the
              way until we need them.
            </Text>

            <View style={s.utilityList}>
              {[
                { icon: 'bedtime', label: 'Keep screen awake during shifts' },
                { icon: 'task-alt', label: 'Extra confirmation before completion' },
                { icon: 'format-size', label: 'Larger text mode for factory floor use' },
                { icon: 'info-outline', label: 'App version and build diagnostics' },
              ].map(({ icon, label }) => (
                <View key={label} style={s.utilityRow}>
                  <MaterialIcons name={icon as any} size={18} color={colors.primary} />
                  <Text style={s.utilityText}>{label}</Text>
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
        <BottomTabBar />
      </View>
    </ScreenContainer>
  )
}

type AppColors = ReturnType<typeof useAppTheme>['colors']

function makeStyles(colors: AppColors) {
  return StyleSheet.create({
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
      color: '#FFFFFF',
      opacity: 0.8,
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
}
