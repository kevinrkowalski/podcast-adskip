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
assert.equal(ids(q.addToQueue(list, c, 'c')), 'a,b', 'current episode is not queued');
assert.equal(ids(q.playNext(list, c)), 'c,a,b', 'play next inserts at front');
assert.equal(ids(q.playNext(list, b)), 'b,a', 'play next moves existing to front');
assert.equal(ids(q.removeFromQueue(list, 'a')), 'b');
assert.equal(ids(q.moveInQueue(['a', 'b', 'c'].map((g) => ep(g)), 2, -1)), 'a,c,b');
assert.equal(ids(q.moveInQueue(list, 0, -1)), 'a,b', 'move clamps at top');

let t = q.takeNext([a, b, c], 'a');
assert.equal(t.next.guid, 'b', 'skips the finished episode');
assert.equal(ids(t.rest), 'c');
t = q.takeNext([ep('n', undefined, { enclosureUrl: undefined }), c]);
assert.equal(t.next.guid, 'c', 'skips entries without audio');
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
console.log('queue logic tests OK');
