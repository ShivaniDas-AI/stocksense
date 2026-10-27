import React from "react";
import { Text, View } from "react-native";
import Svg, { Line, Polyline, Text as SvgText } from "react-native-svg";
import { colors } from "../theme";

/**
 * Sales history (blue) and forecast (green) on one timeline, with a dashed
 * divider at today. Drawn with plain SVG so there is no chart library to
 * keep in step with Expo upgrades.
 */
export function LineChart({
  history,
  forecast,
  width,
  height = 200,
}: {
  history: { x: Date; y: number }[];
  forecast: { x: Date; y: number }[];
  width: number;
  height?: number;
}) {
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const all = [...history, ...forecast];
  if (!all.length) {
    return (
      <View style={{ height, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors.dim }}>No data yet</Text>
      </View>
    );
  }
  const xs = all.map((p) => p.x.getTime());
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yMax = Math.max(1, ...all.map((p) => p.y));
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const X = (t: number) => pad.l + (W * (t - x0)) / Math.max(1, x1 - x0);
  const Y = (v: number) => pad.t + H - (H * v) / yMax;
  const pts = (arr: { x: Date; y: number }[]) => arr.map((p) => `${X(p.x.getTime())},${Y(p.y)}`).join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const fmt = (t: number) => {
    const d = new Date(t);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  };

  return (
    <Svg width={width} height={height}>
      {gridLines.map((g) => (
        <React.Fragment key={g}>
          <Line x1={pad.l} x2={width - pad.r} y1={Y(yMax * g)} y2={Y(yMax * g)} stroke={colors.line} strokeWidth={1} />
          <SvgText x={4} y={Y(yMax * g) + 4} fill={colors.dim} fontSize={10}>
            {Math.round(yMax * g)}
          </SvgText>
        </React.Fragment>
      ))}
      {history.length > 1 && <Polyline points={pts(history)} fill="none" stroke={colors.blue} strokeWidth={2} />}
      {forecast.length > 1 && <Polyline points={pts(forecast)} fill="none" stroke={colors.green} strokeWidth={2} />}
      {forecast.length > 0 && (
        <Line
          x1={X(forecast[0].x.getTime())}
          x2={X(forecast[0].x.getTime())}
          y1={pad.t}
          y2={pad.t + H}
          stroke="#334a6b"
          strokeDasharray="4,4"
        />
      )}
      <SvgText x={pad.l} y={height - 6} fill={colors.dim} fontSize={10}>
        {fmt(x0)}
      </SvgText>
      <SvgText x={width - pad.r} y={height - 6} fill={colors.dim} fontSize={10} textAnchor="end">
        {fmt(x1)}
      </SvgText>
    </Svg>
  );
}
