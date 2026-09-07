'use strict';

const fs = require('fs');
const path = require('path');

const MENU_SCRIPT = [
  '(function () {',
  '  "use strict";',
  '  function isMediaElement(element) { var tag = element && String(element.tagName || "").toLowerCase(); return tag === "audio" || tag === "video"; }',
  '  function isStrmStreamUrl(value) { try { var parsed = new URL(String(value || ""), window.location.href); return parsed.origin === window.location.origin && /^\\/api\\/media\\/stream(?:\\/|$)/.test(parsed.pathname); } catch (_) { return false; } }',
  '  function stripStrmCrossorigin(media) { if (!isMediaElement(media)) return; var source = media.querySelector && media.querySelector("source"); var value = media.getAttribute("src") || (source && source.getAttribute("src")); if (isStrmStreamUrl(value)) media.removeAttribute("crossorigin"); }',
  '  function beforeMediaInsert(parent, node) { if (!isMediaElement(parent)) return; var tag = node && String(node.tagName || "").toLowerCase(); var value = tag === "source" && node.getAttribute ? node.getAttribute("src") : ""; if (node && node.__kikoeruStrmSource || isStrmStreamUrl(value) || isStrmStreamUrl(parent.getAttribute("src"))) parent.removeAttribute("crossorigin"); }',
  '  function installStrmMediaCorsPatch() {',
  '    if (typeof Node === "function" && !Node.prototype.__kikoeruStrmMediaPatch) {',
  '      var appendChild = Node.prototype.appendChild, insertBefore = Node.prototype.insertBefore, replaceChild = Node.prototype.replaceChild;',
  '      Node.prototype.appendChild = function (node) { beforeMediaInsert(this, node); return appendChild.call(this, node); };',
  '      Node.prototype.insertBefore = function (node, reference) { beforeMediaInsert(this, node); return insertBefore.call(this, node, reference); };',
  '      Node.prototype.replaceChild = function (node, oldNode) { beforeMediaInsert(this, node); return replaceChild.call(this, node, oldNode); };',
  '      Object.defineProperty(Node.prototype, "__kikoeruStrmMediaPatch", { value: true, enumerable: false });',
  '    }',
  '    if (typeof Element === "function" && !Element.prototype.__kikoeruStrmSourcePatch) {',
  '      var setAttribute = Element.prototype.setAttribute;',
  '      Element.prototype.setAttribute = function (name, value) { if (String(name).toLowerCase() === "src" && String(this.tagName || "").toLowerCase() === "source" && isStrmStreamUrl(value)) { this.__kikoeruStrmSource = true; if (this.parentNode) beforeMediaInsert(this.parentNode, this); } if (String(name).toLowerCase() === "src" && isMediaElement(this) && isStrmStreamUrl(value)) this.removeAttribute("crossorigin"); return setAttribute.call(this, name, value); };',
  '      Object.defineProperty(Element.prototype, "__kikoeruStrmSourcePatch", { value: true, enumerable: false });',
  '    }',
  '    if (typeof HTMLMediaElement === "function" && !HTMLMediaElement.prototype.__kikoeruStrmLoadPatch) { var load = HTMLMediaElement.prototype.load; HTMLMediaElement.prototype.load = function () { stripStrmCrossorigin(this); return load.apply(this, arguments); }; Object.defineProperty(HTMLMediaElement.prototype, "__kikoeruStrmLoadPatch", { value: true, enumerable: false }); }',
  '    function scan() { var media = document.querySelectorAll ? document.querySelectorAll("audio,video") : []; for (var i = 0; i < media.length; i += 1) { stripStrmCrossorigin(media[i]); installStrmMediaRecovery(media[i]); } }',
  '    scan();',
  '    if (typeof MutationObserver === "function" && document.documentElement) { var observer = new MutationObserver(scan); observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "crossorigin"] }); }',
  '  }',
  '  installStrmMediaCorsPatch();',
  '  var STRM_RECOVERY_PAUSE_MS = 30000;',
  '  var STRM_RECOVERY_GRACE_MS = 2500;',
  '  var STRM_RECOVERY_COOLDOWN_MS = 10000;',
  '  var STRM_RECOVERY_MAX_ATTEMPTS = 1;',
  '  var STRM_RECOVERY_PROGRESS_EPSILON = 0.25;',
  '  function recoveryNow() { return Date.now(); }',
  '  function mediaPosition(media) { var value = Number(media && media.currentTime); return Number.isFinite(value) && value >= 0 ? value : 0; }',
  '  function mediaSourceValue(media) { if (!media) return ""; var direct = media.getAttribute && media.getAttribute("src"); if (direct) return direct; var source = media.querySelector && media.querySelector("source"); return source && source.getAttribute ? source.getAttribute("src") || "" : ""; }',
  '  function isStrmMediaSource(media) { return isStrmStreamUrl(mediaSourceValue(media) || (media && (media.currentSrc || media.src))); }',
  '  function clearRecoveryTimer(state) { if (state && state.timer !== null) { clearTimeout(state.timer); state.timer = null; } }',
  '  function clearLongPause(state) { clearRecoveryTimer(state); state.longPauseActive = false; state.waiting = false; state.stalled = false; state.errored = false; state.pauseAt = 0; }',
  '  function recoveryWaiting(media, state) { return Boolean(state.waiting || state.stalled || state.errored || Number(media.readyState) < 3 || Number(media.networkState) === 2); }',
  '  function finishRecovery(media, state) {',
  '    var restore = state.restore;',
  '    if (!restore || restore.done) return;',
  '    restore.done = true;',
  '    try { media.removeEventListener("loadedmetadata", restore.onReady); media.removeEventListener("canplay", restore.onReady); } catch (_) {}',
  '    state.longPauseActive = false; state.pauseAt = 0;',
  '    try { if (Number.isFinite(restore.position)) media.currentTime = restore.position; } catch (_) {}',
  '    if (restore.shouldPlay) { try { var promise = media.play(); if (promise && typeof promise.catch === "function") promise.catch(function () {}); } catch (_) {} }',
  '    state.restore = null;',
  '    state.recoveryInProgress = false;',
  '  }',
  '  function recoverStrmMedia(media, state) {',
  '    var now = recoveryNow();',
  '    if (!isStrmMediaSource(media) || !state.longPauseActive || state.recoveryInProgress || state.recoveryAttempts >= STRM_RECOVERY_MAX_ATTEMPTS || now - state.lastRecoveryAt < STRM_RECOVERY_COOLDOWN_MS) return false;',
  '    state.recoveryAttempts += 1;',
  '    state.lastRecoveryAt = now;',
  '    state.longPauseActive = false;',
  '    state.recoveryInProgress = true;',
  '    clearRecoveryTimer(state);',
  '    var restore = { position: mediaPosition(media), shouldPlay: true, done: false, onReady: null };',
  '    restore.onReady = function () { finishRecovery(media, state); };',
  '    state.restore = restore;',
  '    try { media.addEventListener("loadedmetadata", restore.onReady); media.addEventListener("canplay", restore.onReady); media.load(); } catch (_) { state.restore = null; state.recoveryInProgress = false; }',
  '    return true;',
  '  }',
  '  function checkStrmRecovery(media, state) {',
  '    state.timer = null;',
  '    if (!isStrmMediaSource(media) || !state.longPauseActive || state.recoveryInProgress) return;',
  '    var moved = mediaPosition(media) > state.pausePosition + STRM_RECOVERY_PROGRESS_EPSILON;',
  '    if (moved || !recoveryWaiting(media, state)) { clearLongPause(state); return; }',
  '    recoverStrmMedia(media, state);',
  '  }',
  '  function scheduleStrmRecoveryCheck(media, state, delay) { if (state.timer !== null || !state.longPauseActive) return; state.timer = setTimeout(function () { checkStrmRecovery(media, state); }, delay); }',
  '  function markStrmMediaIssue(media, state, field) { if (!isStrmMediaSource(media) || !state.longPauseActive || state.recoveryInProgress) return; state[field] = true; scheduleStrmRecoveryCheck(media, state, STRM_RECOVERY_GRACE_MS); }',
  '  function installStrmMediaRecovery(media) {',
  '    if (!isMediaElement(media) || !isStrmMediaSource(media) || media.__kikoeruStrmRecovery) return;',
  '    var state = { pauseAt: 0, pausePosition: 0, longPauseActive: false, waiting: false, stalled: false, errored: false, timer: null, recoveryAttempts: 0, lastRecoveryAt: 0, recoveryInProgress: false, restore: null };',
  '    try { Object.defineProperty(media, "__kikoeruStrmRecovery", { value: state, enumerable: false }); } catch (_) { media.__kikoeruStrmRecovery = state; }',
  '    media.addEventListener("pause", function () { if (!isStrmMediaSource(media) || state.recoveryInProgress) return; clearRecoveryTimer(state); state.pauseAt = recoveryNow(); state.pausePosition = mediaPosition(media); state.longPauseActive = false; state.waiting = false; state.stalled = false; state.errored = false; state.recoveryAttempts = 0; });',
  '    media.addEventListener("play", function () {',
  '      if (!isStrmMediaSource(media) || state.recoveryInProgress) return;',
  '      var elapsed = state.pauseAt ? recoveryNow() - state.pauseAt : 0;',
  '      if (!state.pauseAt || elapsed < STRM_RECOVERY_PAUSE_MS) { clearLongPause(state); return; }',
  '      state.longPauseActive = true; state.pausePosition = mediaPosition(media); state.waiting = false; state.stalled = false; state.errored = false; state.recoveryAttempts = 0;',
  '      scheduleStrmRecoveryCheck(media, state, STRM_RECOVERY_GRACE_MS);',
  '    });',
  '    media.addEventListener("waiting", function () { markStrmMediaIssue(media, state, "waiting"); });',
  '    media.addEventListener("stalled", function () { markStrmMediaIssue(media, state, "stalled"); });',
  '    media.addEventListener("error", function () { markStrmMediaIssue(media, state, "errored"); });',
  '  }',
  '  function hasToken() { try { return Boolean(localStorage.getItem("jwt-token")); } catch (_) { return false; } }',
  '  var retryTimer = null;',
  '  var domObserver = null;',
  '  function removeEntries() {',
  '    var entries = document.querySelectorAll("[data-kikoeru-strm-menu]");',
  '    for (var i = entries.length - 1; i >= 0; i -= 1) {',
  '      if (entries[i].parentNode) entries[i].parentNode.removeChild(entries[i]);',
  '    }',
  '  }',
  '  function setLabel(item) {',
  '    var labels = item.querySelectorAll(".q-item__section--main, .q-item__label");',
  '    if (labels.length) { labels[labels.length - 1].textContent = "STRM 设置"; return; }',
  '    var nodes = item.querySelectorAll("*");',
  '    for (var i = 0; i < nodes.length; i += 1) {',
  '      if (/高级设置|Advanced Settings/i.test(String(nodes[i].textContent || "").trim())) {',
  '        nodes[i].textContent = "STRM 设置"; return;',
  '      }',
  '    }',
  '    for (var j = nodes.length - 1; j >= 0; j -= 1) {',
  '      if (!nodes[j].children.length && String(nodes[j].textContent || "").trim()) {',
  '        nodes[j].textContent = "STRM 设置"; return;',
  '      }',
  '    }',
  '    item.textContent = "STRM 设置";',
  '  }',
  '  function isHomeItem(item) {',
  '    var href = item && item.getAttribute && item.getAttribute("href");',
  '    return href === "/" || href === "/admin";',
  '  }',
  '  function findAdvanced() {',
  '    return document.querySelector("a[href=\\"/admin/advanced\\"]") || document.querySelector("[href=\\"/admin/advanced\\"]");',
  '  }',
  '  function addEntry() {',
  '    if (!hasToken()) { removeEntries(); return; }',
  '    if (!document.body || document.querySelector("[data-kikoeru-strm-menu]")) return;',
  '    var advanced = findAdvanced();',
  '    if (!advanced || !advanced.parentNode) return;',
  '    var entry = advanced.cloneNode(true);',
  '    entry.setAttribute("href", "/admin/strm");',
  '    entry.setAttribute("data-kikoeru-strm-menu", "true");',
  '    entry.removeAttribute("aria-current");',
  '    if (entry.classList) { entry.classList.remove("q-router-link--active"); entry.classList.remove("q-router-link--exact-active"); }',
  '    setLabel(entry);',
  '    var parent = advanced.parentNode;',
  '    var before = advanced.nextSibling;',
  '    var children = parent.children || [];',
  '    var afterAdvanced = false;',
  '    for (var i = 0; i < children.length; i += 1) {',
  '      if (children[i] === advanced) { afterAdvanced = true; continue; }',
  '      if (afterAdvanced && isHomeItem(children[i])) { before = children[i]; break; }',
  '    }',
  '    parent.insertBefore(entry, before);',
  '  }',
  '  function scheduleRetry() {',
  '    if (retryTimer !== null) return;',
  '    retryTimer = setTimeout(function () { retryTimer = null; addEntry(); if (!document.querySelector("[data-kikoeru-strm-menu]")) scheduleRetry(); }, 1000);',
  '  }',
  '  function watchDom() {',
  '    if (typeof MutationObserver === "function" && !domObserver) {',
  '      var root = document.documentElement || document;',
  '      if (root) {',
  '        domObserver = new MutationObserver(function () { addEntry(); });',
  '        domObserver.observe(root, { childList: true, subtree: true });',
  '      }',
  '    }',
  '    scheduleRetry();',
  '  }',
  '  function boot() { addEntry(); watchDom(); }',
  '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();',
  '})();',
].join('\n');

