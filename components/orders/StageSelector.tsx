// The stage grid in the OPO detail panel. Which pills are tappable is
// role-driven: managers/admins can move to any stage, packers only forward
// through the production sequence (canPackerAdvanceTo — the real boundary
// is the DB trigger; this mirrors it for the UI). Read-only roles see the
// current stage highlighted with nothing tappable.
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { STAGES, canPackerAdvanceTo, type Stage } from '../../lib/order-workflow'
import { colors, spacing, typography } from '../../theme/tokens'

type Props = {
  currentStage: string | null
  canEdit: boolean
  canAdvanceStage: boolean
  onStagePress: (stage: Stage) => void
}

export default function StageSelector({
  currentStage,
  canEdit,
  canAdvanceStage,
  onStagePress,
}: Props) {
  if (!canAdvanceStage) {
    return (
      <View style={styles.stageSection}>
        <Text style={styles.stageSectionLabel}>Current Stage</Text>
        <View style={styles.stageButtons}>
          {STAGES.map((stage) => {
            const isCurrentStage = currentStage === stage
            return (
              <View
                key={stage}
                style={[styles.stageButton, isCurrentStage && styles.currentStageButton]}
              >
                <Text
                  style={[
                    styles.stageButtonText,
                    isCurrentStage && styles.currentStageButtonText,
                  ]}
                >
                  {isCurrentStage ? `Current: ${stage}` : stage}
                </Text>
              </View>
            )
          })}
        </View>
      </View>
    )
  }

  return (
    <View style={styles.stageSection}>
      <Text style={styles.stageSectionLabel}>Move Order To</Text>
      <View style={styles.stageButtons}>
        {STAGES.map((stage) => {
          const isCurrentStage = currentStage === stage
          const isTappable = canEdit || canPackerAdvanceTo(currentStage, stage)

          if (!isTappable) {
            return (
              <View
                key={stage}
                style={[
                  styles.stageButton,
                  isCurrentStage && styles.currentStageButton,
                  styles.stageButtonDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.stageButtonText,
                    isCurrentStage && styles.currentStageButtonText,
                  ]}
                >
                  {isCurrentStage ? `Current: ${stage}` : stage}
                </Text>
              </View>
            )
          }

          return (
            <TouchableOpacity
              key={stage}
              style={[styles.stageButton, isCurrentStage && styles.currentStageButton]}
              onPress={() => onStagePress(stage)}
            >
              <Text
                style={[
                  styles.stageButtonText,
                  isCurrentStage && styles.currentStageButtonText,
                ]}
              >
                {isCurrentStage ? `Current: ${stage}` : stage}
              </Text>
            </TouchableOpacity>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  stageSection: {
    marginTop: spacing.xl,
  },
  stageSectionLabel: {
    ...typography.eyebrow,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  stageButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  stageButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  currentStageButton: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  stageButtonDisabled: {
    opacity: 0.4,
  },
  stageButtonText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    color: colors.text,
    textTransform: 'uppercase',
  },
  currentStageButtonText: {
    color: '#FFFFFF',
  },
})
