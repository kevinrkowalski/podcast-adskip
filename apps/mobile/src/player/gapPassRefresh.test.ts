import type { SkipMap } from '@/src/types';
import {
  acceptRefreshedMap,
  needsGapPassRefresh,
  pollGapPass,
  segmentsChanged,
} from './gapPassRefresh';

const MD5 = 'a'.repeat(32);

function map(over: Partial<SkipMap> = {}): SkipMap {
  return {
    status: 'ready',
    episode_guid: 'ep1',
    audio_md5: MD5,
    segments: [{ start_ms: 40_000, end_ms: 95_000, type: 'sponsor', confidence: 0.95 }],
    gap_pass_pending: true,
    ...over,
  };
}

const done = map({
  gap_pass_pending: false,
  segments: [{ start_ms: 40_000, end_ms: 128_000, type: 'sponsor', confidence: 0.95 }],
});

function harness(replies: Array<SkipMap | Error>, current = () => true) {
  let t = 0;
  const fetched: string[] = [];
  const updates: SkipMap[] = [];
  const opts = {
    fetchMap: jest.fn(async (guid: string, md5: string) => {
      fetched.push(`${guid}:${md5}`);
      const r = replies.shift();
      if (!r) throw new Error('no more replies');
      if (r instanceof Error) throw r;
      return r;
    }),
    isCurrent: current,
    onUpdate: (m: SkipMap) => {
      updates.push(m);
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
    firstCheckMs: 10,
    intervalMs: 20,
    maxWaitMs: 200,
  };
  return { opts, fetched, updates, elapsed: () => t };
}

describe('gap pass refresh', () => {
  it('only refreshes ready maps with the pending flag and a fingerprint', () => {
    expect(needsGapPassRefresh(map())).toBe(true);
    expect(needsGapPassRefresh(map({ gap_pass_pending: false }))).toBe(false);
    expect(needsGapPassRefresh(map({ gap_pass_pending: undefined }))).toBe(false);
    expect(needsGapPassRefresh(map({ status: 'pending' }))).toBe(false);
    expect(needsGapPassRefresh(map({ audio_md5: null }))).toBe(false);
    expect(needsGapPassRefresh(null)).toBe(false);
  });

  it('accepts only the same episode and audio bytes', () => {
    expect(acceptRefreshedMap(map(), done)).toBe(done);
    expect(acceptRefreshedMap(map(), { ...done, audio_md5: MD5.toUpperCase() })).not.toBeNull();
    expect(acceptRefreshedMap(map(), { ...done, audio_md5: 'b'.repeat(32) })).toBeNull();
    expect(acceptRefreshedMap(map(), { ...done, episode_guid: 'other' })).toBeNull();
    expect(acceptRefreshedMap(map(), { status: 'missing', episode_guid: 'ep1', segments: [], analysis_for_other_audio: true })).toBeNull();
  });

  it('polls the same fingerprint until the pass is done, then applies once', async () => {
    const h = harness([map(), map(), done]);
    const result = await pollGapPass(map(), h.opts);
    expect(result).toBe(done);
    expect(h.updates).toEqual([done]);
    expect(h.fetched).toEqual([`ep1:${MD5}`, `ep1:${MD5}`, `ep1:${MD5}`]);
  });

  it('applies a finished pass with no additions too (clears the pending flag)', async () => {
    const finished = map({ gap_pass_pending: false });
    const h = harness([finished]);
    expect(await pollGapPass(map(), h.opts)).toBe(finished);
    expect(h.updates).toEqual([finished]);
    expect(segmentsChanged(map(), finished)).toBe(false);
  });

  it('keeps going after a network error', async () => {
    const h = harness([new Error('offline'), done]);
    expect(await pollGapPass(map(), h.opts)).toBe(done);
  });

  it('stops without changes when the map was replaced by another analysis', async () => {
    const h = harness([{ status: 'missing', episode_guid: 'ep1', segments: [], analysis_for_other_audio: true }]);
    expect(await pollGapPass(map(), h.opts)).toBeNull();
    expect(h.updates).toEqual([]);
  });

  it('stops when the user moves to another episode', async () => {
    const h = harness([map(), done], () => false);
    expect(await pollGapPass(map(), h.opts)).toBeNull();
    expect(h.opts.fetchMap).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it('gives up after the max wait and leaves the map alone', async () => {
    const h = harness(Array.from({ length: 50 }, () => map()));
    expect(await pollGapPass(map(), h.opts)).toBeNull();
    expect(h.updates).toEqual([]);
    expect(h.elapsed()).toBeLessThanOrEqual(200);
  });

  it('does nothing for a map that is not pending', async () => {
    const h = harness([done]);
    expect(await pollGapPass(done, h.opts)).toBeNull();
    expect(h.opts.fetchMap).not.toHaveBeenCalled();
  });
});
