import { useEffect } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Stack, usePathname, useRouter } from 'expo-router'
import { ThemeProvider, useAppTheme } from '../providers/ThemeProvider'
import { AuthProvider, useAuth } from '../providers/AuthProvider'

function RootNavigator() {
  const { theme } = useAppTheme()
  const { session, loading } = useAuth()
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (loading) return

    const onLoginScreen = pathname === '/login'

    if (!session && !onLoginScreen) {
      router.replace('/login')
      return
    }

    if (session && onLoginScreen) {
      router.replace('/')
    }
  }, [loading, pathname, router, session])

  if (loading) {
    return (
      <View
        style={[
          styles.loadingScreen,
          { backgroundColor: theme === 'dark' ? '#0f1115' : '#ffffff' },
        ]}
      >
        <ActivityIndicator size="large" color={theme === 'dark' ? '#60a5fa' : '#005EB8'} />
      </View>
    )
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: theme === 'dark' ? '#0f1115' : '#ffffff',
        },
      }}
    />
  )
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <RootNavigator />
      </ThemeProvider>
    </AuthProvider>
  )
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
