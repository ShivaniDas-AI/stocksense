import React from "react";
import { View } from "react-native";
import { Text } from "./AppText";
import { fw, RISK_ORDER, riskMeta, RiskLevel, space, tone, type, useTheme } from "../theme";

/**
 * One stacked bar showing how the forecast SKUs split across risk levels,
 * with a legend of counts. Reads at a glance; tapping a legend item filters.
 */
export function RiskBar({ counts, onPick }: { counts: Partial<Record<RiskLevel, number>>; onPick?: (level: RiskLevel) => void }) {
  const t = useTheme();
  const total = RISK_ORDER.reduce((a, k) => a + (counts[k] || 0), 0);
  if (!total) return null;
  return (
    <View>
      <View style={{ flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", backgroundColor: t.surfaceAlt }}>
        {RISK_ORDER.map((k) => {
          const n = counts[k] || 0;
          if (!n) return null;
          return <View key={k} style={{ flex: n, backgroundColor: tone(t, riskMeta[k].tone).fg, marginRight: 1 }} />;
        })}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: space.sm, columnGap: 14, rowGap: 6 }}>
        {RISK_ORDER.map((k) => {
          const n = counts[k] || 0;
          if (!n) return null;
          const c = tone(t, riskMeta[k].tone);
          return (
            <Text key={k} onPress={onPick ? () => onPick(k) : undefined} style={[type.caption, { color: t.textSecondary }]}>
              <Text style={{ color: c.fg }}>●</Text> <Text style={[fw(600), { color: t.text }]}>{n}</Text> {riskMeta[k].label.toLowerCase()}
            </Text>
          );
        })}
      </View>
    </View>
  );
}
