import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';
import { Icon } from '@/components/ui';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

const SWIPE_REMOVE_PX = 110;

type RowCallbacks = {
  onDragStart: (index: number) => void;
  onDragMove: (index: number, dy: number) => void;
  onDragEnd: () => void;
  onRemove: (index: number) => void;
};

/**
 * A short list of fixed-height rows that can be reordered by dragging the handle and
 * removed by swiping sideways. Built on PanResponder/Animated (no gesture library).
 * Meant for tens of rows inside a ScrollView, not long virtualized lists.
 */
export function DraggableRows<T>({
  items,
  keyOf,
  rowHeight,
  renderRow,
  onMove,
  onRemove,
  onDragActive,
  removeLabel = 'Remove',
}: {
  items: T[];
  keyOf: (item: T) => string;
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  /** Called once when a drag ends on a new position. */
  onMove: (from: number, to: number) => void;
  onRemove: (item: T) => void;
  /** True while a drag or swipe is in progress (so the parent can stop scrolling). */
  onDragActive?: (active: boolean) => void;
  removeLabel?: string;
}) {
  // Shown order: follows `items`, except right after a drop, when it already shows the
  // new order while the store catches up (avoids a one-frame jump back).
  const [local, setLocal] = useState<T[] | null>(null);
  useEffect(() => setLocal(null), [items]);
  const shown = local ?? items;

  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const dragY = useRef(new Animated.Value(0)).current;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const propsRef = useRef({ onMove, onRemove, onDragActive, rowHeight });
  propsRef.current = { onMove, onRemove, onDragActive, rowHeight };

  const callbacks = useMemo<RowCallbacks>(
    () => ({
      onDragStart: (index) => {
        dragY.setValue(0);
        setDrag({ from: index, to: index });
        propsRef.current.onDragActive?.(true);
      },
      onDragMove: (index, dy) => {
        const count = shownRef.current.length;
        const h = propsRef.current.rowHeight;
        // Keep the dragged row inside the list.
        const clamped = Math.max(-index * h, Math.min((count - 1 - index) * h, dy));
        dragY.setValue(clamped);
        const to = Math.max(0, Math.min(count - 1, index + Math.round(clamped / h)));
        if (dragRef.current && dragRef.current.to !== to) setDrag({ from: index, to });
      },
      onDragEnd: () => {
        const d = dragRef.current;
        propsRef.current.onDragActive?.(false);
        dragY.setValue(0);
        setDrag(null);
        if (!d || d.from === d.to) return;
        const next = [...shownRef.current];
        const [moved] = next.splice(d.from, 1);
        next.splice(d.to, 0, moved);
        setLocal(next);
        propsRef.current.onMove(d.from, d.to);
      },
      onRemove: (index) => {
        const item = shownRef.current[index];
        if (item === undefined) return;
        setLocal(shownRef.current.filter((_, i) => i !== index));
        propsRef.current.onRemove(item);
      },
    }),
    [dragY],
  );

  return (
    <View style={{ height: shown.length * rowHeight }}>
      {shown.map((item, index) => {
        let shift = 0;
        if (drag && index !== drag.from) {
          if (drag.from < index && index <= drag.to) shift = -rowHeight;
          else if (drag.to <= index && index < drag.from) shift = rowHeight;
        }
        return (
          <Row
            key={keyOf(item)}
            index={index}
            height={rowHeight}
            dragging={drag?.from === index}
            dragY={dragY}
            shift={shift}
            callbacks={callbacks}
            onSwipeActive={onDragActive}
            removeLabel={removeLabel}>
            {renderRow(item, index)}
          </Row>
        );
      })}
    </View>
  );
}

function Row({
  index,
  height,
  dragging,
  dragY,
  shift,
  callbacks,
  onSwipeActive,
  removeLabel,
  children,
}: {
  index: number;
  height: number;
  dragging: boolean;
  dragY: Animated.Value;
  shift: number;
  callbacks: RowCallbacks;
  onSwipeActive?: (active: boolean) => void;
  removeLabel: string;
  children: ReactNode;
}) {
  const indexRef = useRef(index);
  indexRef.current = index;
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const swipeActiveRef = useRef(onSwipeActive);
  swipeActiveRef.current = onSwipeActive;
  const swipeX = useRef(new Animated.Value(0)).current;

  const handlePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => cbRef.current.onDragStart(indexRef.current),
      onPanResponderMove: (_e, g) => cbRef.current.onDragMove(indexRef.current, g.dy),
      onPanResponderRelease: () => cbRef.current.onDragEnd(),
      onPanResponderTerminate: () => cbRef.current.onDragEnd(),
    }),
  ).current;

  const swipePan = useRef(
    PanResponder.create({
      // Only a clearly sideways move: taps and vertical scrolling pass through.
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > 2 * Math.abs(g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => swipeActiveRef.current?.(true),
      onPanResponderMove: (_e, g) => swipeX.setValue(g.dx),
      onPanResponderRelease: (_e, g) => {
        swipeActiveRef.current?.(false);
        if (Math.abs(g.dx) >= SWIPE_REMOVE_PX) {
          Animated.timing(swipeX, { toValue: g.dx > 0 ? 500 : -500, duration: 140, useNativeDriver: false }).start(() =>
            cbRef.current.onRemove(indexRef.current),
          );
        } else {
          Animated.spring(swipeX, { toValue: 0, useNativeDriver: false, bounciness: 0 }).start();
        }
      },
      onPanResponderTerminate: () => {
        swipeActiveRef.current?.(false);
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: false, bounciness: 0 }).start();
      },
    }),
  ).current;

  return (
    <Animated.View
      style={[
        styles.row,
        { height, top: index * height, transform: [{ translateY: dragging ? dragY : shift }] },
        dragging && styles.rowDragging,
      ]}>
      <View style={styles.removeBehind} pointerEvents="none">
        <Text style={styles.removeText}>{removeLabel}</Text>
        <Text style={styles.removeText}>{removeLabel}</Text>
      </View>
      <Animated.View
        style={[styles.front, dragging && styles.frontDragging, { transform: [{ translateX: swipeX }] }]}
        {...swipePan.panHandlers}>
        <View style={styles.content}>{children}</View>
        <View
          {...handlePan.panHandlers}
          style={styles.handle}
          accessibilityLabel="Drag to reorder"
          accessibilityHint="Hold and drag up or down">
          <Icon name="grip" size={22} color={theme.textMuted} />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { position: 'absolute', left: 0, right: 0 },
  rowDragging: { zIndex: 10, elevation: 10 },
  removeBehind: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  removeText: { fontFamily: font.semi, fontSize: 13, color: theme.danger },
  front: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: theme.background },
  frontDragging: { backgroundColor: theme.surfaceElevated, borderRadius: 12 },
  content: { flex: 1, minWidth: 0 },
  handle: { width: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
});
