'use strict';

// Requires native-container-0617.js with FIXTURE_BROWSER=1 and its two ports
// published on 127.0.0.1:19088/19081. Credentials and media are synthetic.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const browserEnv = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete browserEnv[key];
  browserEnv.NO_PROXY = browserEnv.no_proxy = '*';
  const browser = await chromium.launch({
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    headless: true, env: browserEnv,
    args: ['--no-sandbox', '--no-proxy-server', '--proxy-bypass-list=*',
      '--autoplay-policy=no-user-gesture-required', '--host-resolver-rules=MAP fixture.115cdn.net 127.0.0.1'],
  });
  try {
    const page = await browser.newPage();
    const corsErrors = [], deliveries = [];
    page.on('console', message => {
      if (/MediaElementAudioSource|CORS policy/.test(message.text())) corsErrors.push(message.text());
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.hostname === 'fixture.115cdn.net') deliveries.push(response.status());
    });
    await page.goto('http://127.0.0.1:19088/login');
    const inputs = page.locator('form input');
    await inputs.nth(0).fill('admin');
    await inputs.nth(1).fill('fixture-admin-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
    async function findPlayer() {
      await page.waitForFunction(() => {
        function walk(vm) {
          if (vm?.$options?.name === 'AudioElement') return vm;
          for (const child of vm?.$children || []) { const found = walk(child); if (found) return found; }
        }
        window.reviewPlayer = walk(document.querySelector('#q-app')?.__vue__);
        return Boolean(window.reviewPlayer?._computedWatchers?.source?.__strmSourceGuard);
      });
    }
    async function select(strm) {
      assert.equal(await page.evaluate(async isStrm => {
        const vm = window.reviewPlayer, token = vm.$q.localStorage.getItem('jwt-token');
        const response = await fetch('/api/tracks/1', { headers: { Authorization: 'Bearer ' + token } });
        const flatten = items => items.flatMap(item => item.children ? flatten(item.children) : [item]);
        const track = flatten(await response.json()).find(item => isStrm ? item.isStrm : !item.isStrm && item.title.endsWith('.wav'));
        vm.$store.commit('AudioPlayer/SET_QUEUE', { workId: 1, queue: [track], index: 0, resetPlaying: false });
        return Boolean(track);
      }, strm), true);
      await page.waitForFunction(isStrm => window.reviewPlayer.source.includes('strm=1') === isStrm, strm);
    }
    async function play() {
      // Plyr can leave play() pending when its source watcher reloads media.
      // Verify actual playback instead of trusting that Promise.
      await page.evaluate(() => { window.reviewPlayer.player.play()?.catch(() => undefined); });
      await page.waitForFunction(() => window.reviewPlayer.player.media.currentTime > 0.3);
    }
    await findPlayer();
    await page.evaluate(() => window.reviewPlayer.$store.commit('AudioPlayer/SET_ENABLE_VISUALIZER', true));
    await page.reload();
    await findPlayer();
    await select(true);
    await page.waitForFunction(() => window.reviewPlayer.source.includes('strm_local=1'));
    await page.locator('body').click({ position: { x: 400, y: 10 } });
    await page.evaluate(() => window.reviewPlayer.$store.state.AudioPlayer.audioAnalyser.audioCtx.resume());
    await play();
    const visual = await page.evaluate(() => {
      const vm = window.reviewPlayer, analyser = vm.$store.state.AudioPlayer.audioAnalyser.left;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return { local: vm.source.includes('strm_local=1'), cors: vm.player.media.getAttribute('crossorigin'), amplitude: Math.max(...samples.map(Math.abs)) };
    });
    assert.ok(visual.amplitude > 0.01, JSON.stringify(visual));
    await page.evaluate(() => window.reviewPlayer.$store.commit('AudioPlayer/SET_ENABLE_VISUALIZER', false));
    assert.equal(await page.evaluate(() => window.reviewPlayer.source.includes('strm_local=1')), true,
      'an already connected Web Audio graph still needs local delivery until reload');
    await select(false);
    await play();
    assert.equal(await page.evaluate(() => window.reviewPlayer.player.media.getAttribute('crossorigin')), 'anonymous');
    await page.reload();
    await findPlayer();
    await select(true);
    await page.waitForFunction(() => !window.reviewPlayer.source.includes('strm_local=1'));
    await play();
    const direct = await page.evaluate(() => ({ local: window.reviewPlayer.source.includes('strm_local=1'), cors: window.reviewPlayer.player.media.getAttribute('crossorigin'), time: window.reviewPlayer.player.media.currentTime }));
    assert.equal(direct.cors, null);
    assert.ok(deliveries.some(status => status === 200 || status === 206));
    await select(false);
    await play();
    assert.equal(await page.evaluate(() => window.reviewPlayer.player.media.getAttribute('crossorigin')), 'anonymous', 'native CORS restored after direct STRM');
    assert.deepEqual(corsErrors, []);
    console.log(JSON.stringify({ visual, direct, nativeCorsRestored: true, corsErrors }, null, 2));
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
