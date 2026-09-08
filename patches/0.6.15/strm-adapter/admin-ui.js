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
  '  var STRM_ROUTE_FLAG = "__kikoeruStrmVueRouteInstalled";',
  '  var STRM_COMPONENT_FLAG = "__kikoeruStrmAdminComponent";',
  '  var retryTimer = null;',
  '  var domObserver = null;',
  '  function appVue() {',
  '    try { var app = document.getElementById && document.getElementById("q-app"); return app && app.__vue__; } catch (_) { return null; }',
  '  }',
  '  function walkVue(root, visit, seen) {',
  '    if (!root || typeof root !== "object") return null;',
  '    seen = seen || [];',
  '    if (seen.indexOf(root) !== -1) return null;',
  '    seen.push(root);',
  '    var result = visit(root);',
  '    if (result) return result;',
  '    var children = root.$children || [];',
  '    for (var i = 0; i < children.length; i += 1) { result = walkVue(children[i], visit, seen); if (result) return result; }',
  '    return null;',
  '  }',
  '  function findRouter(root) { return walkVue(root, function (vm) { return vm.$router || null; }); }',
  '  function findDashboardLinks(root) {',
  '    return walkVue(root, function (vm) {',
  '      var links = vm.links;',
  '      if (!Array.isArray(links)) return null;',
  '      for (var i = 0; i < links.length; i += 1) if (links[i] && links[i].path === "/admin/advanced") return links;',
  '      return null;',
  '    });',
  '  }',
  '  function strmComponent() {',
  '    if (window[STRM_COMPONENT_FLAG]) return window[STRM_COMPONENT_FLAG];',
  '    var component = {',
  '      name: "KikoeruStrmAdminPage",',
  '      render: function (h) { return h("div", { class: ["q-page", "q-pa-md"], attrs: { id: "strm-admin-content" } }); },',
  '      mounted: function () {',
  '        var vm = this, request = null;',
  '        try { request = window.fetch || (typeof fetch === "function" && fetch); } catch (_) {}',
  '        if (!request || typeof DOMParser !== "function") return;',
  '        request.call(window, "/api/admin/strm-fragment", { headers: { Accept: "text/html" } }).then(function (response) {',
  '          if (!response || ("ok" in response && !response.ok)) throw new Error("STRM 设置页面加载失败");',
  '          return response.text();',
  '        }).then(function (html) {',
  '          if (!vm.$el) return;',
  '          var parsed = new DOMParser().parseFromString(html, "text/html");',
  '          var source = parsed && parsed.querySelector ? parsed.querySelector("#strm-admin-content") : null;',
  '          if (!source) throw new Error("STRM 设置页面结构无效");',
  '          var styleSource = parsed.querySelector ? parsed.querySelector("style[data-strm-admin-style]") : null;',
  '          var head = document.head || document.documentElement;',
  '          if (styleSource && head && document.createElement && !(document.querySelector && document.querySelector("style[data-kikoeru-strm-style]"))) {',
  '            var style = document.createElement("style"); style.setAttribute("data-kikoeru-strm-style", "true"); style.textContent = styleSource.textContent || styleSource.text || ""; head.appendChild(style);',
  '          }',
  '          vm.$el.innerHTML = source.innerHTML || "";',
  '          var scriptSource = parsed.querySelector ? parsed.querySelector("script[data-strm-admin-script]") : null;',
  '          var target = document.body || document.documentElement;',
  '          if (scriptSource && target && document.createElement) {',
  '            var script = document.createElement("script"); script.setAttribute("data-kikoeru-strm-runtime", "true"); script.text = scriptSource.textContent || scriptSource.text || ""; target.appendChild(script); vm.__strmRuntimeScript = script;',
  '          }',
  '        }).catch(function () {});',
  '      },',
  '      beforeDestroy: function () {',
  '        if (this.__strmRuntimeScript && this.__strmRuntimeScript.parentNode) this.__strmRuntimeScript.parentNode.removeChild(this.__strmRuntimeScript);',
  '        this.__strmRuntimeScript = null;',
  '        try { if (window.__kikoeruStrmAdminRuntime) delete window.__kikoeruStrmAdminRuntime; } catch (_) {}',
  '      }',
  '    };',
  '    window[STRM_COMPONENT_FLAG] = component;',
  '    return component;',
  '  }',
  '  function adminRoute(routes) {',
  '    for (var i = 0; i < routes.length; i += 1) if (routes[i] && (routes[i].path === "/admin" || routes[i].path === "admin")) return { route: routes[i], index: i };',
  '    return null;',
  '  }',
  '  function hasStrmChild(children) { for (var i = 0; i < children.length; i += 1) if (children[i] && (children[i].path === "strm" || children[i].path === "/strm")) return true; return false; }',
  '  function installRoute(router, component) {',
  '    if (!router || !router.options || !Array.isArray(router.options.routes)) return false;',
  '    var routes = router.options.routes, found = adminRoute(routes);',
  '    if (!found) return false;',
  '    if (hasStrmChild(found.route.children || [])) return true;',
  '    var nextRoutes = routes.slice(), children = (found.route.children || []).slice();',
  '    children.push({ path: "strm", component: component });',
  '    nextRoutes[found.index] = Object.assign({}, found.route, { children: children });',
  '    var RouterCtor = router.constructor, fresh = new RouterCtor(Object.assign({}, router.options, { routes: nextRoutes }));',
  '    router.matcher = fresh.matcher;',
  '    if (router.history && typeof router.history.transitionTo === "function") {',
  '      var current = typeof router.history.getCurrentLocation === "function" ? router.history.getCurrentLocation() : "/";',
  '      router.history.transitionTo(current);',
  '    }',
  '    return true;',
  '  }',
  '  function installLinks(links) {',
  '    if (!Array.isArray(links)) return false;',
  '    for (var i = 0; i < links.length; i += 1) if (links[i] && links[i].path === "/admin/strm") return true;',
  '    var index = -1;',
  '    for (var j = 0; j < links.length; j += 1) if (links[j] && links[j].path === "/admin/advanced") { index = j; break; }',
  '    if (index < 0) return false;',
  '    links.splice(index + 1, 0, { title: "STRM 设置", icon: "tune", path: "/admin/strm" });',
  '    return true;',
  '  }',
  '  function installVueIntegration() {',
  '    var root = appVue();',
  '    if (!root) return false;',
  '    var state = window[STRM_ROUTE_FLAG] || (window[STRM_ROUTE_FLAG] = { route: false, links: false });',
  '    var router = findRouter(root), component = strmComponent();',
  '    if (!state.route && router) state.route = installRoute(router, component);',
  '    if (!state.links) state.links = installLinks(findDashboardLinks(root));',
  '    return Boolean(state.route && state.links);',
  '  }',
  '  function scheduleRetry() {',
  '    if (retryTimer !== null) return;',
  '    retryTimer = setTimeout(function () { retryTimer = null; if (!installVueIntegration()) scheduleRetry(); }, 1000);',
  '  }',
  '  function watchDom() {',
  '    if (typeof MutationObserver === "function" && !domObserver) {',
  '      var root = document.documentElement || document;',
  '      if (root) { domObserver = new MutationObserver(function () { if (!installVueIntegration()) scheduleRetry(); }); domObserver.observe(root, { childList: true, subtree: true }); }',
  '    }',
  '    scheduleRetry();',
  '  }',
  '  function boot() { if (!installVueIntegration()) watchDom(); }',
  '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();',
  '})();',
].join('\n');

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <link rel="stylesheet" href="/css/app.ab4be0f1.css" data-kikoeru-upstream-css>
  <title>STRM 设置 · 仪表盘</title>
  <style data-strm-admin-style>
    :root{--strm-primary:#1976d2;--strm-primary-dark:#1565c0;--strm-bg:#f5f5f5;--strm-surface:#fff;--strm-text:#212121;--strm-muted:#6b7280;--strm-border:#e0e0e0;--strm-danger:#c62828;--strm-success:#2e7d32;--strm-header:#000}
    *{box-sizing:border-box}
    html,body,#q-app{min-height:100%;margin:0}
    html,body{overflow-x:hidden}
    body{font-family:Roboto,"Noto Sans SC",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;background:var(--strm-bg);color:var(--strm-text)}
    a{color:inherit;text-decoration:none}
    button,input,select{font:inherit}
    .q-layout{position:relative;min-height:100vh;width:100%;background:var(--strm-bg)}
    .q-header{position:fixed;top:0;left:0;right:0;z-index:20;width:100%;height:50px;background:var(--strm-header);color:#fff;box-shadow:0 2px 4px rgba(0,0,0,.22)}
    .q-layout__section--marginal{min-height:50px}.bg-black{background:#000}.absolute-top{top:0}
    .q-toolbar{display:flex;align-items:center;min-height:50px;padding:0 12px;gap:10px}
    .q-toolbar-title{flex:1;min-width:0;font-size:20px;font-weight:400;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .q-btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border:0;border-radius:4px;padding:0 16px;background:var(--strm-primary);color:#fff;cursor:pointer;transition:background .15s,box-shadow .15s;line-height:1.2}
    .q-btn:hover{background:var(--strm-primary-dark);box-shadow:0 1px 4px rgba(0,0,0,.24)}
    .q-btn:focus-visible,.q-item:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #90caf9;outline-offset:2px}
    .q-btn--flat{background:transparent;color:inherit;box-shadow:none;padding:0}
    .q-btn--flat:hover{background:rgba(255,255,255,.13);box-shadow:none}
    .q-btn--negative{background:var(--strm-danger)}
    .q-btn--negative:hover{background:#a51f1f}
    .q-btn--dense{min-height:32px;padding:0 12px}
    .q-btn--round{width:36px;padding:0;border-radius:50%}
    .material-icons{font-family:"Material Icons",sans-serif;font-size:22px;font-weight:normal;font-style:normal;line-height:1;letter-spacing:normal;text-transform:none;display:inline-block;white-space:nowrap;word-wrap:normal;direction:ltr;-webkit-font-feature-settings:"liga";-webkit-font-smoothing:antialiased}
    .q-drawer{position:fixed;z-index:15;top:50px;bottom:0;left:0;width:57px;overflow-y:auto;overflow-x:hidden;background:var(--strm-surface);border-right:1px solid var(--strm-border);box-shadow:2px 0 4px rgba(0,0,0,.08);transition:width .18s ease,transform .18s ease}
    .q-drawer:hover,.q-drawer.strm-drawer--open{width:200px}
    .q-list{padding:8px 0}
    .q-item{display:flex;align-items:center;justify-content:center;min-height:48px;padding:8px 16px;gap:16px;color:var(--strm-text);cursor:pointer;transition:background .15s,color .15s;white-space:nowrap}
    .q-drawer:hover .q-item,.q-drawer.strm-drawer--open .q-item{justify-content:flex-start}
    .q-item__section--main{display:none}.q-drawer:hover .q-item__section--main,.q-drawer.strm-drawer--open .q-item__section--main{display:block}
    .q-item:hover{background:rgba(25,118,210,.08)}
    .q-item--active,.q-router-link--active{color:var(--strm-primary);font-weight:700;background:rgba(25,118,210,.12)}
    .q-item__section--avatar{display:flex;align-items:center;justify-content:center;width:24px;min-width:24px;color:inherit}
    .q-item__section--main{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .q-page-container{min-height:100vh;margin-left:57px;padding-top:50px}
    .q-page{width:100%;max-width:1180px;margin:0 auto;padding:24px}
    .q-pa-md{padding:24px}
    .strm-breadcrumb{display:flex;align-items:center;gap:8px;margin:0 0 18px;color:var(--strm-muted);font-size:13px}
    .strm-breadcrumb strong{color:var(--strm-text);font-size:14px}
    .strm-card{margin:0 0 16px;border:1px solid var(--strm-border);border-radius:4px;background:var(--strm-surface);box-shadow:0 1px 3px rgba(0,0,0,.12);overflow:hidden}
    .q-card__section{padding:20px}
    .q-card__section--vert{display:block}
    .q-card__actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 20px;border-top:1px solid var(--strm-border)}
    .strm-card-title{margin:0 0 4px;font-size:18px;line-height:1.35;font-weight:500}
    .strm-card-subtitle{margin:0;color:var(--strm-muted);font-size:13px}
    .strm-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
    .strm-status-line{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px;font-size:15px}
    .strm-dot{width:9px;height:9px;border-radius:50%;background:var(--strm-success);display:inline-block}
    .strm-dot.err{background:var(--strm-danger)}
    .strm-cache-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}
    .strm-stat{min-width:0;padding:12px;border-radius:4px;background:rgba(25,118,210,.06)}
    .strm-stat-label{display:block;color:var(--strm-muted);font-size:12px}
    .strm-stat-value{display:block;margin-top:2px;font-size:17px;font-weight:600;overflow-wrap:anywhere}
    .strm-state-ok{color:var(--strm-success)}
    .strm-state-over{color:var(--strm-danger)}
    .strm-state-off{color:var(--strm-muted)}
    .strm-progress{height:6px;margin-top:14px;border-radius:4px;background:#e3e8ef;overflow:hidden}
    .strm-progress>span{display:block;width:0;height:100%;border-radius:inherit;background:var(--strm-primary);transition:width .2s}
    .strm-progress>span.over{background:var(--strm-danger)}
    .strm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .strm-field{display:flex;flex-direction:column;gap:5px;min-width:0;color:var(--strm-text);font-size:13px}
    .strm-field input:not([type=checkbox]),.strm-field select{width:100%;min-height:38px;padding:7px 10px;border:1px solid #bdbdbd;border-radius:4px;background:var(--strm-surface);color:var(--strm-text)}
    .strm-field input:not([type=checkbox]):hover,.strm-field select:hover{border-color:#757575}
    .strm-check{display:flex;align-items:flex-start;gap:9px;min-width:0;color:var(--strm-text);font-size:14px;cursor:pointer}
    .strm-check input{width:18px;height:18px;flex:0 0 auto;margin:2px 0 0;accent-color:var(--strm-primary)}
    .strm-help{margin:14px 0 0;color:var(--strm-muted);font-size:13px;line-height:1.6}
    .muted{color:var(--strm-muted)}
    .ok{color:var(--strm-success)}
    .err{color:var(--strm-danger)}
    .strm-message{min-height:22px;display:inline-flex;align-items:center;font-size:13px}
    pre{max-width:100%;margin:16px 0 0;padding:12px;border-radius:4px;background:rgba(0,0,0,.035);color:var(--strm-text);white-space:pre-wrap;overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    details{margin-top:14px;color:var(--strm-muted)}
    summary{cursor:pointer}
    .strm-scrim{display:none}
    @media (max-width:700px){.q-page{padding:16px}.q-pa-md{padding:16px}.strm-grid{grid-template-columns:minmax(0,1fr)}}
    @media (max-width:500px){.q-drawer{display:block;width:200px;transform:translateX(-100%);box-shadow:4px 0 12px rgba(0,0,0,.28)}.q-drawer.strm-drawer--open{display:block;width:200px;transform:translateX(0)}.q-drawer .q-item,.q-drawer.strm-drawer--open .q-item{justify-content:flex-start}.q-drawer .q-item__section--main,.q-drawer.strm-drawer--open .q-item__section--main{display:block}.q-page-container{margin-left:0}.strm-scrim.strm-scrim--visible{display:block;position:fixed;z-index:14;inset:50px 0 0;background:rgba(0,0,0,.38)}.q-toolbar{padding:0 8px}.q-toolbar-title{font-size:18px}.strm-cache-summary{grid-template-columns:minmax(0,1fr)}.q-card__section{padding:16px}.q-card__actions{padding:12px 16px}}
    @media (prefers-color-scheme:dark){body:not(.body--light){--strm-bg:#121212;--strm-surface:#1e1e1e;--strm-text:#f1f1f1;--strm-muted:#b0b0b0;--strm-border:#3b3b3b}.strm-progress{background:#424242}pre{background:rgba(255,255,255,.06)}}
    body.body--dark{--strm-bg:#121212;--strm-surface:#1e1e1e;--strm-text:#f1f1f1;--strm-muted:#b0b0b0;--strm-border:#3b3b3b}.body--dark .strm-progress{background:#424242}.body--dark pre{background:rgba(255,255,255,.06)}
  </style>
</head>
<body>
  <div id="q-app" class="q-layout q-layout--standard" data-strm-native-dashboard="true">
    <header class="q-header q-layout__section--marginal bg-black absolute-top" role="banner">
      <div class="q-toolbar">
        <button id="strm-menu-button" class="q-btn q-btn--flat q-btn--round" type="button" aria-label="打开管理菜单" aria-controls="strm-drawer" aria-expanded="false"><span class="material-icons" aria-hidden="true">menu</span></button>
        <div class="q-toolbar-title">仪表盘</div>
        <div class="muted" style="color:#bdbdbd" aria-label="当前页面">STRM 设置</div>
      </div>
    </header>
    <div id="strm-drawer-scrim" class="strm-scrim" aria-hidden="true"></div>
    <aside id="strm-drawer" class="q-drawer q-drawer--left" aria-label="管理菜单">
      <nav class="q-list" aria-label="Dashboard">
        <a class="q-item" data-strm-nav href="/admin"><span class="q-item__section--avatar"><span class="material-icons" aria-hidden="true">folder</span></span><span class="q-item__section--main">音声库</span></a>
        <a class="q-item" data-strm-nav href="/admin/scanner"><span class="q-item__section--avatar"><span class="material-icons" aria-hidden="true">youtube_searched_for</span></span><span class="q-item__section--main">扫描</span></a>
        <a class="q-item" data-strm-nav href="/admin/usermanage"><span class="q-item__section--avatar"><span class="material-icons" aria-hidden="true">person</span></span><span class="q-item__section--main">用户管理</span></a>
        <a class="q-item" data-strm-nav href="/admin/advanced"><span class="q-item__section--avatar"><span class="material-icons" aria-hidden="true">settings</span></span><span class="q-item__section--main">高级设置</span></a>
        <a class="q-item q-item--active q-router-link--active q-router-link--exact-active" data-strm-nav href="/admin/strm" aria-current="page"><span class="q-item__section--avatar"><span class="material-icons" aria-hidden="true">tune</span></span><span class="q-item__section--main">STRM 设置</span></a>
        <a class="q-item" data-strm-nav href="/"><span class="q-item__section--avatar"><span class="material-icons" aria-hidden="true">home</span></span><span class="q-item__section--main">回到主页</span></a>
      </nav>
    </aside>
    <div class="q-page-container">
      <main id="strm-admin-content" class="q-page q-pa-md" data-strm-admin-content="true">
        <div class="strm-breadcrumb"><span>管理后台</span><span aria-hidden="true">/</span><strong>STRM 设置</strong></div>
        <section class="strm-card q-card" aria-labelledby="strm-status-title">
          <div class="q-card__section q-card__section--vert">
            <div class="strm-card-head"><div><h1 id="strm-status-title" class="strm-card-title">运行状态</h1><p class="strm-card-subtitle">查看 STRM 适配层、Helper 队列和冷缓存的实时状态。</p></div><span class="material-icons muted" aria-hidden="true">monitor_heart</span></div>
            <div id="status" class="strm-status-line muted"><span class="strm-dot" aria-hidden="true"></span><span>加载中…</span></div>
            <div class="strm-cache-summary" aria-label="缓存使用情况">
              <div class="strm-stat"><span class="strm-stat-label">已使用</span><strong id="cacheUsage" class="strm-stat-value">—</strong></div>
              <div class="strm-stat"><span class="strm-stat-label">容量上限</span><strong id="cacheLimit" class="strm-stat-value">—</strong></div>
              <div class="strm-stat"><span class="strm-stat-label">容量状态</span><strong id="cacheState" class="strm-stat-value strm-state-off">等待状态</strong></div>
            </div>
            <div class="strm-progress" role="progressbar" aria-label="缓存容量使用比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="cacheProgress"></span></div>
            <pre id="metrics" aria-label="运行指标"></pre>
            <details><summary>查看原始数据</summary><pre id="rawMetrics"></pre></details>
          </div>
          <div class="q-card__actions"><button id="refresh" class="q-btn q-btn--dense" type="button"><span class="material-icons" aria-hidden="true">refresh</span>&nbsp;刷新状态</button></div>
        </section>
        <section class="strm-card q-card" aria-labelledby="strm-security-title">
          <div class="q-card__section q-card__section--vert"><h2 id="strm-security-title" class="strm-card-title">安全与播放策略</h2><p class="strm-card-subtitle">控制 STRM 是否启用、预取识别以及客户端的媒体交付方式。</p>
            <div class="strm-grid" style="margin-top:18px">
              <label class="strm-check"><input id="enabled" type="checkbox"><span>启用 STRM 适配层</span></label>
              <label class="strm-field"><span>播放交付方式</span><select id="redirectMode"><option value="direct">冷启动响度后 302（推荐）</option><option value="local">永久本地兼容（手动选项，需完整冷下载）</option></select></label>
              <label class="strm-field"><span>预取模式</span><select id="preloadMode"><option value="observe">仅观测（默认）</option><option value="short-circuit">明确预取时短路（需确认）</option><option value="off">关闭</option></select></label>
              <label class="strm-check"><input id="detectHead" type="checkbox"><span>将 HEAD 作为预取信号（可能误判播放器探测）</span></label>
              <label class="strm-field"><span>同一媒体直链复用（秒）</span><input id="redirectCacheTtlMs" type="number" min="0" max="60" step="1" inputmode="decimal"><span class="muted">0 = 每次重新请求 Helper</span></label>
            </div>
          </div>
        </section>
        <section class="strm-card q-card" aria-labelledby="strm-cache-title">
          <div class="q-card__section q-card__section--vert"><h2 id="strm-cache-title" class="strm-card-title">冷启动与响度策略</h2><p class="strm-card-subtitle">为首次播放准备本地文件，并按容量与保留时间管理冷缓存。</p>
            <div class="strm-grid" style="margin-top:18px">
              <label class="strm-check"><input id="coldCacheEnabled" type="checkbox"><span>启用冷启动缓存</span></label>
              <label class="strm-field"><span>缓存总容量（GiB）</span><input id="maxTotalBytes" type="number" min="0" step="0.1" inputmode="decimal"></label>
              <label class="strm-field"><span>单个文件上限（MiB）</span><input id="maxFileBytes" type="number" min="0" step="0.1" inputmode="decimal"></label>
              <label class="strm-field"><span>视频文件上限（MiB）</span><input id="maxVideoBytes" type="number" min="0" step="0.1" inputmode="decimal"></label>
              <label class="strm-field"><span>缓存最长保留（天）</span><input id="maxAgeMs" type="number" min="0" step="0.1" inputmode="decimal"></label>
              <label class="strm-check"><input id="loudnessEnabled" type="checkbox"><span>启用响度分析</span></label>
              <label class="strm-check"><input id="loudnessAudioOnly" type="checkbox"><span>仅对音频执行响度分析</span></label>
              <label class="strm-field"><span>响度测量器</span><select id="loudnessMethod"><option value="loudnorm">loudnorm（兼容输出）</option><option value="ebur128">ebur128（更快测量）</option></select></label>
            </div>
            <p class="strm-help">本地模式提供永久本地兼容，首次冷启动需要完整下载到 .part，完成后改名为正式缓存并占用配置的磁盘空间；缓存按容量和保留天数清理。视频上限设为 0 表示不缓存视频。</p>
            <p class="strm-help">直接模式首次请求会完整冷下载并在本地完成响度准备，首播先返回本地文件；响度就绪后后续播放和 Range 返回 302，媒体正文由客户端从 CDN 获取，适合已验证兼容性的场景。</p>
          </div>
          <div class="q-card__actions"><button id="save" class="q-btn" type="button"><span class="material-icons" aria-hidden="true">save</span>&nbsp;保存配置</button><span id="message" class="strm-message muted" role="status" aria-live="polite"></span></div>
        </section>
        <section class="strm-card q-card" aria-labelledby="strm-cleanup-title">
          <div class="q-card__section q-card__section--vert"><h2 id="strm-cleanup-title" class="strm-card-title">缓存操作</h2><p class="strm-card-subtitle">清理只删除适配层本地缓存，不删除媒体目录或远端文件。</p></div>
          <div class="q-card__actions"><button id="cleanup" class="q-btn q-btn--negative q-btn--dense" type="button"><span class="material-icons" aria-hidden="true">delete_sweep</span>&nbsp;二次确认后清理缓存</button></div>
        </section>
      </main>
    </div>
  </div>
  <script data-strm-admin-script>(function(){ "use strict";
    var root=document.getElementById("strm-admin-content");
    if(!root)return;
    if(window.__kikoeruStrmAdminRuntime&&window.__kikoeruStrmAdminRuntime.root===root)return;
    window.__kikoeruStrmAdminRuntime={root:root};
    var token="";
    try{var rawToken=localStorage.getItem("jwt-token")||"";var quasarStringPrefix="__q_strn|";token=rawToken.indexOf(quasarStringPrefix)===0?rawToken.slice(quasarStringPrefix.length):rawToken;}catch(_){}
    function el(id){return document.getElementById(id);}
    function headers(json){var h={};if(token)h.Authorization="Bearer "+token;if(json)h["Content-Type"]="application/json";return h;}
    function request(url,opts){opts=opts||{};opts.headers=Object.assign(headers(Boolean(opts.body)),opts.headers||{});var fetchImpl=null;try{fetchImpl=window.fetch||((typeof fetch==="function")&&fetch);}catch(_){}if(!fetchImpl)return Promise.reject(new Error("浏览器不支持 fetch"));return fetchImpl.call(window,url,opts).then(function(r){return r.text().then(function(t){var d={};try{d=JSON.parse(t);}catch(_){d={message:t};}if(!r.ok)throw Object.assign(new Error(d.error||d.message||("HTTP "+r.status)),{status:r.status,data:d});return d;});});}
    function number(value){var n=Number(value);return Number.isFinite(n)?n:0;}
    var BYTES_PER_MIB=1024*1024,BYTES_PER_GIB=1024*BYTES_PER_MIB,MS_PER_SECOND=1000,MS_PER_DAY=24*60*60*1000;
    function displayUnit(value,unit,fallback){var n=Number(value);return String(Number.isFinite(n)?Math.round(n/unit*1000)/1000:fallback);}
    function inputUnit(id,unit){var field=el(id);return Math.max(0,Math.round(number(field&&field.value)*unit));}
    function bytes(value){var n=Math.max(0,number(value)),u=["B","KiB","MiB","GiB","TiB"],i=0;while(n>=1024&&i<u.length-1){n/=1024;i+=1;}return (i===0?String(Math.round(n)):n.toFixed(n>=100?0:n>=10?1:2))+" "+u[i];}
    function duration(value){var n=Math.max(0,number(value));if(n<1000)return n+" ms";if(n<60000)return (n/1000).toFixed(1)+" 秒";return Math.ceil(n/60000)+" 分钟";}
    function readableMetrics(d){var q=d.queue||{},r=d.redirect||{},m=d.metrics||{},b=r.budget||{},g=d.sharedHelper||{},c=d.config||{},cold=c.coldCache||{};return ["播放结果","  对客户端返回 302（CDN 直连）："+number(m.hotRedirect)+" 次","  本地文件 200（服务端缓存）："+number(m.coldLocal)+" 次","  本地播放模式："+number(m.localPlayback)+" 次","  预加载跳过 204："+number(m.preloadSkip)+" 次","","缓存使用","  当前："+bytes(d.cacheBytes)+" / 上限："+(number(cold.maxTotalBytes)>0?bytes(cold.maxTotalBytes):"未设置"),"","Helper 地址解析（当前进程）","  已发起："+number(r.started)+" 次","  已完成："+number(r.completed)+" 次","  当前排队："+number(r.pending)+" 个","  进行中："+number(r.running)+" 个","  队列拒绝："+number(r.rejected)+" 次","  已复用 CDN 地址："+number(r.cacheHits)+" 次","","Helper 全局预算（含扫描子进程）","  本分钟："+number(g.minuteUsed)+" / "+number(g.minuteUsed+g.minuteRemaining)+" 次","  本小时："+number(g.hourUsed)+" / "+number(g.hourUsed+g.hourRemaining)+" 次","  下次可用："+(number(g.nextAvailableInMs)>0?duration(g.nextAvailableInMs):"立即"),"","缓存与响度任务","  正在下载："+number(d.activeDownloads)+" 个（临时 .part："+number(d.activePartFiles)+" 个）","  正在响度分析："+number(d.activeLoudness)+" 个","","限流状态","  本分钟："+number(b.minuteUsed)+" / "+number(r.perMinute)+" 次","  本小时："+number(b.hourUsed)+" / "+number(r.perHour)+" 次","  429："+number(r.rateLimited429)+" 次","  冷却："+(number(r.cooldownRemainingMs)>0?duration(r.cooldownRemainingMs):"无"),"","时长探测队列（当前进程）","  排队："+number(q.pending)+" 个","  进行中："+(q.running?"是":"否"),"  已完成："+number(q.completed)+" 次","  失败："+number(q.failed)+" 次","","说明：direct 首次冷启动先准备本地缓存与响度，之后播放和 Range 返回 CDN 302；local 始终提供本地兼容；Helper 地址解析与扫描共用全局预算。"].join("\n");}
    function showError(error){var message=el("message");if(message){message.className="strm-message err";message.textContent=error&&error.message||String(error);}var status=el("status");if(status){status.className="strm-status-line err";status.innerHTML='<span class="strm-dot err" aria-hidden="true"></span><span>加载失败：'+String(error&&error.message||error).replace(/[<>]/g,"")+'</span>';}}
    function updateCache(d,cold){var used=Math.max(0,number(d.cacheBytes)),limit=Math.max(0,number(cold.maxTotalBytes)),usage=el("cacheUsage"),cap=el("cacheLimit"),state=el("cacheState"),bar=el("cacheProgress"),progress=bar&&bar.parentNode;if(usage)usage.textContent=bytes(used);if(cap)cap.textContent=limit?bytes(limit):"未设置";var over=limit>0&&used>limit,disabled=cold.enabled===false;if(state){state.className="strm-stat-value "+(disabled?"strm-state-off":over?"strm-state-over":"strm-state-ok");state.textContent=disabled?"已停用":over?"已超限":"正常";}if(bar){var ratio=limit?Math.min(100,used/limit*100):0;bar.style.width=ratio.toFixed(1)+"%";if(over)bar.classList.add("over");else bar.classList.remove("over");if(progress){progress.setAttribute("aria-valuenow",String(Math.round(ratio)));progress.setAttribute("aria-valuetext",bytes(used)+" / "+(limit?bytes(limit):"未设置"));}}}
    function load(){return request("/api/strm/status").then(function(d){var c=d.config||{},g=c.preloadGuard||{},r=c.redirectResolve||{},cold=c.coldCache||{},loud=c.loudness||{};if(el("enabled"))el("enabled").checked=Boolean(d.enabled);if(el("redirectMode"))el("redirectMode").value=c.redirectMode||"direct";if(el("preloadMode"))el("preloadMode").value=g.mode||"observe";if(el("detectHead"))el("detectHead").checked=Boolean(g.detectHead);if(el("redirectCacheTtlMs"))el("redirectCacheTtlMs").value=displayUnit(r.cacheTtlMs,MS_PER_SECOND,0);if(el("coldCacheEnabled"))el("coldCacheEnabled").checked=cold.enabled!==false;if(el("maxTotalBytes"))el("maxTotalBytes").value=displayUnit(cold.maxTotalBytes,BYTES_PER_GIB,20);if(el("maxFileBytes"))el("maxFileBytes").value=displayUnit(cold.maxFileBytes,BYTES_PER_MIB,2048);if(el("maxVideoBytes"))el("maxVideoBytes").value=displayUnit(cold.maxVideoBytes,BYTES_PER_MIB,512);if(el("maxAgeMs"))el("maxAgeMs").value=displayUnit(cold.maxAgeMs,MS_PER_DAY,30);if(el("loudnessEnabled"))el("loudnessEnabled").checked=loud.enabled!==false;if(el("loudnessAudioOnly"))el("loudnessAudioOnly").checked=loud.audioOnly!==false;if(el("loudnessMethod"))el("loudnessMethod").value=loud.method||"loudnorm";var status=el("status");if(status){status.className="strm-status-line ok";status.innerHTML='<span class="strm-dot" aria-hidden="true"></span><span>已连接 · STRM 记录 '+(d.records||[]).length+' · 缓存 '+bytes(d.cacheBytes)+'</span>';}updateCache(d,cold);var metrics=el("metrics");if(metrics)metrics.textContent=readableMetrics(d);var raw=el("rawMetrics");if(raw)raw.textContent=JSON.stringify({queue:d.queue,redirect:d.redirect,metrics:d.metrics},null,2);return d;}).catch(function(error){showError(error);throw error;});}
    function save(){var body={enabled:Boolean(el("enabled")&&el("enabled").checked),redirectMode:el("redirectMode")&&el("redirectMode").value,preloadGuard:{mode:el("preloadMode")&&el("preloadMode").value,detectHead:Boolean(el("detectHead")&&el("detectHead").checked)},redirectResolve:{cacheTtlMs:inputUnit("redirectCacheTtlMs",MS_PER_SECOND)},coldCache:{enabled:Boolean(el("coldCacheEnabled")&&el("coldCacheEnabled").checked),maxTotalBytes:inputUnit("maxTotalBytes",BYTES_PER_GIB),maxFileBytes:inputUnit("maxFileBytes",BYTES_PER_MIB),maxVideoBytes:inputUnit("maxVideoBytes",BYTES_PER_MIB),maxAgeMs:inputUnit("maxAgeMs",MS_PER_DAY)},loudness:{enabled:Boolean(el("loudnessEnabled")&&el("loudnessEnabled").checked),audioOnly:Boolean(el("loudnessAudioOnly")&&el("loudnessAudioOnly").checked),method:el("loudnessMethod")&&el("loudnessMethod").value}};return request("/api/admin/strm",{method:"PUT",body:JSON.stringify(body)}).then(function(){var message=el("message");if(message){message.className="strm-message ok";message.textContent="已保存";}return load();}).catch(showError);}
    function cleanup(){if(!window.confirm("确认清理适配层缓存？此操作不可立即恢复。"))return Promise.resolve(false);return request("/api/admin/strm/cleanup",{method:"POST"}).then(function(){var message=el("message");if(message){message.className="strm-message ok";message.textContent="清理完成";}return load();}).catch(showError);}
    function syncNav(){var current="";try{current=String(window.location.pathname||"").replace(/\/+$/,"")||"/";}catch(_){}var links=document.querySelectorAll?document.querySelectorAll("[data-strm-nav]"):[];for(var i=0;i<links.length;i+=1){var href=links[i].getAttribute("href")||"",active=href===current;if(links[i].classList){if(active)links[i].classList.add("q-item--active","q-router-link--active","q-router-link--exact-active");else links[i].classList.remove("q-item--active","q-router-link--active","q-router-link--exact-active");}if(active)links[i].setAttribute("aria-current","page");else links[i].removeAttribute("aria-current");}}
    function setDrawer(open){var drawer=el("strm-drawer"),scrim=el("strm-drawer-scrim"),button=el("strm-menu-button");if(drawer&&drawer.classList){if(open)drawer.classList.add("strm-drawer--open");else drawer.classList.remove("strm-drawer--open");}if(scrim&&scrim.classList){if(open)scrim.classList.add("strm-scrim--visible");else scrim.classList.remove("strm-scrim--visible");}if(scrim)scrim.setAttribute("aria-hidden",open?"false":"true");if(button)button.setAttribute("aria-expanded",open?"true":"false");}
    function syncTheme(){var dark=false,hasSaved=false;try{var saved=localStorage.getItem("dark");hasSaved=saved!==null;dark=saved==="true"||saved==="__q_bool|true"||saved==="dark";}catch(_){}if(!hasSaved&&document.body&&document.body.classList){if(document.body.classList.contains("body--dark")||document.body.classList.contains("q-dark"))dark=true;else if(document.body.classList.contains("body--light"))dark=false;}try{if(!hasSaved&&!dark&&window.matchMedia)dark=window.matchMedia("(prefers-color-scheme: dark)").matches;}catch(_){}if(document.body&&document.body.classList){document.body.classList.toggle("body--dark",dark);document.body.classList.toggle("body--light",!dark);}}
    var refresh=el("refresh"),saveButton=el("save"),cleanupButton=el("cleanup"),menuButton=el("strm-menu-button"),scrim=el("strm-drawer-scrim");
    if(refresh)refresh.onclick=function(){load();};
    if(saveButton)saveButton.onclick=save;
    if(cleanupButton)cleanupButton.onclick=cleanup;
    if(menuButton)menuButton.onclick=function(){var drawer=el("strm-drawer");setDrawer(!(drawer&&drawer.classList&&drawer.classList.contains("strm-drawer--open")));};
    if(scrim)scrim.onclick=function(){setDrawer(false);};
    var navLinks=document.querySelectorAll?document.querySelectorAll("[data-strm-nav]"):[];for(var i=0;i<navLinks.length;i+=1)navLinks[i].addEventListener&&navLinks[i].addEventListener("click",function(){setDrawer(false);});
    if(window.addEventListener)window.addEventListener("popstate",function(){syncNav();setDrawer(false);});
    syncNav();syncTheme();load();
  })();</script>
</body>
</html>`;

function pathnameOf(req) {
  return String(req && req.url || '').split('?', 1)[0];
}

function createAdminUiMiddleware() {
  return function strmAdminUi(req, res, next) {
    const pathname = pathnameOf(req);
    if (req.method === 'GET' && (pathname === '/api/admin/strm-fragment' || pathname === '/api/admin/strm-fragment/' || pathname === '/admin/strm' || pathname === '/admin/strm/')) {
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
