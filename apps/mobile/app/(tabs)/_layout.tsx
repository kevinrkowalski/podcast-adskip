import React from 'react';
import { Tabs } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';
import { MiniPlayer } from '@/components/MiniPlayer';
import { Icon, type IconName } from '@/components/ui';

export const unstable_settings = {
  initialRouteName: 'index',
};

const TAB_ICONS: Record<string, IconName> = { index: 'listen', shows: 'shows', search: 'search' };

type TabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

/** Mini player and tabs as one floating unit over the screen's content. */
function Dock({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.dock, { bottom: insets.bottom + 10 }]}>
      <MiniPlayer />
      <View style={styles.tabs} accessibilityRole="tablist">
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const label = String(descriptors[route.key]?.options.title ?? route.name);
          const color = focused ? theme.text : theme.textMuted;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              onPress={() => {
                const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
              }}
              style={[styles.tab, focused && styles.tabOn]}>
              <Icon name={TAB_ICONS[route.name] ?? 'shows'} size={22} color={color} />
              <Text style={[styles.tabLabel, { color }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      initialRouteName="index"
      tabBar={(props) => <Dock {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: theme.background } }}>
      <Tabs.Screen name="index" options={{ title: 'Listen' }} />
      <Tabs.Screen name="shows" options={{ title: 'Shows' }} />
      <Tabs.Screen name="search" options={{ title: 'Search' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  dock: { position: 'absolute', left: 10, right: 10, gap: 8 },
  tabs: {
    flexDirection: 'row',
    backgroundColor: theme.tabBar,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    padding: 6,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 7, borderRadius: 18 },
  tabOn: { backgroundColor: 'rgba(255,255,255,0.07)' },
  tabLabel: { fontFamily: font.medium, fontSize: 11 },
});
