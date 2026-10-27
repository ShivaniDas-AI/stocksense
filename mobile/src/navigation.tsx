import React from "react";
import { Text } from "react-native";
import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useAuth } from "./auth/AuthContext";
import { ConnectScreen } from "./screens/ConnectScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ProductScreen } from "./screens/ProductScreen";
import { AlertsScreen } from "./screens/AlertsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { colors } from "./theme";

export type RootStackParamList = {
  Tabs: undefined;
  Product: { id: string; title: string };
  Connect: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.green,
    background: colors.bg,
    card: colors.panel,
    text: colors.text,
    border: colors.line,
    notification: colors.red,
  },
};

function TabIcon({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
}

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.dim,
        tabBarStyle: { backgroundColor: colors.panel, borderTopColor: colors.line },
      }}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} options={{ tabBarIcon: ({ color }) => <TabIcon glyph="▦" color={color} /> }} />
      <Tab.Screen name="Alerts" component={AlertsScreen} options={{ tabBarIcon: ({ color }) => <TabIcon glyph="▲" color={color} /> }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: ({ color }) => <TabIcon glyph="⚙" color={color} /> }} />
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
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.panel },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {token ? (
          <>
            <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
            <Stack.Screen name="Product" component={ProductScreen} options={({ route }) => ({ title: route.params.title || "Product" })} />
            <Stack.Screen name="Connect" component={ConnectRoute} options={{ title: "Add store" }} />
          </>
        ) : (
          <Stack.Screen name="Connect" component={ConnectRoute} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
