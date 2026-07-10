// The inline "Complete Order" card shown in the OPO detail panel when a
// manager taps the Completed stage: asks for the packing-list link before
// the move. Fully controlled — the screen owns the value so it can pre-fill
// the order's existing link and clear it on cancel/success.
import { Text, TextInput, TouchableOpacity, View } from 'react-native'
import { colors } from '../../theme/tokens'
import { formStyles as styles } from './form-styles'

type Props = {
  value: string
  onChangeValue: (value: string) => void
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
}

export default function CompleteOrderPrompt({
  value,
  onChangeValue,
  loading,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <View style={styles.formCard}>
      <Text style={styles.formCardTitle}>Complete Order</Text>
      <Text style={styles.formCardSubtitle}>
        Add the packing list before moving this order into completed.
      </Text>

      <TextInput
        style={styles.singleLineInput}
        value={value}
        onChangeText={onChangeValue}
        placeholder="Paste packing list link"
        placeholderTextColor={colors.textSoft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        editable={!loading}
      />

      <View style={styles.formActionRow}>
        <TouchableOpacity style={styles.lightActionButton} onPress={onCancel}>
          <Text style={styles.lightActionText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryCompactButton, loading && styles.buttonDisabled]}
          onPress={onConfirm}
          disabled={loading}
        >
          <Text style={styles.primaryCompactButtonText}>
            {loading ? 'Completing...' : 'Complete Order'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
