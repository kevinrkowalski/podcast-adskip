/// <reference types="jest" />
declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require('fs');
const path = require('path');

// Regression guard: the native service must never load a show's episode list as an
// ExoPlayer playlist, or it auto-advances to the show's next episode instead of the queue.
test('native playback service loads one episode at a time', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../modules/podcast-auto/android/src/main/java/expo/modules/podcastauto/PodcastAutoPlaybackService.kt'),
    'utf8',
  );
  expect(src).not.toMatch(/\.setMediaItems\(|\bsetMediaItems\(/);
  expect(src).not.toMatch(/queueForEpisode/);
});
