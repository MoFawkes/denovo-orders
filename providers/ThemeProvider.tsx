import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useColorScheme } from 'react-native'
import * as SecureStore from 'expo-secure-store'

type ThemePreference = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

type ThemeColors = {
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
  background: '#ffffff',
  card: '#f4f6f8',
  cardSoft: '#fafafa',
  input: '#ffffff',
  border: '#dcdfe4',
  text: '#111111',
  textMuted: '#666666',
  primary: '#111111',
  primaryText: '#ffffff',
  chipText: '#ffffff',
  blackButton: '#111111',
  blackButtonText: '#ffffff',
  danger: '#e74c3c',
}

const darkColors: ThemeColors = {
  background: '#0f1115',
  card: '#1a1f29',
  cardSoft: '#141922',
  input: '#10151d',
  border: '#2a3140',
  text: '#ffffff',
  textMuted: '#a0a8b8',
  primary: '#2563eb',
  primaryText: '#ffffff',
  chipText: '#ffffff',
  blackButton: '#1f2937',
  blackButtonText: '#ffffff',
  danger: '#ef4444',
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
      console.log('Failed to load theme preference:', error)
    }
  }

  async function setPreference(value: ThemePreference) {
    try {
      setPreferenceState(value)
      await SecureStore.setItemAsync(STORAGE_KEY, value)
    } catch (error) {
      console.log('Failed to save theme preference:', error)
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