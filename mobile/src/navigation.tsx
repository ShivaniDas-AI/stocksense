import React from "react";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "./auth/AuthContext";
import { api } from "./api/client";
import { ConnectScreen } from "./screens/ConnectScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ProductScreen } from "./screens/ProductScreen";
import { ReorderScreen } from "./screens/ReorderScreen";
import { OrdersScreen } from "./screens/OrdersScreen";
import { PurchaseOrderScreen } from "./screens/PurchaseOrderScreen";
import { AlertsScreen } from "./screens/AlertsScreen";
import { WhatsAppScreen } from "./screens/WhatsAppScreen";
import { WhatsAppChatScreen } from "./screens/WhatsAppChatScreen";
import { AskScreen } from "./screens/AskScreen";
import { MetricScreen } from "./screens/MetricScreen";
import type { KpiMetric } from "./api/types";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ApiKeysScreen } from "./screens/ApiKeysScreen";
import { useTheme } from "./theme";
import { guarded } from "./components/ErrorBoundary";

export type RootStackParamList = {
  Tabs: undefined;
  Product: { id: string; title: string };
  Reorder: { id: string; title: string };
  PurchaseOrder: { id: number; title: string };
  WhatsAppChat: undefined;
  Ask: { prompt?: string } | undefined;
  Metric: { metric: KpiMetric; title: string };
  Connect: undefined;
  ApiKeys: undefined;
};


/** Every screen gets its own error boundary, created once. */
const G = {
  AlertsScreen: guarded(AlertsScreen as React.ComponentType<any>),
  ApiKeysScreen: guarded(ApiKeysScreen as React.ComponentType<any>),
  AskScreen: guarded(AskScreen as React.ComponentType<any>),
  ConnectRoute: guarded(ConnectRoute as React.ComponentType<any>),
  DashboardScreen: guarded(DashboardScreen as React.ComponentType<any>),
  MetricScreen: guarded(MetricScreen as React.ComponentType<any>),
  OrdersScreen: guarded(OrdersScreen as React.ComponentType<any>),
  ProductScreen: guarded(ProductScreen as React.ComponentType<any>),
  PurchaseOrderScreen: guarded(PurchaseOrderScreen as React.ComponentType<any>),
  ReorderScreen: guarded(ReorderScreen as React.ComponentType<any>),
  SettingsScreen: guarded(SettingsScreen as React.ComponentType<any>),
  WhatsAppChatScreen: guarded(WhatsAppChatScreen as React.ComponentType<any>),
  WhatsAppScreen: guarded(WhatsAppScreen as React.ComponentType<any>),
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

type IconName = React.ComponentProps<typeof Ionicons>["name"];
const TAB_ICONS: Record<string, { on: IconName; off: IconName }> = {
  Home: { on: "grid", off: "grid-outline" },
  Orders: { on: "document-text", off: "document-text-outline" },
  Alerts: { on: "notifications", off: "notifications-outline" },
  WhatsApp: { on: "logo-whatsapp", off: "logo-whatsapp" },
  Settings: { on: "settings", off: "settings-outline" },
};

function Tabs() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // Open alerts as a badge on the tab.
  const open = useQuery({ queryKey: ["alertsV1", "open"], queryFn: () => api.alertsV1("open"), refetchInterval: 60_000, retry: 0 });
  const badge = open.data?.total ? (open.data.total > 99 ? "99+" : open.data.total) : undefined;
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: route.name === "WhatsApp" ? "#128C7E" : t.primary,
        tabBarInactiveTintColor: t.textMuted,
        // Room for icon + label above the gesture / navigation bar, and a label size that does not grow with the system font.
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border, height: 60 + insets.bottom, paddingTop: 6, paddingBottom: Math.max(insets.bottom, 8) },
        tabBarLabelStyle: { fontSize: 11, lineHeight: 14, fontFamily: "Inter_600SemiBold", marginTop: 2 },
        tabBarAllowFontScaling: false,
        tabBarIcon: ({ color, focused, size }) => (
          <Ionicons name={focused ? TAB_ICONS[route.name].on : TAB_ICONS[route.name].off} size={size} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={G.DashboardScreen} />
      <Tab.Screen name="Orders" component={G.OrdersScreen} />
      <Tab.Screen name="Alerts" component={G.AlertsScreen} options={{ tabBarBadge: badge, tabBarBadgeStyle: { backgroundColor: t.danger, color: "#fff", fontSize: 10 } }} />
      <Tab.Screen name="WhatsApp" component={G.WhatsAppScreen} />
      <Tab.Screen name="Settings" component={G.SettingsScreen} />
    </Tab.Navigator>
  );
}

function ConnectRoute({ navigation }: { navigation: { goBack: () => void; canGoBack: () => boolean } }) {
  // First login: signing in swaps the navigator to the tabs, so there is no
  // screen to go back to. "Add another store" from Settings does have one.
  return <ConnectScreen onDone={() => { if (navigation.canGoBack()) navigation.goBack(); }} />;
}

export function Navigation() {
  const { token } = useAuth();
  const t = useTheme();
  const base = t.dark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: { ...base.colors, primary: t.primary, background: t.bg, card: t.surface, text: t.text, border: t.border, notification: t.danger },
  };
  return (
    <NavigationContainer theme={navTheme} documentTitle={{ formatter: () => "StockSense" }}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.text,
          headerTitleStyle: { fontFamily: "Inter_700Bold" },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        {token ? (
          <>
            <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
            <Stack.Screen name="Product" component={G.ProductScreen} options={{ title: "Product" }} />
            <Stack.Screen name="Reorder" component={G.ReorderScreen} options={{ title: "Reorder" }} />
            <Stack.Screen name="PurchaseOrder" component={G.PurchaseOrderScreen} options={({ route }) => ({ title: route.params.title })} />
            <Stack.Screen name="WhatsAppChat" component={G.WhatsAppChatScreen} options={{ title: "WhatsApp chat" }} />
            <Stack.Screen name="Ask" component={G.AskScreen} options={{ title: "Ask StockSense" }} />
            <Stack.Screen name="Metric" component={G.MetricScreen} options={({ route }) => ({ title: route.params.title })} />
            <Stack.Screen name="Connect" component={G.ConnectRoute} options={{ title: "Add store" }} />
            <Stack.Screen name="ApiKeys" component={G.ApiKeysScreen} options={{ title: "API keys" }} />
          </>
        ) : (
          <Stack.Screen name="Connect" component={G.ConnectRoute} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
