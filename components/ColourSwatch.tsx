import { View, StyleSheet } from 'react-native'
import { colors, radius } from '../theme/tokens'

// Common apparel colour names mapped to representative hex values.
// Ordered longest-key-first is not required since we match exact first, then substring.
const COLOUR_MAP: Record<string, string> = {
  black: '#111111',
  white: '#FFFFFF',
  'off white': '#F5F0E6',
  ivory: '#FFFFF0',
  cream: '#FFFDD0',
  beige: '#E8DCC8',
  tan: '#D2B48C',
  khaki: '#C3B091',
  navy: '#001F3F',
  'navy blue': '#001F3F',
  'royal blue': '#4169E1',
  'sky blue': '#87CEEB',
  'baby blue': '#89CFF0',
  denim: '#1560BD',
  'denim blue': '#1560BD',
  blue: '#0057B8',
  teal: '#008080',
  turquoise: '#40E0D0',
  aqua: '#00FFFF',
  green: '#2E7D32',
  'bottle green': '#0B3D2E',
  olive: '#708238',
  lime: '#A4C639',
  mint: '#98FF98',
  yellow: '#FFD700',
  mustard: '#E1AD01',
  gold: '#D4AF37',
  orange: '#FF7A00',
  peach: '#FFCBA4',
  coral: '#FF7F50',
  red: '#D32F2F',
  maroon: '#800000',
  burgundy: '#800020',
  wine: '#722F37',
  pink: '#FF6FA5',
  fuchsia: '#FF00FF',
  magenta: '#D6249F',
  purple: '#6A1B9A',
  lavender: '#B57EDC',
  violet: '#8F00FF',
  brown: '#6B4226',
  chocolate: '#7B3F00',
  grey: '#8A8D91',
  gray: '#8A8D91',
  charcoal: '#36454F',
  silver: '#C0C0C0',
  multi: '#B0B0B0',
  'multi colour': '#B0B0B0',
  'multi color': '#B0B0B0',
}

export function colourToHex(name: string | null | undefined): string | null {
  if (!name) return null
  const key = name.trim().toLowerCase()
  if (!key) return null

  if (COLOUR_MAP[key]) return COLOUR_MAP[key]

  const match = Object.keys(COLOUR_MAP).find((k) => key.includes(k))
  return match ? COLOUR_MAP[match] : null
}

export default function ColourSwatch({
  colour,
  size = 14,
}: {
  colour: string | null | undefined
  size?: number
}) {
  const hex = colourToHex(colour)

  return (
    <View
      style={[
        styles.swatch,
        {
          width: size,
          height: size,
          borderRadius: radius.md * (size / 24),
          backgroundColor: hex ?? colors.surfaceStrong,
          borderColor: hex === '#FFFFFF' ? colors.borderStrong : colors.borderSubtle,
        },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  swatch: {
    borderWidth: 1,
  },
})
