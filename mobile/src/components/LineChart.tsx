import React from "react";
import { Text, View } from "react-native";
import Svg, { Defs, Line, LinearGradient, Path, Polyline, Stop, Text as SvgText } from "react-native-svg";
import { useTheme } from "../theme";

/**
 * Sales history and forecast on one timeline. The forecast area is shaded
 * and a dashed divider marks today. Plain SVG, no chart library.
 */
export function LineChart({
  history,
  forecast,
  width,
  height = 190,
}: {
  history: { x: Date; y: number }[];
  forecast: { x: Date; y: number }[];
  width: number;
  height?: number;
}) {
  const t = useTheme();
  const pad = { l: 30, r: 8, t: 12, b: 22 };
  const all = [...history, ...forecast];
  if (all.length < 2) {
    return (
      <View style={{ height, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: t.textMuted }}>Not enough data to chart yet</Text>
      </View>
    );
  }
  const xs = all.map((p) => p.x.getTime());
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yMax = Math.max(1, ...all.map((p) => p.y)) * 1.1;
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const X = (ts: number) => pad.l + (W * (ts - x0)) / Math.max(1, x1 - x0);
  const Y = (v: number) => pad.t + H - (H * v) / yMax;
  const pts = (arr: { x: Date; y: number }[]) => arr.map((p) => `${X(p.x.getTime()).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const area = (arr: { x: Date; y: number }[]) =>
    arr.length > 1
      ? `M${X(arr[0].x.getTime())},${pad.t + H} L${arr.map((p) => `${X(p.x.getTime())},${Y(p.y)}`).join(" L")} L${X(arr[arr.length - 1].x.getTime())},${pad.t + H} Z`
      : "";
  const month = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="fc" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={t.chartForecast} stopOpacity={0.25} />
          <Stop offset="1" stopColor={t.chartForecast} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      {[0, 0.5, 1].map((g) => (
        <React.Fragment key={g}>
          <Line x1={pad.l} x2={width - pad.r} y1={Y(yMax * g)} y2={Y(yMax * g)} stroke={t.chartGrid} strokeWidth={1} />
          <SvgText x={2} y={Y(yMax * g) + 4} fill={t.textMuted} fontSize={10}>{Math.round(yMax * g)}</SvgText>
        </React.Fragment>
      ))}
      {forecast.length > 1 && <Path d={area(forecast)} fill="url(#fc)" />}
      {history.length > 1 && <Polyline points={pts(history)} fill="none" stroke={t.chartHistory} strokeWidth={2} strokeLinejoin="round" />}
      {forecast.length > 1 && <Polyline points={pts(forecast)} fill="none" stroke={t.chartForecast} strokeWidth={2.5} strokeLinejoin="round" />}
      {forecast.length > 0 && (
        <Line x1={X(forecast[0].x.getTime())} x2={X(forecast[0].x.getTime())} y1={pad.t} y2={pad.t + H} stroke={t.textMuted} strokeDasharray="3,4" strokeWidth={1} />
      )}
      <SvgText x={pad.l} y={height - 6} fill={t.textMuted} fontSize={10}>{month(x0)}</SvgText>
      {forecast.length > 0 && (
        <SvgText x={X(forecast[0].x.getTime())} y={height - 6} fill={t.textMuted} fontSize={10} textAnchor="middle">today</SvgText>
      )}
      <SvgText x={width - pad.r} y={height - 6} fill={t.textMuted} fontSize={10} textAnchor="end">{month(x1)}</SvgText>
    </Svg>
  );
}
