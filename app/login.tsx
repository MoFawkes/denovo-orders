import { useEffect, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native'
import { router } from 'expo-router'
import { MaterialIcons } from '@expo/vector-icons'
import { supabase } from '../lib/supabase'
import { colors, radius, spacing, typography } from '../theme/tokens'

export default function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const { width } = useWindowDimensions()
  const isCompact = width < 520
  const isShort = width < 420

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

  async function handleLogin() {
    if (!email.trim() || !password) {
      Alert.alert('Missing details', 'Please enter your email and password.')
      return
    }

    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    setLoading(false)

    if (error) {
      Alert.alert('Login failed', error.message)
      return
    }

    router.replace('/main-menu')
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="always"
      >
        <View style={[styles.shell, !isCompact && styles.shellConstrained]}>
          {!keyboardVisible && (
            <View style={[styles.brandBlock, isShort && styles.brandBlockCompact]}>
            <View style={styles.brandBadge}>
              <MaterialIcons name="precision-manufacturing" size={24} color="#FFFFFF" />
            </View>
            <Text style={styles.eyebrow}>DeNovo Sourcing</Text>
            <Text style={[styles.title, isCompact && styles.titleCompact]}>
              Factory access for live production control.
            </Text>
            <Text style={styles.subtitle}>
              Sign in to manage orders, track movement through the pipeline, and
              keep floor updates synchronized in real time.
            </Text>

            <View style={styles.featureList}>
              <View style={styles.featureRow}>
                <MaterialIcons name="inventory-2" size={18} color={colors.primary} />
                <Text style={styles.featureText}>Track active and completed orders</Text>
              </View>
              <View style={styles.featureRow}>
                <MaterialIcons name="route" size={18} color={colors.primary} />
                <Text style={styles.featureText}>Update production stages quickly</Text>
              </View>
              <View style={styles.featureRow}>
                <MaterialIcons name="sticky-note-2" size={18} color={colors.primary} />
                <Text style={styles.featureText}>Share notes across the team instantly</Text>
              </View>
            </View>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardEyebrow}>Secure Sign In</Text>
            <Text style={styles.cardTitle}>Access the factory dashboard</Text>
            <Text style={styles.cardSubtitle}>
              Use your company credentials to continue.
            </Text>

            <View style={styles.inputShell}>
              <MaterialIcons name="mail-outline" size={18} color={colors.textSoft} />
              <TextInput
                style={styles.input}
                placeholder="Email"
                placeholderTextColor={colors.textSoft}
                selectionColor={colors.primary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
              />
            </View>

            <View style={styles.inputShell}>
              <MaterialIcons name="lock-outline" size={18} color={colors.textSoft} />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor={colors.textSoft}
                selectionColor={colors.primary}
                secureTextEntry
                value={password}
                onChangeText={setPassword}
              />
            </View>

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleLogin}
              disabled={loading}
            >
              <Text style={styles.buttonText}>
                {loading ? 'Signing In...' : 'Sign In'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  shell: {
    gap: spacing.lg,
  },
  shellConstrained: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 720,
  },
  brandBlock: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.xl,
    padding: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  brandBlockCompact: {
    padding: spacing.xl,
  },
  brandBadge: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: colors.primaryDeep,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.hero,
    color: colors.primaryDeep,
    marginBottom: spacing.md,
  },
  titleCompact: {
    fontSize: 34,
    lineHeight: 36,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
  },
  featureList: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  featureText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
    fontWeight: '600',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  cardEyebrow: {
    ...typography.eyebrow,
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  cardTitle: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  cardSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
    marginBottom: spacing.xl,
  },
  inputShell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  input: {
    flex: 1,
    minHeight: 56,
    color: colors.text,
    fontSize: 15,
  },
  button: {
    marginTop: spacing.sm,
    backgroundColor: colors.primaryDeep,
    borderRadius: 999,
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
})
