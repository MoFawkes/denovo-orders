import { Component, type ReactNode } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { MaterialIcons } from '@expo/vector-icons'

type Props = {
  children: ReactNode
  fallbackMessage?: string
}

type State = {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.'
    return { hasError: true, message }
  }

  componentDidCatch(error: unknown, info: { componentStack: string }) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  reset = () => {
    this.setState({ hasError: false, message: '' })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <View style={styles.container}>
        <MaterialIcons name="error-outline" size={48} color="#BA1A1A" />
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.message}>
          {this.props.fallbackMessage ?? this.state.message}
        </Text>
        <TouchableOpacity style={styles.button} onPress={this.reset}>
          <Text style={styles.buttonText}>Try again</Text>
        </TouchableOpacity>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#F4FAFF',
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111D23',
    textAlign: 'center',
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    color: '#5F6B76',
    textAlign: 'center',
    maxWidth: 320,
  },
  button: {
    marginTop: 8,
    backgroundColor: '#005EB8',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
})