const ADMIN_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>STRM 设置</title>',
  '<style>body{font:14px system-ui,sans-serif;margin:0;background:#f4f6f8;color:#202124}main{max-width:980px;margin:24px auto;padding:0 16px}section{background:#fff;border-radius:8px;padding:18px;margin:14px 0;box-shadow:0 1px 4px #0002}h1{margin-top:0}label{display:block;margin:10px 0}input,select,button{font:inherit;padding:7px}button{margin:6px 8px 6px 0;cursor:pointer}.danger{background:#b3261e;color:#fff;border:0;border-radius:4px}.muted{color:#5f6368}pre{white-space:pre-wrap;overflow:auto;background:#f7f7f7;padding:10px;border-radius:4px}.ok{color:#137333}.err{color:#b3261e}</style>',
  '</head><body><main><p><a href="/admin">← 返回管理后台</a></p><h1>STRM 设置</h1>',
  '<section><h2>运行状态</h2><div id="status" class="muted">加载中…</div><button id="refresh">刷新状态</button><pre id="metrics"></pre><details><summary>查看原始数据</summary><pre id="rawMetrics"></pre></details></section>',
  '<section><h2>安全配置</h2><label><input id="enabled" type="checkbox"> 启用 STRM 适配层</label>',
  '<label>播放交付方式 <select id="redirectMode"><option value="direct">冷启动响度后 302（推荐）</option><option value="local">永久本地兼容（手动选项，需完整冷下载）</option></select></label>',
  '<label>预取模式 <select id="preloadMode"><option value="observe">仅观测（默认）</option><option value="short-circuit">明确预取时短路（需确认）</option><option value="off">关闭</option></select></label>',
  '<label><input id="detectHead" type="checkbox"> 将 HEAD 作为预取信号（可能误判播放器探测）</label>',
  '<label>同一媒体直链复用 <input id="redirectCacheTtlMs" type="number" min="0" max="60" step="1"> 秒（0=每次重新请求 Helper）</label>',
  '</section>',
  '<section><h2>冷启动与响度策略</h2>',
  '<label><input id="coldCacheEnabled" type="checkbox"> 启用冷启动缓存</label>',
  '<label>缓存总容量 <input id="maxTotalBytes" type="number" min="0" step="0.1"> GiB</label>',
  '<label>单个文件上限 <input id="maxFileBytes" type="number" min="0" step="0.1"> MiB</label>',
  '<label>视频文件上限 <input id="maxVideoBytes" type="number" min="0" step="0.1"> MiB</label>',
  '<label>缓存最长保留 <input id="maxAgeMs" type="number" min="0" step="0.1"> 天</label>',
  '<label><input id="loudnessEnabled" type="checkbox"> 启用响度分析</label>',
  '<label><input id="loudnessAudioOnly" type="checkbox"> 仅对音频执行响度分析</label>',
  '<label>响度测量器 <select id="loudnessMethod"><option value="loudnorm">loudnorm（兼容输出）</option><option value="ebur128">ebur128（更快测量）</option></select></label>',
  '<p class="muted">本地模式提供永久本地兼容，首次冷启动需要完整下载到 .part，完成后改名为正式缓存并占用配置的磁盘空间；缓存按容量和保留天数清理。视频上限设为 0 表示不缓存视频。</p>',
  '<p class="muted">直接模式首次请求会完整冷下载并在本地完成响度准备，首播先返回本地文件；响度就绪后后续播放和 Range 返回 302，媒体正文由客户端从 CDN 获取，适合已验证兼容性的场景。</p>',
  '<button id="save">保存配置</button> <span id="message" class="muted"></span></section>',
  '<section><h2>缓存</h2><p class="muted">清理只删除适配层本地缓存，不删除媒体目录或远端文件。</p><button id="cleanup" class="danger">二次确认后清理缓存</button></section></main>',
  '<script>(function(){ "use strict"; var token=""; try{var rawToken=localStorage.getItem("jwt-token")||"";var quasarStringPrefix="__q_strn|";token=rawToken.indexOf(quasarStringPrefix)===0?rawToken.slice(quasarStringPrefix.length):rawToken;}catch(_){}',
  'function headers(json){var h={};if(token)h.Authorization="Bearer "+token;if(json)h["Content-Type"]="application/json";return h;}',
  'function request(url,opts){opts=opts||{};opts.headers=Object.assign(headers(Boolean(opts.body)),opts.headers||{});return fetch(url,opts).then(function(r){return r.text().then(function(t){var d={};try{d=JSON.parse(t);}catch(_){d={message:t};}if(!r.ok)throw Object.assign(new Error(d.error||d.message||("HTTP "+r.status)),{status:r.status,data:d});return d;});});}',
  'function number(value){var n=Number(value);return Number.isFinite(n)?n:0;}',
  'var BYTES_PER_MIB=1024*1024,BYTES_PER_GIB=1024*BYTES_PER_MIB,MS_PER_SECOND=1000,MS_PER_DAY=24*60*60*1000;',
  'function displayUnit(value,unit,fallback){var n=Number(value);return String(Number.isFinite(n)?Math.round(n/unit*1000)/1000:fallback);}',
  'function inputUnit(id,unit){return Math.max(0,Math.round(number(document.getElementById(id).value)*unit));}',
  'function bytes(value){var n=Math.max(0,number(value)),u=["B","KB","MB","GB","TB"],i=0;while(n>=1024&&i<u.length-1){n/=1024;i+=1;}return (i===0?String(Math.round(n)):n.toFixed(n>=100?0:n>=10?1:2))+" "+u[i];}',
  'function duration(value){var n=Math.max(0,number(value));if(n<1000)return n+" ms";if(n<60000)return (n/1000).toFixed(1)+" 秒";return Math.ceil(n/60000)+" 分钟";}',
  'function readableMetrics(d){var q=d.queue||{},r=d.redirect||{},m=d.metrics||{},b=r.budget||{},g=d.sharedHelper||{};return ["播放结果","  对客户端返回 302（CDN 直连）："+number(m.hotRedirect)+" 次","  本地文件 200（服务端缓存）："+number(m.coldLocal)+" 次","  本地播放模式："+number(m.localPlayback)+" 次","  预加载跳过 204："+number(m.preloadSkip)+" 次","","Helper 地址解析（当前进程）","  已发起："+number(r.started)+" 次","  已完成："+number(r.completed)+" 次","  当前排队："+number(r.pending)+" 个","  进行中："+number(r.running)+" 个","  队列拒绝："+number(r.rejected)+" 次","  已复用 CDN 地址："+number(r.cacheHits)+" 次","","Helper 全局预算（含扫描子进程）","  本分钟："+number(g.minuteUsed)+" / "+number(g.minuteUsed+g.minuteRemaining)+" 次","  本小时："+number(g.hourUsed)+" / "+number(g.hourUsed+g.hourRemaining)+" 次","  下次可用："+(number(g.nextAvailableInMs)>0?duration(g.nextAvailableInMs):"立即"),"","缓存与响度任务","  正在下载："+number(d.activeDownloads)+" 个（临时 .part："+number(d.activePartFiles)+" 个）","  正在响度分析："+number(d.activeLoudness)+" 个","","限流状态","  本分钟："+number(b.minuteUsed)+" / "+number(r.perMinute)+" 次","  本小时："+number(b.hourUsed)+" / "+number(r.perHour)+" 次","  429："+number(r.rateLimited429)+" 次","  冷却："+(number(r.cooldownRemainingMs)>0?duration(r.cooldownRemainingMs):"无"),"","时长探测队列（当前进程）","  排队："+number(q.pending)+" 个","  进行中："+(q.running?"是":"否"),"  已完成："+number(q.completed)+" 次","  失败："+number(q.failed)+" 次","","说明：direct 首次冷启动先准备本地缓存与响度，之后播放和 Range 返回 CDN 302；local 始终提供本地兼容；Helper 地址解析与扫描共用全局预算。"].join("\\n");}',
  'function showError(e){var m=document.getElementById("message");m.className="err";m.textContent=e.message||String(e);}',
  'function load(){request("/api/strm/status").then(function(d){var c=d.config||{},g=c.preloadGuard||{},r=d.config&&d.config.redirectResolve||{},cold=c.coldCache||{},loud=c.loudness||{};document.getElementById("enabled").checked=Boolean(d.enabled);document.getElementById("redirectMode").value=c.redirectMode||"direct";document.getElementById("preloadMode").value=g.mode||"observe";document.getElementById("detectHead").checked=Boolean(g.detectHead);document.getElementById("redirectCacheTtlMs").value=displayUnit(r.cacheTtlMs,MS_PER_SECOND,0);document.getElementById("coldCacheEnabled").checked=cold.enabled!==false;document.getElementById("maxTotalBytes").value=displayUnit(cold.maxTotalBytes,BYTES_PER_GIB,20);document.getElementById("maxFileBytes").value=displayUnit(cold.maxFileBytes,BYTES_PER_MIB,2048);document.getElementById("maxVideoBytes").value=displayUnit(cold.maxVideoBytes,BYTES_PER_MIB,512);document.getElementById("maxAgeMs").value=displayUnit(cold.maxAgeMs,MS_PER_DAY,30);document.getElementById("loudnessEnabled").checked=loud.enabled!==false;document.getElementById("loudnessAudioOnly").checked=loud.audioOnly!==false;document.getElementById("loudnessMethod").value=loud.method||"loudnorm";document.getElementById("status").innerHTML="<span class=\\"ok\\">已连接</span> · STRM 记录 "+(d.records||[]).length+" · 缓存 "+bytes(d.cacheBytes);document.getElementById("metrics").textContent=readableMetrics(d);document.getElementById("rawMetrics").textContent=JSON.stringify({queue:d.queue,redirect:d.redirect,metrics:d.metrics},null,2);}).catch(showError);}',
  'document.getElementById("refresh").onclick=load;',
  'document.getElementById("save").onclick=function(){var body={enabled:document.getElementById("enabled").checked,redirectMode:document.getElementById("redirectMode").value,preloadGuard:{mode:document.getElementById("preloadMode").value,detectHead:document.getElementById("detectHead").checked},redirectResolve:{cacheTtlMs:inputUnit("redirectCacheTtlMs",MS_PER_SECOND)},coldCache:{enabled:document.getElementById("coldCacheEnabled").checked,maxTotalBytes:inputUnit("maxTotalBytes",BYTES_PER_GIB),maxFileBytes:inputUnit("maxFileBytes",BYTES_PER_MIB),maxVideoBytes:inputUnit("maxVideoBytes",BYTES_PER_MIB),maxAgeMs:inputUnit("maxAgeMs",MS_PER_DAY)},loudness:{enabled:document.getElementById("loudnessEnabled").checked,audioOnly:document.getElementById("loudnessAudioOnly").checked,method:document.getElementById("loudnessMethod").value}};request("/api/admin/strm",{method:"PUT",body:JSON.stringify(body)}).then(function(){var m=document.getElementById("message");m.className="ok";m.textContent="已保存";load();}).catch(showError);};',
  'document.getElementById("cleanup").onclick=function(){if(!window.confirm("确认清理适配层缓存？此操作不可立即恢复。"))return;request("/api/admin/strm/cleanup",{method:"POST"}).then(function(){var m=document.getElementById("message");m.className="ok";m.textContent="清理完成";load();}).catch(showError);};load();',
  '})();</script></body></html>',
].join('');

