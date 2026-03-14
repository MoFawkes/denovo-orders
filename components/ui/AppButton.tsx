import { Pressable, Text, StyleSheet } from "react-native";

export default function AppButton({ label, onPress }: any) {
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: "#2563EB",
    height: 56,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  text: {
    color: "white",
    fontSize: 16,
    fontWeight: "700",
  },
});