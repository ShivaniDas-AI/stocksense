import React from "react";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "./auth/AuthContext";
import { ConnectScreen } from "./screens/ConnectScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ProductScreen } from "./screens/ProductScreen";
import { AlertsScreen } from "./screens/AlertsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { useTheme } from "./theme";

export type RootStackParamList = {
  Tabs: undefined;
  Product: { id: string; title: string };
  Connect: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

type IconName = React.ComponentProps<typeof Ionicons>["name"];
const TAB_ICONS: Record<string, { on: IconName; off: IconName }> = {
  Dashboard: { on: "grid", off: "grid-outline" },
  Alerts: { on: "notifications", off: "notifications-outline" },
  Settings: { on: "settings", off: "settings-outline" },
};

function Tabs() {
  const t = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        tabBarIcon: ({ color, focused, size }) => (
          <Ionicons name={focused ? TAB_ICONS[route.name].on : TAB_ICONS[route.name].off} size={size} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Alerts" component={AlertsScreen} />
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
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.text,
          headerTitleStyle: { fontWeight: "700" },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        {token ? (
          <>
            <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
            <Stack.Screen name="Product" component={ProductScreen} options={{ title: "Product" }} />
            <Stack.Screen name="Connect" component={ConnectRoute} options={{ title: "Add store" }} />
          </>
        ) : (
          <Stack.Screen name="Connect" component={ConnectRoute} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
