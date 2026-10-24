/// <reference types="jest" />
jest.mock('@/src/api/rss', () => ({ fetchAndParseRss: jest.fn() }));
jest.mock('@/src/db/storage', () => ({ getSubscriptions: jest.fn(async () => []) }));
jest.mock('./queueStore', () => ({
  autoQueueShowKey: jest.fn(),
  getAutoQueueShowKeys: jest.fn(async () => []),
  processFeedForAutoQueue: jest.fn(),
}));

import { getAutoQueueShowKeys } from './queueStore';
import { STARTUP_REFRESH_DELAY_MS, startAutoQueueRefresh } from './autoQueueRefresh';

beforeEach(() => {
  jest.useFakeTimers();
  (getAutoQueueShowKeys as jest.Mock).mockClear();
});
afterEach(() => jest.useRealTimers());

test('the open-time refresh waits until the first screens are up, then runs', () => {
  const stop = startAutoQueueRefresh();
  expect(getAutoQueueShowKeys).not.toHaveBeenCalled();
  jest.advanceTimersByTime(STARTUP_REFRESH_DELAY_MS);
  expect(getAutoQueueShowKeys).toHaveBeenCalledTimes(1);
  stop();
});

test('stopping before the delay cancels the startup refresh', () => {
  const stop = startAutoQueueRefresh();
  stop();
  jest.advanceTimersByTime(STARTUP_REFRESH_DELAY_MS * 2);
  expect(getAutoQueueShowKeys).not.toHaveBeenCalled();
});
