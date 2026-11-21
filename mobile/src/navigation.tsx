import React from "react";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
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
import { SettingsScreen } from "./screens/SettingsScreen";
import { ApiKeysScreen } from "./screens/ApiKeysScreen";
import { useTheme } from "./theme";

export type RootStackParamList = {
  Tabs: undefined;
  Product: { id: string; title: string };
  Reorder: { id: string; title: string };
  PurchaseOrder: { id: number; title: string };
  WhatsAppChat: undefined;
  Ask: { prompt?: string } | undefined;
  Connect: undefined;
  ApiKeys: undefined;
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
  // Open alerts as a badge on the tab.
  const open = useQuery({ queryKey: ["alertsV1", "open"], queryFn: () => api.alertsV1("open"), refetchInterval: 60_000, retry: 0 });
  const badge = open.data?.total ? (open.data.total > 99 ? "99+" : open.data.total) : undefined;
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: route.name === "WhatsApp" ? "#128C7E" : t.primary,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
        tabBarLabelStyle: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
        tabBarIcon: ({ color, focused, size }) => (
          <Ionicons name={focused ? TAB_ICONS[route.name].on : TAB_ICONS[route.name].off} size={size} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={DashboardScreen} />
      <Tab.Screen name="Orders" component={OrdersScreen} />
      <Tab.Screen name="Alerts" component={AlertsScreen} options={{ tabBarBadge: badge, tabBarBadgeStyle: { backgroundColor: t.danger, color: "#fff", fontSize: 10 } }} />
      <Tab.Screen name="WhatsApp" component={WhatsAppScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
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
            <Stack.Screen name="Product" component={ProductScreen} options={{ title: "Product" }} />
            <Stack.Screen name="Reorder" component={ReorderScreen} options={{ title: "Reorder" }} />
            <Stack.Screen name="PurchaseOrder" component={PurchaseOrderScreen} options={({ route }) => ({ title: route.params.title })} />
            <Stack.Screen name="WhatsAppChat" component={WhatsAppChatScreen} options={{ title: "WhatsApp chat" }} />
            <Stack.Screen name="Ask" component={AskScreen} options={{ title: "Ask StockSense" }} />
            <Stack.Screen name="Connect" component={ConnectRoute} options={{ title: "Add store" }} />
            <Stack.Screen name="ApiKeys" component={ApiKeysScreen} options={{ title: "API keys" }} />
          </>
        ) : (
          <Stack.Screen name="Connect" component={ConnectRoute} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
