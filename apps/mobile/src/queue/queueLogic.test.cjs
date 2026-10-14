/* Queue logic tests (no Jest). Run: npm run queue-test */
const assert = require('node:assert/strict');
const q = require('../../.test-build/queue/queueLogic.js');

const ep = (guid, pubDate, extra = {}) => ({ guid, title: guid, feedUrl: 'f', enclosureUrl: `https://x/${guid}.mp3`, pubDate, ...extra });
const a = ep('a'), b = ep('b'), c = ep('c');
const ids = (list) => list.map((e) => e.guid).join(',');

let list = q.addToQueue([], a);
list = q.addToQueue(list, b);
list = q.addToQueue(list, a);
assert.equal(ids(list), 'a,b', 'no duplicates on add');
assert.equal(ids(q.playNext(list, c)), 'c,a,b', 'play next inserts at front');
assert.equal(ids(q.playNext(list, b)), 'b,a', 'play next moves existing to front');
assert.equal(ids(q.removeFromQueue(list, 'a')), 'b');
assert.equal(ids(q.moveInQueue(['a', 'b', 'c'].map((g) => ep(g)), 2, -1)), 'a,c,b');
assert.equal(ids(q.moveInQueue(list, 0, -1)), 'a,b', 'move clamps at top');

// Add-on-play: the playing episode lives at index 0.
assert.equal(ids(q.addOnPlay([], a)), 'a', 'add-on-play into empty queue');
const top = [a, b, c];
assert.equal(q.addOnPlay(top, a), top, 'already at 0 is a no-op (same array)');
assert.equal(ids(q.addOnPlay(top, c)), 'c,a,b', 'elsewhere moves to top, no duplicate');
assert.equal(ids(q.addOnPlay([a, b], c)), 'c,a,b', 'new episode goes to top');

// Play next with something playing at 0 inserts at index 1.
assert.equal(ids(q.playNext([a, b], c, 'a')), 'a,c,b', 'play next goes after the playing item');
assert.equal(ids(q.playNext([a, b, c], c, 'a')), 'a,c,b', 'play next moves existing to index 1');
assert.equal(ids(q.playNext([a, b], a, 'a')), 'a,b', 'play next on the playing episode is a no-op');
assert.equal(ids(q.playNext([], c, 'a')), 'c', 'playing episode not queued: front');
assert.equal(ids(q.addToQueue([a, b], a)), 'a,b', 'add keeps dedupe with playing item');

// Playing item is pinned for reordering; counts exclude it.
assert.equal(ids(q.moveInQueue([a, b, c], 1, -1, 'a')), 'a,b,c', 'nothing moves above playing');
assert.equal(ids(q.moveInQueue([a, b, c], 0, 1, 'a')), 'a,b,c', 'playing item does not move');
assert.equal(ids(q.moveInQueue([a, b, c], 1, 1, 'a')), 'a,c,b');
assert.equal(q.upNextCount([a, b, c], 'a'), 2);
assert.equal(q.upNextCount([a, b, c], null), 3);

// Auto-advance: finished index 0 removed; next becomes index 0 and stays queued.
let t = q.takeNext([a, b, c], 'a');
assert.equal(t.next.guid, 'b', 'skips the finished episode');
assert.equal(ids(t.rest), 'b,c', 'next is now at index 0');
assert.equal(q.addOnPlay(t.rest, t.next), t.rest, 'starting it afterwards is a no-op');
t = q.takeNext([a], 'a');
assert.equal(t.next, null);
assert.equal(ids(t.rest), '', 'finished last item leaves an empty queue');
t = q.takeNext([ep('n', undefined, { enclosureUrl: undefined }), c]);
assert.equal(t.next.guid, 'c', 'skips entries without audio');
assert.equal(ids(t.rest), 'c,n', 'playable next moves to index 0');
assert.equal(q.takeNext([]).next, null);
assert.equal(ids(q.normalizeQueue([a, a, null, { title: 'x' }, b])), 'a,b');
assert.deepEqual(q.normalizeQueue('junk'), []);

const now = Date.parse('2026-10-12T12:00:00Z');
const old1 = ep('old1', '2026-10-01T00:00:00Z');
const old2 = ep('old2', '2026-09-01T00:00:00Z');
let st = q.enableAutoQueueState([old1, old2], now);
let r = q.detectNewEpisodes(st, [old1, old2, ep('older-unseen', '2026-01-01T00:00:00Z')]);
assert.equal(r.toAdd.length, 0, 'no back-catalog backfill');
const n1 = ep('n1', '2026-10-13T00:00:00Z');
const n2 = ep('n2', '2026-10-14T00:00:00Z');
r = q.detectNewEpisodes(r.state, [n2, n1, old1]);
assert.equal(ids(r.toAdd), 'n1,n2', 'new episodes added oldest first');
r = q.detectNewEpisodes(r.state, [n2, n1, old1]);
assert.equal(r.toAdd.length, 0, 'not re-added on next refresh');
// Played episodes leave the queue; the playing one stays pinned until it changes.
const playedSet = new Set(['a', 'c']);
const isP = (g) => playedSet.has(g);
assert.equal(ids(q.dropPlayed([a, b, c], isP, 'a')), 'a,b', 'played removed except playing item');
assert.equal(ids(q.dropPlayed([a, b, c], isP, null)), 'b', 'all played removed when nothing playing');
const clean = [b];
assert.equal(q.dropPlayed(clean, isP, null), clean, 'no change returns same array');
console.log('queue logic tests OK');
