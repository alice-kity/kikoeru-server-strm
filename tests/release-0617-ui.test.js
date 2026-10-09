'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {
  ADMIN_HTML,
  MENU_SCRIPT,
  installAudioElementTranscodeGuard,
  isStrmTrack,
  strmPlaybackSource,
  installAudioElementSourceGuard,
} = require('../patches/0.6.17/strm-adapter/admin-ui');

test('STRM source guard requests local media only for Web Audio and leaves native URLs untouched', () => {
  const source = '/api/media/stream/1/2?token=test';
  assert.equal(strmPlaybackSource(source, { title: 'ordinary.wav' }, true), source);
  assert.match(strmPlaybackSource(source, { isStrm: true }, false), /strm=1$/);
  assert.match(strmPlaybackSource(source, { isStrm: true }, true), /strm=1&strm_local=1$/);
  const vm = {
    currentPlayingFile: { isStrm: true }, enableVisualizer: true,
    _computedWatchers: { source: { getter() { return source; } } }, _watchers: [],
  };
  assert.equal(installAudioElementSourceGuard(vm), true);
  assert.match(vm._computedWatchers.source.getter.call(vm), /strm_local=1/);
  vm.currentPlayingFile = { title: 'ordinary.wav' };
  assert.equal(vm._computedWatchers.source.getter.call(vm), source);
});

test('0.6.17 player guard skips STRM current and next tracks only', async () => {
  const calls = { current: 0, next: 0 };
  const methods = {
    checkCurrentPlayingFileShouldUseTranscoding() {
      calls.current += 1;
      return this.transcodeOption !== 'off'
        && this.transcodeFromTypes.includes(this.currentPlayingFile.ext);
    },
    async checkNextPlayingFileShouldUseTranscodingAndPreTranscode() {
      calls.next += 1;
      return this.queue[this.queueIndex + 1].hash;
    },
  };
  const player = {
    currentPlayingFile: { hash: '1/0', ext: 'wav' },
    queue: [{ hash: '1/0' }, { hash: '1/1', isStrm: true }],
    queueIndex: 0,
    transcodeOption: 'aac 320',
    transcodeFromTypes: ['wav', 'flac'],
    checkCurrentPlayingFileShouldUseTranscoding: methods.checkCurrentPlayingFileShouldUseTranscoding,
    checkNextPlayingFileShouldUseTranscodingAndPreTranscode: methods.checkNextPlayingFileShouldUseTranscodingAndPreTranscode,
  };

  assert.equal(installAudioElementTranscodeGuard(methods, player), true);
  assert.equal(isStrmTrack({ isStrm: true }), true);
  assert.equal(isStrmTrack({ isStrm: 1 }), false);

  assert.equal(player.checkCurrentPlayingFileShouldUseTranscoding(), true,
    'ordinary WAV continues to honor the selected transcode option');
  player.currentPlayingFile = { hash: '1/2', ext: 'wav', isStrm: true };
  assert.equal(player.checkCurrentPlayingFileShouldUseTranscoding(), false,
    'STRM current track bypasses the selected transcode option');

  assert.equal(await player.checkNextPlayingFileShouldUseTranscodingAndPreTranscode(), false,
    'STRM next track does not start server pre-transcoding');
  assert.equal(calls.next, 0);

  player.queue[1] = { hash: '1/1', ext: 'flac' };
  assert.equal(await player.checkNextPlayingFileShouldUseTranscodingAndPreTranscode(), '1/1',
    'ordinary next track still uses the native pre-transcode method');
  assert.equal(calls.next, 1);

  player.transcodeOption = 'off';
  player.currentPlayingFile = { hash: '1/3', ext: 'wav' };
  assert.equal(player.checkCurrentPlayingFileShouldUseTranscoding(), false,
    'the native off setting remains effective for ordinary media');
  assert.equal(calls.current, 2);
});

test('0.6.17 runtime bundle and standalone shell use current upstream assets and clean up', () => {
  assert.doesNotThrow(() => new vm.Script(MENU_SCRIPT));
  assert.match(MENU_SCRIPT, /checkCurrentPlayingFileShouldUseTranscoding/);
  assert.match(MENU_SCRIPT, /checkNextPlayingFileShouldUseTranscodingAndPreTranscode/);
  assert.match(MENU_SCRIPT, /router\.afterEach/);
  assert.match(MENU_SCRIPT, /domObserver\.disconnect/);
  assert.match(ADMIN_HTML, /\/css\/app\.50e2fd8f\.css/);
  assert.match(ADMIN_HTML, /removeEventListener\("popstate"/);
  assert.match(ADMIN_HTML, /id="loudnessMethod" type="text" value="ebur128"[^>]*readonly/);
  assert.doesNotMatch(ADMIN_HTML, /<option value="loudnorm"/);
  assert.match(ADMIN_HTML, /loud\.method\|\|"ebur128"/);
});
