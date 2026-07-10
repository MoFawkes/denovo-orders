// The "Packing List Link" card shown on Completed orders in the OPO detail
// panel. Managers can edit and save the link; everyone can open it.
import { Text, TextInput, TouchableOpacity, View } from 'react-native'
import { colors } from '../../theme/tokens'
import { formStyles as styles } from './form-styles'

type Props = {
  canEdit: boolean
  value: string
  onChangeValue: (value: string) => void
  saving: boolean
  changed: boolean
  currentUrl: string | null
  onOpen: () => void
  onSave: () => void
}

export default function PackingListLinkCard({
  canEdit,
  value,
  onChangeValue,
  saving,
  changed,
  currentUrl,
  onOpen,
  onSave,
}: Props) {
  return (
    <View style={styles.formCard}>
      <Text style={styles.formCardTitle}>Packing List Link</Text>
      <Text style={styles.formCardSubtitle}>
        Keep the final packing link up to date for downstream teams.
      </Text>

      {canEdit ? (
        <TextInput
          style={styles.singleLineInput}
          value={value}
          onChangeText={onChangeValue}
          placeholder="Paste packing list link"
          placeholderTextColor={colors.textSoft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!saving}
        />
      ) : null}

      <View style={styles.formActionRow}>
        {!!currentUrl && (
          <TouchableOpacity style={styles.lightActionButton} onPress={onOpen}>
            <Text style={styles.lightActionText}>Open Link</Text>
          </TouchableOpacity>
        )}

        {canEdit && (
          <TouchableOpacity
            style={[
              styles.primaryCompactButton,
              (!changed || saving) && styles.buttonDisabled,
            ]}
            onPress={onSave}
            disabled={!changed || saving}
          >
            <Text style={styles.primaryCompactButtonText}>
              {saving ? 'Saving...' : 'Save Packing List'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  )
}
