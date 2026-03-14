import { View, StyleSheet } from "react-native";

export default function AppCard({ children }: any) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#1A1F29",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#2A3140",
    marginBottom: 16,
  },
});