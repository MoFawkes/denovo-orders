import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';

export default function ProductionSummaryScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const colors = {
    background: isDark ? '#0f172a' : '#f8fafc',
    card: isDark ? '#1e293b' : '#ffffff',
    text: isDark ? '#f8fafc' : '#0f172a',
    subtext: isDark ? '#94a3b8' : '#475569',
    border: isDark ? '#334155' : '#e2e8f0',
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.text }]}>Production Summary</Text>
        <Text style={[styles.subtitle, { color: colors.subtext }]}>
          Weekly metrics screen coming next
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    paddingTop: 40,
  },
  card: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 18,
  },
});