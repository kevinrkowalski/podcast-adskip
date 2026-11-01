/// <reference types="jest" />
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import type { Episode } from '@/src/types';

const QUEUE_KEY = '@podcast-adskip/queue';
const AUTO_QUEUE_KEY = '@podcast-adskip/autoQueue';

type Storage = typeof import('@react-native-async-storage/async-storage').default;
type Store = typeof import('./queueStore');

/** Fresh module state per test (the queue store keeps module-level state). */
function load(): { storage: Storage; load: () => Store } {
  jest.resetModules();
  const mod = require('@react-native-async-storage/async-storage');
  const storage = (mod.default ?? mod) as Storage;
  return { storage, load: () => require('./queueStore') as Store };
}

const ep = (guid: string): Episode => ({
  guid,
  title: guid,
  feedUrl: 'https://f.example/feed',
  enclosureUrl: `https://x/${guid}.mp3`,
});

const guids = (raw: string | null) => (raw ? (JSON.parse(raw) as Episode[]).map((e) => e.guid) : []);

test('a failed queue read does not overwrite the stored queue', async () => {
  const { storage, load: loadStore } = load();
  await storage.clear();
  await storage.setItem(QUEUE_KEY, JSON.stringify([ep('a'), ep('b')]));
  const realGetItem = async (key: string) => (await storage.multiGet([key]))[0][1];
  let failing = true;
  jest.spyOn(storage, 'getItem').mockImplementation(async (key: string) => {
    if (failing && key === QUEUE_KEY) throw new Error('storage busy');
    return realGetItem(key);
  });

  const store = loadStore();
  await store.addToQueue(ep('c'));
  expect(guids(await realGetItem(QUEUE_KEY))).toEqual(['a', 'b']);

  // Storage recovers: the next operation hydrates, merging the pending addition.
  failing = false;
  await store.addToQueue(ep('d'));
  expect(store.getQueue().map((e) => e.guid)).toEqual(['a', 'b', 'c', 'd']);
  await new Promise((r) => setTimeout(r, 0));
  expect(guids(await storage.getItem(QUEUE_KEY))).toEqual(['a', 'b', 'c', 'd']);
});

test('a failed auto-add settings read does not wipe other shows', async () => {
  const { storage, load: loadStore } = load();
  await storage.clear();
  const stored = { 'collection:1': { enabled: true, lastSeenPubMs: 0, seenGuids: [] } };
  await storage.setItem(AUTO_QUEUE_KEY, JSON.stringify(stored));
  const realGetItem = async (key: string) => (await storage.multiGet([key]))[0][1];
  jest.spyOn(storage, 'getItem').mockImplementation(async (key: string) => {
    if (key === AUTO_QUEUE_KEY) throw new Error('storage busy');
    return realGetItem(key);
  });

  const store = loadStore();
  await expect(store.setAutoQueueEnabled({ collectionId: 2 }, true, [])).rejects.toThrow('storage busy');
  expect(JSON.parse((await realGetItem(AUTO_QUEUE_KEY))!)).toEqual(stored);
});

test('turning auto-add off is not undone by a concurrent feed refresh', async () => {
  const { storage, load: loadStore } = load();
  await storage.clear();
  const store = loadStore();
  const show = { collectionId: 7 };
  await store.setAutoQueueEnabled(show, true, []);
  const future = new Date(Date.now() + 60_000).toISOString();
  const refresh = store.processFeedForAutoQueue(show, [{ ...ep('new'), pubDate: future }]);
  const toggleOff = store.setAutoQueueEnabled(show, false, []);
  await Promise.all([refresh, toggleOff]);
  expect(await store.isAutoQueueEnabled(show)).toBe(false);
});

test('unreadable auto-add settings are backed up before a toggle overwrites them', async () => {
  const { storage, load: loadStore } = load();
  await storage.clear();
  const corrupt = '{"collection:1":{"enabled":true,"lastSeenPubMs":1'; // truncated write
  await storage.setItem(AUTO_QUEUE_KEY, corrupt);
  const store = loadStore();

  await store.setAutoQueueEnabled({ collectionId: 2 }, true, []);

  expect(await storage.getItem(store.AUTO_QUEUE_BACKUP_KEY)).toBe(corrupt);
  expect(Object.keys(JSON.parse((await storage.getItem(AUTO_QUEUE_KEY))!))).toEqual(['collection:2']);
});
