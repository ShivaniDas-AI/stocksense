import React from "react";
import { Pressable, View } from "react-native";
import { Text } from "./AppText";
import { fw, space, Status, STATUS_ORDER, statusMeta, tone, type, useTheme } from "../theme";

/**
 * One stacked bar showing how the products split across forecast statuses,
 * with a tappable legend of counts.
 */
export function StatusBar({ counts, onPick }: { counts: Partial<Record<string, number>>; onPick?: (s: Status) => void }) {
  const t = useTheme();
  const total = STATUS_ORDER.reduce((a, k) => a + (counts[k] || 0), 0);
  if (!total) return null;
  return (
    <View>
      <View style={{ flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", backgroundColor: t.surfaceAlt }}>
        {STATUS_ORDER.map((k) => {
          const n = counts[k] || 0;
          if (!n) return null;
          return <View key={k} style={{ flex: n, backgroundColor: tone(t, statusMeta[k].tone).fg, marginRight: 1 }} />;
        })}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: space.sm, columnGap: 14, rowGap: 6 }}>
        {STATUS_ORDER.map((k) => {
          const n = counts[k] || 0;
          if (!n) return null;
          const c = tone(t, statusMeta[k].tone);
          return (
            <Pressable key={k} onPress={onPick ? () => onPick(k) : undefined} hitSlop={6} style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.fg, marginRight: 5 }} />
              <Text style={[type.caption, { color: t.textSecondary }]}>
                <Text style={[fw(700), { color: t.text }]}>{n}</Text> {statusMeta[k].label.toLowerCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
