// One order in the OPO mobile list: stage-accented card with the key facts,
// a notes banner, and quick actions.
import { MaterialIcons } from '@expo/vector-icons'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { getStageAccent, toChipStatus, type Order } from '../../lib/order-workflow'
import { colors, radius, spacing, typography } from '../../theme/tokens'
import ColourSwatch from '../ColourSwatch'
import StatusChip from '../StatusChip'

type Props = {
  order: Order
  onOpen: (order: Order) => void
  onOpenPackingList: (url: string | null) => void
}

export default function OrderCard({ order, onOpen, onOpenPackingList }: Props) {
  const accent = getStageAccent(order.stage)
  const hasPackingList = order.stage === 'Completed' && !!order.packing_list_url

  return (
    <TouchableOpacity activeOpacity={0.9} style={styles.orderCard} onPress={() => onOpen(order)}>
      <View style={[styles.orderAccent, { backgroundColor: accent }]} />

      <View style={styles.orderCardBody}>
        <View style={styles.orderCardTop}>
          <View style={styles.orderMetaBlock}>
            <Text style={styles.orderEyebrow}>PO {order.po || '-'}</Text>
            <Text style={styles.orderTitle}>
              {order.description || order.style || 'Untitled order'}
            </Text>
          </View>
          <StatusChip status={toChipStatus(order.stage)} />
        </View>

        <View style={styles.orderInfoGrid}>
          <View style={styles.orderInfoItem}>
            <Text style={styles.orderInfoLabel}>Style</Text>
            <Text style={styles.orderInfoValue}>{order.style_no || order.style || '-'}</Text>
          </View>
          <View style={styles.orderInfoItem}>
            <Text style={styles.orderInfoLabel}>Colour</Text>
            <View style={styles.colourValueRow}>
              {!!order.colour && <ColourSwatch colour={order.colour} />}
              <Text style={styles.orderInfoValue}>{order.colour || '-'}</Text>
            </View>
          </View>
          <View style={styles.orderInfoItem}>
            <Text style={styles.orderInfoLabel}>Quantity</Text>
            <Text style={styles.orderInfoValue}>{order.qty ?? '-'}</Text>
          </View>
          <View style={styles.orderInfoItem}>
            <Text style={styles.orderInfoLabel}>Ex Factory</Text>
            <Text style={styles.orderInfoValue}>{order.ex_factory || '-'}</Text>
          </View>
        </View>

        {!!order.notes?.trim() && (
          <View style={styles.noteBanner}>
            <MaterialIcons name="sticky-note-2" size={16} color={colors.primary} />
            <Text numberOfLines={2} style={styles.noteBannerText}>
              {order.notes}
            </Text>
          </View>
        )}

        <View style={styles.orderCardFooter}>
          <TouchableOpacity style={styles.secondaryAction} onPress={() => onOpen(order)}>
            <Text style={styles.secondaryActionText}>Open Details</Text>
            <MaterialIcons name="chevron-right" size={18} color={colors.primary} />
          </TouchableOpacity>

          {hasPackingList ? (
            <TouchableOpacity
              style={styles.packingListAction}
              onPress={() => onOpenPackingList(order.packing_list_url)}
            >
              <Text style={styles.packingListActionText}>Packing List</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  orderCard: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  orderAccent: {
    width: 5,
  },
  orderCardBody: {
    flex: 1,
    padding: spacing.lg,
  },
  orderCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  orderMetaBlock: {
    flex: 1,
  },
  orderEyebrow: {
    ...typography.eyebrow,
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  orderTitle: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    color: colors.text,
  },
  orderInfoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  orderInfoItem: {
    minWidth: '46%',
  },
  orderInfoLabel: {
    ...typography.eyebrow,
    color: colors.textSoft,
    marginBottom: spacing.xs,
  },
  orderInfoValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  colourValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  noteBanner: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  noteBannerText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
  },
  orderCardFooter: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  secondaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  secondaryActionText: {
    ...typography.eyebrow,
    color: colors.primary,
  },
  packingListAction: {
    backgroundColor: colors.primaryTint,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
  },
  packingListActionText: {
    ...typography.eyebrow,
    color: colors.primaryDeep,
  },
})
