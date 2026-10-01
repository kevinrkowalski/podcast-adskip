import React from 'react';
import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBar } from 'expo-router/build/react-navigation/bottom-tabs';

import { theme } from '@/constants/Colors';
import { useClientOnlyValue } from '@/components/useClientOnlyValue';
import { MiniPlayer } from '@/components/MiniPlayer';

export const unstable_settings = {
  initialRouteName: 'index',
};

function TabBarWithMini(props: React.ComponentProps<typeof BottomTabBar>) {
  const insets = useSafeAreaInsets();
  const current = props.state.routes[props.state.index]?.name;
  // Player tab renders the full Now Playing UI in-place — hide mini + tab chrome
  // so controls are not covered (and so we never Redirect out of this tab).
  if (current === 'player') {
    return null;
  }

  return (
    <View
      style={StyleSheet.flatten([
        styles.tabChrome,
        // Keep both the mini player and tab bar above edge-to-edge system navigation.
        { paddingBottom: insets.bottom },
      ])}>
      <MiniPlayer />
      <BottomTabBar {...props} />
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      initialRouteName="index"
      tabBar={(props) => <TabBarWithMini {...props} />}
      screenOptions={{
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        headerShown: useClientOnlyValue(false, false),
        tabBarStyle: {
          backgroundColor: theme.tabBar,
          borderTopColor: theme.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 58,
          paddingBottom: 6,
          paddingTop: 4,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
        sceneStyle: { backgroundColor: theme.background },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Library',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'books.vertical', android: 'library_books', web: 'library_books' }}
              tintColor={color}
              size={24}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
              tintColor={color}
              size={24}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="player"
        options={{
          title: 'Player',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'play.circle', android: 'play_circle', web: 'play_circle' }}
              tintColor={color}
              size={24}
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabChrome: {
    backgroundColor: theme.tabBar,
  },
});
