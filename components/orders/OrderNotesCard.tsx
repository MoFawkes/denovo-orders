import { useState } from "react";
import { View, Text, TextInput, StyleSheet, Alert } from "react-native";
import { supabase } from "../../lib/supabase";
import AppCard from "../ui/AppCard";
import AppButton from "../ui/AppButton";

export default function OrderNotesCard({ order }: any) {
  const [notes, setNotes] = useState(order.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function saveNotes() {
    try {
      setSaving(true);

      const { error } = await supabase
        .from("orders")
        .update({ notes })
        .eq("id", order.id);

      if (error) throw error;

      Alert.alert("Saved", "Order notes updated");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppCard>
      <Text style={styles.title}>Order Notes</Text>

      <TextInput
        multiline
        value={notes}
        onChangeText={setNotes}
        placeholder="Write notes here (fabric ordered, trims pending, etc)"
        style={styles.input}
      />

      <AppButton
        label={saving ? "Saving..." : "Save Notes"}
        onPress={saveNotes}
      />
    </AppCard>
  );
}

const styles = StyleSheet.create({
  title: {
    color: "white",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 10,
  },
  input: {
    backgroundColor: "#10151D",
    borderRadius: 12,
    padding: 14,
    minHeight: 120,
    color: "white",
    borderWidth: 1,
    borderColor: "#2A3140",
    marginBottom: 12,
  },
});