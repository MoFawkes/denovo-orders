// The "Order Notes" card in the OPO detail panel: editable for
// managers/admins, read-only for packers (who cannot write notes — see the
// role rules in CLAUDE.md). Controlled by the screen so unsaved edits
// survive re-renders and the save button can track dirtiness.
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { colors, radius, spacing } from '../../theme/tokens'
import { formStyles } from './form-styles'

type Props = {
  canEdit: boolean
  value: string
  onChangeValue: (value: string) => void
  saving: boolean
  changed: boolean
  onSave: () => void
}

export default function OrderNotesCard({
  canEdit,
  value,
  onChangeValue,
  saving,
  changed,
  onSave,
}: Props) {
  return (
    <View style={formStyles.formCard}>
      <Text style={formStyles.formCardTitle}>Order Notes</Text>
      <Text style={formStyles.formCardSubtitle}>
        Shared updates for trims, fabric arrivals, urgency, or packing context.
      </Text>

      {canEdit ? (
        <>
          <TextInput
            style={styles.notesInput}
            multiline
            value={value}
            onChangeText={onChangeValue}
            placeholder="Write notes here..."
            placeholderTextColor={colors.textSoft}
            textAlignVertical="top"
          />

          <TouchableOpacity
            style={[
              formStyles.primaryCompactButton,
              (!changed || saving) && formStyles.buttonDisabled,
            ]}
            onPress={onSave}
            disabled={!changed || saving}
          >
            <Text style={formStyles.primaryCompactButtonText}>
              {saving ? 'Saving...' : 'Save Notes'}
            </Text>
          </TouchableOpacity>
        </>
      ) : (
        <View style={styles.readOnlyNotesBox}>
          <Text style={styles.readOnlyNotesText}>
            {value.trim() || 'No notes for this order.'}
          </Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  notesInput: {
    minHeight: 150,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
  readOnlyNotesBox: {
    minHeight: 80,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  readOnlyNotesText: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
  },
})
