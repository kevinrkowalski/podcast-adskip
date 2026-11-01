/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SUBSCRIPTIONS_BACKUP_KEY, getSubscriptions, subscribe } from './storage';

const KEY = '@podcast-adskip/subscriptions';
const sub = (collectionId: number) => ({
  collectionId,
  collectionName: `Show ${collectionId}`,
  artistName: '',
  feedUrl: `https://example.com/${collectionId}.xml`,
  subscribedAt: '2026-11-01T00:00:00Z',
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('backs up an unreadable list before a subscribe overwrites it', async () => {
  const corrupt = '[{"collectionId":1,"collectionName":"Sh'; // truncated write
  await AsyncStorage.setItem(KEY, corrupt);

  expect(await getSubscriptions()).toEqual([]);
  await subscribe(sub(2));

  expect(await AsyncStorage.getItem(SUBSCRIPTIONS_BACKUP_KEY)).toBe(corrupt);
  expect((await getSubscriptions()).map((s) => s.collectionId)).toEqual([2]);
});

test('drops malformed entries but keeps valid ones', async () => {
  await AsyncStorage.setItem(KEY, JSON.stringify([sub(1), null, { foo: 1 }, sub(3)]));
  expect((await getSubscriptions()).map((s) => s.collectionId)).toEqual([1, 3]);
  expect(await AsyncStorage.getItem(SUBSCRIPTIONS_BACKUP_KEY)).toBeNull();
});
