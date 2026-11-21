import React from "react";
import { ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "./ui";
import { space, type, useTheme } from "../theme";

/**
 * Catches a crash in one screen and shows what went wrong with a way to try
 * again, instead of a blank or red screen for the whole app.
 */
class Boundary extends React.Component<{ children: React.ReactNode; fallback: (error: Error, reset: () => void) => React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[StockSense] screen crashed:", error?.message, info?.componentStack);
  }
  reset = () => this.setState({ error: null });
  render() {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}

function Fallback({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTheme();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: space.xl }}>
      <View style={{ alignItems: "center" }}>
        <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: t.dangerSoft, alignItems: "center", justifyContent: "center", marginBottom: space.lg }}>
          <Ionicons name="bug-outline" size={26} color={t.danger} />
        </View>
        <Text style={[type.heading, { color: t.text, textAlign: "center" }]}>This screen hit a problem</Text>
        <Text style={[type.body, { color: t.textSecondary, textAlign: "center", marginTop: 6 }]}>
          The rest of the app still works. Try again, or send this message to support:
        </Text>
        <Text selectable style={[type.mono, { color: t.text, backgroundColor: t.surfaceAlt, padding: space.md, borderRadius: 8, marginTop: space.md, alignSelf: "stretch" }]}>
          {String(error?.message || error)}
        </Text>
        <Button title="Try again" icon="refresh" onPress={reset} style={{ marginTop: space.lg, alignSelf: "stretch" }} />
      </View>
    </ScrollView>
  );
}

export function ErrorBoundary({ children }: { children: React.ReactNode }) {
  return <Boundary fallback={(error, reset) => <Fallback error={error} reset={reset} />}>{children}</Boundary>;
}

/** Wrap a screen component so a crash stays inside that screen. */
export function guarded<P extends object>(Screen: React.ComponentType<P>): React.ComponentType<P> {
  const Wrapped = (props: P) => (
    <ErrorBoundary>
      <Screen {...props} />
    </ErrorBoundary>
  );
  Wrapped.displayName = `Guarded(${Screen.displayName || Screen.name || "Screen"})`;
  return Wrapped;
}
