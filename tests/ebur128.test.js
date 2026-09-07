'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const adapterDir = path.resolve(__dirname, '../patches/0.6.15/strm-adapter');
const {
  StrmCacheManager,
  defaultRunLoudnorm,
  defaultRunLoudness,
  normalizeLimits,
  parseEbur128Result,
} = require(path.join(adapterDir, 'cache-manager'));
const { StrmStateStore, makeRecordKey } = require(path.join(adapterDir, 'state-store'));

const ebur128Summary = [
  '[Parsed_ebur128_0 @ 0xfixture] Summary:',
  '',
  ' Integrated loudness:',
  ' I:        -23.0 LUFS',
  ' Threshold: -33.0 LUFS',
  '',
  ' Loudness range:',
  ' LRA:        5.0 LU',
  ' Threshold: -43.0 LUFS',
  ' LRA low:   -26.2 LUFS',
  ' LRA high:  -21.2 LUFS',
  '',
  ' Sample peak:',
  ' Peak:       -8.9 dBFS',
  '',
  ' True peak:',
  ' Peak:       -8.7 dBFS',
].join('\n');

function assertAudioOnlyArgs(args, filter) {
  assert.equal(args[args.indexOf('-map') + 1], '0:a:0');
  assert.equal(args.includes('-vn'), true);
  assert.equal(args.includes('-sn'), true);
  assert.equal(args.includes('-dn'), true);
  assert.equal(args[args.indexOf('-af') + 1], filter);
}

test('loudnorm remains the default and uses only the first audio stream', async () => {
  let receivedArgs;
  const result = await defaultRunLoudnorm('/fixture.mka', {
    execFileImpl: async (_command, args) => {
      receivedArgs = args;
      return { stderr: 'info\n{"input_i":"-20.0","output_i":"-16.0"}\n' };
    },
  });

  assert.equal(normalizeLimits().loudnessMethod, 'loudnorm');
  assert.deepEqual(result, { input_i: '-20.0', output_i: '-16.0' });
  assertAudioOnlyArgs(receivedArgs, 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json');
});

test('ebur128 parses Summary metrics without fabricating loudnorm output metrics', async () => {
  let receivedArgs;
  const result = await defaultRunLoudness('/fixture.mka', {
    loudnessMethod: 'ebur128',
    execFileImpl: async (_command, args) => {
      receivedArgs = args;
      return { stderr: `ffmpeg info\n${ebur128Summary}\n` };
    },
  });

  assert.equal(normalizeLimits({ loudnessMethod: 'ebur128' }).loudnessMethod, 'ebur128');
  assert.deepEqual(result, {
    input_i: '-23.0',
    input_thresh: '-33.0',
    input_lra: '5.0',
    input_tp: '-8.7',
    output_i: null,
    output_tp: null,
    output_lra: null,
    output_thresh: null,
    target_offset: null,
    normalization_type: null,
  });
  assertAudioOnlyArgs(receivedArgs, 'ebur128=framelog=quiet:peak=true');
});

test('ebur128 parse failures expose only safe error codes', () => {
  assert.throws(() => parseEbur128Result('ffmpeg output without a summary'), error => {
    assert.equal(error.code, 'EBUR128_RESULT_MISSING');
    assert.equal(error.message.includes('ffmpeg output'), false);
    return true;
  });
  assert.throws(() => parseEbur128Result('Summary:\n Integrated loudness:\n I: -23.0 LUFS'), error => {
    assert.equal(error.code, 'EBUR128_RESULT_INVALID');
    return true;
  });
});

test('cache manager dispatches loudnessMethod, records it, and invalidates stale ready results', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-ebur128-'));
  const cachePath = path.join(temp, 'cached.flac');
  const state = new StrmStateStore(path.join(temp, 'state.json'));
  await fs.promises.writeFile(cachePath, 'complete local media');
  const key = makeRecordKey('fixture', 'RJ0001/cached.flac.strm');
  const pointerInfo = {
    key,
    rootFolder: 'fixture',
    relativePath: 'RJ0001/cached.flac.strm',
    pointerFingerprint: 'fixture-pointer',
    pointerMtimeMs: Date.now(),
    mediaExt: '.flac',
    isVideo: false,
  };
  await state.upsert(key, {
    rootFolder: pointerInfo.rootFolder,
    relativePath: pointerInfo.relativePath,
    pointerFingerprint: pointerInfo.pointerFingerprint,
    downloadReady: true,
    cachePath,
    cacheBytes: 20,
    loudnessReady: true,
    loudnessStatus: 'ready',
    loudnessMethod: 'loudnorm',
    loudnorm: { input_i: '-20.0', output_i: '-16.0' },
  });

  const calls = [];
  const manager = new StrmCacheManager({
    store: state,
    config: { rootDir: temp, cleanupIntervalMs: 0, loudnessMethod: 'ebur128' },
    runLoudness: async (_filePath, options) => {
      calls.push(options);
      return parseEbur128Result(ebur128Summary);
    },
  });
  try {
    const invalidated = await manager.get(pointerInfo);
    assert.equal(invalidated.loudnessReady, false);
    assert.equal(invalidated.loudnessStatus, 'pending');
    assert.equal(invalidated.loudnessMethod, 'ebur128');
    assert.equal(invalidated.loudnorm, null);

    await manager.analyze(pointerInfo, { loudnessTimeoutMs: 1234 });
    const ready = await state.get(key);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].loudnessMethod, 'ebur128');
    assert.equal(calls[0].method, 'ebur128');
    assert.equal(ready.loudnessReady, true);
    assert.equal(ready.loudnessMethod, 'ebur128');
    assert.equal(ready.loudnorm.input_tp, '-8.7');
    assert.equal(ready.loudnorm.output_i, null);
  } finally {
    manager.close();
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
