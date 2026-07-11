import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useColorScheme } from 'react-native'
import * as SecureStore from 'expo-secure-store'

type ThemePreference = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

type ThemeColors = {
  // Core tokens (nav, shared surfaces)
  background: string
  card: string
  cardSoft: string
  input: string
  border: string
  text: string
  textMuted: string
  primary: string
  primaryText: string
  chipText: string
  blackButton: string
  blackButtonText: string
  danger: string
  // Extended tokens (opo, settings)
  surface: string
  surfaceMuted: string
  surfaceStrong: string
  textSoft: string
  primaryDeep: string
  primaryTint: string
  success: string
  successTint: string
  warning: string
  warningTint: string
  info: string
  infoTint: string
  dangerTint: string
  borderSubtle: string
  borderStrong: string
}

type ThemeContextValue = {
  preference: ThemePreference
  setPreference: (value: ThemePreference) => Promise<void>
  theme: ResolvedTheme
  colors: ThemeColors
  isDark: boolean
}

const STORAGE_KEY = 'app_theme_preference'

const lightColors: ThemeColors = {
  background: '#F4FAFF',
  card: '#f4f6f8',
  cardSoft: '#fafafa',
  input: '#ffffff',
  border: '#dcdfe4',
  text: '#111D23',
  textMuted: '#5F6B76',
  textSoft: '#7B8794',
  primary: '#005EB8',
  primaryText: '#ffffff',
  primaryDeep: '#00478D',
  primaryTint: '#D6E3FF',
  chipText: '#ffffff',
  blackButton: '#111111',
  blackButtonText: '#ffffff',
  surface: '#FFFFFF',
  surfaceMuted: '#E9F6FD',
  surfaceStrong: '#DDEAF2',
  success: '#1B6D24',
  successTint: '#DDF6D9',
  warning: '#B86C00',
  warningTint: '#FFE7CF',
  danger: '#BA1A1A',
  dangerTint: '#FFDAD6',
  info: '#0F7A9A',
  infoTint: '#D9F3FB',
  borderSubtle: '#D7E4EC',
  borderStrong: '#C2D4E0',
}

const darkColors: ThemeColors = {
  background: '#0f1115',
  card: '#1a1f29',
  cardSoft: '#141922',
  input: '#10151d',
  border: '#2a3140',
  text: '#E8EDF2',
  textMuted: '#a0a8b8',
  textSoft: '#7B8794',
  primary: '#4D9FE8',
  primaryText: '#ffffff',
  primaryDeep: '#90C4F8',
  primaryTint: '#0D2A44',
  chipText: '#ffffff',
  blackButton: '#1f2937',
  blackButtonText: '#ffffff',
  surface: '#1a1f29',
  surfaceMuted: '#141922',
  surfaceStrong: '#222836',
  success: '#4CAF72',
  successTint: '#0D2A17',
  warning: '#F0A030',
  warningTint: '#2A1800',
  danger: '#ef4444',
  dangerTint: '#2A0A0A',
  info: '#38BCD8',
  infoTint: '#052030',
  borderSubtle: '#2a3140',
  borderStrong: '#3a4560',
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme()
  const [preference, setPreferenceState] = useState<ThemePreference>('system')

  useEffect(() => {
    loadPreference()
  }, [])

  async function loadPreference() {
    try {
      const stored = await SecureStore.getItemAsync(STORAGE_KEY)
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        setPreferenceState(stored)
      }
    } catch (error) {
      console.error('[ThemeProvider] load preference:', error)
    }
  }

  async function setPreference(value: ThemePreference) {
    try {
      setPreferenceState(value)
      await SecureStore.setItemAsync(STORAGE_KEY, value)
    } catch (error) {
      console.error('[ThemeProvider] save preference:', error)
    }
  }

  const theme: ResolvedTheme =
    preference === 'system'
      ? systemScheme === 'dark'
        ? 'dark'
        : 'light'
      : preference

  const colors = theme === 'dark' ? darkColors : lightColors

  const value = useMemo(
    () => ({
      preference,
      setPreference,
      theme,
      colors,
      isDark: theme === 'dark',
    }),
    [preference, theme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useAppTheme() {
  const context = useContext(ThemeContext)

  if (!context) {
    throw new Error('useAppTheme must be used inside ThemeProvider')
  }

  return context
}