function pathnameOf(req) {
  return String(req && req.url || '').split('?', 1)[0];
}

function createAdminUiMiddleware() {
  return function strmAdminUi(req, res, next) {
    const pathname = pathnameOf(req);
    if (req.method === 'GET' && (pathname === '/admin/strm' || pathname === '/admin/strm/')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(ADMIN_HTML);
    }
    if (req.method === 'GET' && pathname === '/admin/strm-menu.js') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(MENU_SCRIPT);
    }
    return next();
  };
}

function patchStaticForMenu(express) {
  if (!express || typeof express.static !== 'function' || express.static.__strmMenuPatched) return;
  const originalStatic = express.static;
  function patchedStatic(root, options) {
    const middleware = originalStatic(root, options);
    const indexPath = path.join(String(root), 'index.html');
    let indexHtml = null;
    try {
      if (fs.existsSync(indexPath)) {
        const source = fs.readFileSync(indexPath, 'utf8');
        const tag = '<script src="/admin/strm-menu.js"></script>';
        indexHtml = source.includes(tag) ? source : source.replace(/<head>/i, '<head>' + tag);
      }
    } catch {
      indexHtml = null;
    }
    return function strmStatic(req, res, next) {
      const pathname = pathnameOf(req);
      if (indexHtml && req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(indexHtml);
      }
      return middleware(req, res, next);
    };
  }
  Object.assign(patchedStatic, originalStatic);
  patchedStatic.__strmMenuPatched = true;
  express.static = patchedStatic;
}

function installAdminUiHooks() {
  let express;
  try { express = require('express'); } catch { return false; }
  if (!express || !express.application || express.application.__strmAdminUiPatched) return false;
  patchStaticForMenu(express);
  const originalUse = express.application.use;
  express.application.use = function strmApplicationUse(...args) {
    if (!this.__strmAdminUiInserted) {
      this.__strmAdminUiInserted = true;
      originalUse.call(this, createAdminUiMiddleware());
    }
    return originalUse.apply(this, args);
  };
  Object.defineProperty(express.application, '__strmAdminUiPatched', { value: true, enumerable: false });
  return true;
}

module.exports = {
  ADMIN_HTML,
  MENU_SCRIPT,
  createAdminUiMiddleware,
  installAdminUiHooks,
  pathnameOf,
};
