import React, { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

type Props = {
  visible: boolean
  loading?: boolean
  onClose: () => void
  onConfirm: (packingListUrl: string) => void
}

function normaliseUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }

  return `https://${trimmed}`
}

function isValidUrl(value: string) {
  try {
    const url = new URL(value)
    return !!url.protocol && !!url.host
  } catch {
    return false
  }
}

export default function CompleteOrderModal({
  visible,
  loading = false,
  onClose,
  onConfirm,
}: Props) {
  const [packingListUrl, setPackingListUrl] = useState('')

  useEffect(() => {
    if (!visible) {
      setPackingListUrl('')
    }
  }, [visible])

  const normalised = useMemo(() => normaliseUrl(packingListUrl), [packingListUrl])
  const valid = useMemo(() => isValidUrl(normalised), [normalised])

  const handleConfirm = () => {
    if (!valid || loading) return
    onConfirm(normalised)
  }

  if (!visible) return null

  return (
    <View style={styles.wrapper}>
      <View style={styles.card}>
        <Text style={styles.title}>Complete Order</Text>
        <Text style={styles.subtitle}>
          Add the packing list link before marking this order as completed.
        </Text>

        <TextInput
          value={packingListUrl}
          onChangeText={setPackingListUrl}
          placeholder="Paste packing list link"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={styles.input}
          editable={!loading}
        />

        {!!packingListUrl && !valid && (
          <Text style={styles.errorText}>Please enter a valid URL.</Text>
        )}

        <View style={styles.actions}>
          <Pressable
            onPress={onClose}
            style={[styles.button, styles.cancelButton]}
            disabled={loading}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>

          <Pressable
            onPress={handleConfirm}
            style={[
              styles.button,
              styles.confirmButton,
              (!valid || loading) && styles.disabledButton,
            ]}
            disabled={!valid || loading}
          >
            {loading ? <ActivityIndicator /> : <Text style={styles.confirmText}>Complete</Text>}
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    marginTop: 20,
  },
  card: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 16,
    color: '#555',
  },
  input: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: '#D0D0D0',
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 16,
    backgroundColor: '#FAFAFA',
  },
  errorText: {
    marginTop: 10,
    color: '#C62828',
    fontSize: 14,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 20,
  },
  button: {
    minHeight: 52,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 120,
  },
  cancelButton: {
    backgroundColor: '#ECECEC',
  },
  confirmButton: {
    backgroundColor: '#111',
  },
  disabledButton: {
    opacity: 0.5,
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
  },
  confirmText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
})