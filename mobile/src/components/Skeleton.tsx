import React, { useEffect, useRef } from "react";
import { Animated, View, ViewStyle } from "react-native";
import { radius, space, useTheme } from "../theme";
import { Grid2 } from "./ui";

/** A softly pulsing placeholder block, shown while data loads. */
export function Skeleton({ width, height, round, style }: { width?: number | `${number}%`; height: number; round?: boolean; style?: ViewStyle }) {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[
        { width: width ?? "100%", height, borderRadius: round ? height / 2 : radius.sm, backgroundColor: t.skeleton, opacity: pulse },
        style,
      ]}
    />
  );
}

/** Dashboard placeholder: header, hero, KPI grid and three product cards. */
export function DashboardSkeleton() {
  const t = useTheme();
  const card = { backgroundColor: t.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, padding: space.lg };
  return (
    <View style={{ padding: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: space.lg }}>
        <Skeleton width={44} height={44} round />
        <View style={{ marginLeft: space.md, flex: 1 }}>
          <Skeleton width="50%" height={20} />
          <Skeleton width="35%" height={12} style={{ marginTop: 8 }} />
        </View>
      </View>
      <View style={card}>
        <View style={{ flexDirection: "row" }}>
          <View style={{ flex: 1 }}>
            <Skeleton width="60%" height={11} />
            <Skeleton width="40%" height={30} style={{ marginTop: 10 }} />
            <Skeleton width="80%" height={22} round style={{ marginTop: 12 }} />
          </View>
          <View style={{ flex: 1, marginLeft: space.xl }}>
            <Skeleton width="60%" height={11} />
            <Skeleton width="70%" height={30} style={{ marginTop: 10 }} />
            <Skeleton width="90%" height={12} style={{ marginTop: 12 }} />
          </View>
        </View>
      </View>
      <Skeleton width="30%" height={11} style={{ marginTop: space.xl, marginBottom: space.sm }} />
      <Grid2>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[card, { flex: 1, padding: space.md }]}>
            <Skeleton width="55%" height={11} />
            <Skeleton width="65%" height={24} style={{ marginTop: 10 }} />
            <Skeleton width="80%" height={12} style={{ marginTop: 8 }} />
          </View>
        ))}
      </Grid2>
      <Skeleton width="30%" height={11} style={{ marginTop: space.xl, marginBottom: space.sm }} />
      {[0, 1, 2].map((i) => (
        <View key={i} style={[card, { padding: space.md, marginBottom: space.sm, flexDirection: "row" }]}>
          <Skeleton width={48} height={48} />
          <View style={{ flex: 1, marginLeft: space.md }}>
            <Skeleton width="70%" height={15} />
            <Skeleton width="40%" height={12} style={{ marginTop: 8 }} />
            <Skeleton width="100%" height={12} style={{ marginTop: 12 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Product screen placeholder. */
export function ProductSkeleton() {
  const t = useTheme();
  const card = { backgroundColor: t.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, padding: space.lg };
  return (
    <View style={{ padding: space.lg }}>
      <View style={{ flexDirection: "row" }}>
        <Skeleton width={72} height={72} />
        <View style={{ flex: 1, marginLeft: space.md }}>
          <Skeleton width="85%" height={22} />
          <Skeleton width="50%" height={13} style={{ marginTop: 8 }} />
          <Skeleton width="35%" height={22} round style={{ marginTop: 10 }} />
        </View>
      </View>
      <View style={[card, { marginTop: space.lg }]}>
        <Skeleton width="40%" height={11} />
        <Skeleton width="90%" height={18} style={{ marginTop: 10 }} />
        <Skeleton width="70%" height={13} style={{ marginTop: 8 }} />
      </View>
      <Grid2 style={{ marginTop: space.lg }}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[card, { flex: 1, padding: space.md }]}>
            <Skeleton width="55%" height={11} />
            <Skeleton width="60%" height={24} style={{ marginTop: 10 }} />
          </View>
        ))}
      </Grid2>
      <View style={[card, { marginTop: space.lg }]}>
        <Skeleton width="100%" height={190} />
      </View>
    </View>
  );
}
