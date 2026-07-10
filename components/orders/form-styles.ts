// Shared card/form styling for the OPO detail-panel cards, moved verbatim
// out of app/opo.tsx when the cards were extracted.
import { StyleSheet } from 'react-native'
import { colors, radius, spacing, typography } from '../../theme/tokens'

export const formStyles = StyleSheet.create({
  formCard: {
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  formCardTitle: {
    ...typography.title,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  formCardSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  singleLineInput: {
    minHeight: 56,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
  formActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  lightActionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primaryTint,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  lightActionText: {
    color: colors.primaryDeep,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  primaryCompactButton: {
    backgroundColor: colors.primaryDeep,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryCompactButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
})
