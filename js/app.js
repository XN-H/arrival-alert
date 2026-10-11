/* ============================================================
 * 到站了 · 视障出行语音提醒  —— 交互逻辑
 * 依赖：data/mock.js（先加载）、Leaflet（本地 vendor）
 * 纯原生 JS，无构建工具，双击 index.html 即可运行
 *
 * 语音设计要点：
 *  - 长按对讲：按住「音量+ / 键盘+」说话，松开执行（避免自己听到喇叭声）
 *  - 播报队列 + 优先级：普通播报排队不互相打断；到站等安全提醒可抢占
 *  - 提示音：用 WebAudio 现场合成，不引外部音频文件（保持离线可用）
 *  - 急停：音量− / Esc / 红色急停按钮，立即静音 + 停识别 + 停模拟
 * ============================================================ */

'use strict';

/* ============================================================
 * ① UI 配置（供后续 UI 优化者使用：改这里即可调视觉，不用碰逻辑）
 * ============================================================ */
var UI_CONFIG = {
  phone: { width: 375, height: 840, radius: 44, bezel: 12 },
  font: { base: 16, title: 26, status: 24, btn: 17 },
  color: {
    brand: '#ea580c', brandDark: '#c2410c', brandSoft: '#fff7ed', brandSoftText: '#c2410c',
    text: '#111827', textSub: '#6b7280', border: '#e5e7eb', surface: '#ffffff', pageBg: '#eef0f3'
  },
  button: { radius: 18, padY: 16 },
  map: {
    height: 200,
    busTickMs: 700,
    busFastTickMs: 150,
    busDwellMs: 4500,       // 到站停靠时长（正常速度）
    busFastDwellMs: 1800,   // 到站停靠时长（加速演示）
    taxiTickMs: 2600,
    taxiFastTickMs: 900
  },
  voice: { beepGapMs: 110, rate: 1.2 },
  anim: { fast: '.18s', panDuration: 0.45 }
};

function applyUIConfig() {
  var r = document.documentElement.style;
  var p = UI_CONFIG.phone, f = UI_CONFIG.font, c = UI_CONFIG.color, b = UI_CONFIG.button;
  r.setProperty('--phone-w', p.width + 'px');
  r.setProperty('--phone-h', p.height + 'px');
  r.setProperty('--phone-radius', p.radius + 'px');
  r.setProperty('--phone-bezel', p.bezel + 'px');
  r.setProperty('--fs-base', f.base + 'px');
  r.setProperty('--fs-title', f.title + 'px');
  r.setProperty('--fs-status', f.status + 'px');
  r.setProperty('--fs-btn', f.btn + 'px');
  r.setProperty('--c-brand', c.brand);
  r.setProperty('--c-brand-dark', c.brandDark);
  r.setProperty('--c-brand-soft', c.brandSoft);
  r.setProperty('--c-brand-soft-text', c.brandSoftText);
  r.setProperty('--c-text', c.text);
  r.setProperty('--c-text-sub', c.textSub);
  r.setProperty('--c-border', c.border);
  r.setProperty('--c-surface', c.surface);
  r.setProperty('--c-page-bg', c.pageBg);
  r.setProperty('--btn-radius', b.radius + 'px');
  r.setProperty('--btn-pad-y', b.padY + 'px');
  r.setProperty('--map-h', UI_CONFIG.map.height + 'px');
  r.setProperty('--anim-fast', UI_CONFIG.anim.fast);
}

/* ============================================================
 * ② 提示音（WebAudio 现场合成，零外部文件）
 * ============================================================ */
var audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { try { audioCtx = new AC(); } catch (e) { audioCtx = null; } }
  }
  if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) { } }
  return audioCtx;
}

function beep(kind) {
  var ctx = ensureAudio();
  if (!ctx) return;
  var now = ctx.currentTime;
  function tone(freq, start, dur, vol) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + start);
    g.gain.linearRampToValueAtTime(vol, now + start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(now + start); o.stop(now + start + dur + 0.03);
  }
  if (kind === 'start') tone(880, 0, 0.09, 0.16);
  else if (kind === 'end') { tone(660, 0, 0.06, 0.14); tone(990, 0.07, 0.09, 0.14); }
  else if (kind === 'alert') { tone(1046, 0, 0.11, 0.2); tone(1046, 0.16, 0.12, 0.2); }
}

/* ============================================================
 * ③ 播报队列 + 优先级（核心：不冲突、可打断）
 * ============================================================ */
var PRIORITY = { PANIC: 0, SAFETY: 1, CONFIRM: 2, NORMAL: 3 };

var speechQueue = [];
var speaking = false;
var currentSpeechText = '';   // 正在播报的文本（用于过滤麦克风听到的"回声"）
var currentSpeechKind = '';   // 正在播报的类型：'guide'(界面说明) / 'reminder'(提醒) / 'normal'

var activeLogId = 'bus-log';
function currentLogEl() { return document.getElementById(activeLogId); }

function addLog(listEl, text) {
  if (!listEl) return;
  var empty = listEl.querySelector('.log-empty');
  if (empty) empty.remove();
  var li = document.createElement('li');
  li.className = 'log-item pl-3 py-1';
  var t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  li.innerHTML = '<span style="color:var(--c-text-sub)" class="mr-2">' + t + '</span>' + text;
  listEl.insertBefore(li, listEl.firstChild);
}

/** 统一播报入口。priority 越小越紧急。onDone 在该条播完（或被取消）后回调。
 *  kind：'guide'=界面说明（松手可停）、'reminder'=提醒语音（松手不停）、'normal' */
function speak(text, priority, onDone, kind) {
  if (priority === undefined) priority = PRIORITY.NORMAL;
  addLog(currentLogEl(), text);
  if (!('speechSynthesis' in window)) {
    // 没有语音合成能力时也要让流程继续（例如长按说话要靠它推进）
    if (onDone) { try { onDone(); } catch (e) { } }
    return;
  }

  if (priority <= PRIORITY.SAFETY) {
    var item = { text: text, priority: priority, onDone: onDone, kind: kind };
    // 只有确实有语音在播/在排队时才需要"打断"。
    // 若本来就没声，就不要调用 cancel() —— 否则会踩进 Chrome "cancel 后 speak 被吞"的坑。
    if (speaking || speechQueue.length > 0) {
      speechQueue = [];
      speaking = false;
      try { window.speechSynthesis.cancel(); } catch (e) { }
      item.needGap = true;          // cancel 过 → 要留足间隔再开口
    }
    speechQueue.push(item);
    pumpSpeech();
    return;
  }
  speechQueue.push({ text: text, priority: priority, onDone: onDone, kind: kind });
  speechQueue.sort(function (a, b) { return a.priority - b.priority; });
  pumpSpeech();
}

function pumpSpeech() {
  if (speaking) return;
  if (!speechQueue.length) { maybeResumeRecognition(); return; }
  var item = speechQueue.shift();
  speaking = true;
  currentSpeechText = item.text;
  currentSpeechKind = item.kind || 'normal';
  if (item.priority <= PRIORITY.SAFETY) beep('alert'); else beep('start');

  var done = function () {
    speaking = false;
    currentSpeechText = '';
    currentSpeechKind = '';
    if (item.onDone) { try { item.onDone(); } catch (e) { } }
    pumpSpeech();
  };

  // 抢占播报（上车提醒/到站提醒）在 Chrome 里有个坑：
  // cancel() 之后立刻 speak()，新句子会被静默丢弃。所以必要时留足间隔，并先 resume() 解除 paused。
  var delay;
  if (item.needGap) delay = 350;
  else if (item.priority <= PRIORITY.SAFETY) delay = 60;
  else delay = UI_CONFIG.voice.beepGapMs;
  setTimeout(function () {
    if (!speaking) return;   // 期间被急停了
    var u;
    try {
      u = new SpeechSynthesisUtterance(item.text);
      u.lang = 'zh-CN'; u.rate = UI_CONFIG.voice.rate || 1; u.pitch = 1;
      u.onend = done;
      u.onerror = done;
      try { window.speechSynthesis.resume(); } catch (e) { }   // Chrome 有时卡在 paused，先解除
      window.speechSynthesis.speak(u);
    } catch (e) { done(); return; }

    // 看门狗：若 1.2 秒后仍没有在播，说明被 Chrome 吞了 → 重试一次
    setTimeout(function () {
      if (!speaking || item.retried) return;
      var ss = window.speechSynthesis;
      if (!ss) return;
      var busy = ss.speaking || ss.pending;
      if (busy) return;
      item.retried = true;
      // 注意：这里不要再 cancel()，否则又会踩进同一个坑；直接 resume + speak 补播
      setTimeout(function () {
        if (!speaking) return;
        try { ss.resume(); } catch (e) { }
        try { ss.speak(u); } catch (e) { done(); }
      }, 300);
    }, 1200);
  }, delay);
}

/** 立即静音（不排队） */
function silence() {
  speechQueue = [];
  speaking = false;
  currentSpeechText = '';
  currentSpeechKind = '';
  try { window.speechSynthesis.cancel(); } catch (e) { }
  maybeResumeRecognition();
}

/** 播报空闲后：若还按着且有"待恢复"标记，就恢复收听
 *  （Chrome 里 TTS 与语音识别会争抢音频，播报期间识别常被中断） */
function maybeResumeRecognition() {
  if (ptt.active && ptt.pendingRestart && !ptt.rec && !speaking) {
    ptt.pendingRestart = false;
    startRecognition();
  }
}

function buzz(pattern) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { } }
}

/* ============================================================
 * ④ 视图切换 + 界面导览播报
 * ============================================================ */
var VIEWS = ['home', 'bus', 'taxi'];
var currentView = 'home';

function switchView(name, announce) {
  if (VIEWS.indexOf(name) === -1) return;
  currentView = name;
  // 离开公交页 → 自动退出选站向导
  if (name !== 'bus' && wizard && wizard.active) { wizard.active = false; wizard.step = 'idle'; wizard.options = null; }
  VIEWS.forEach(function (v) {
    var el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('active', v === name);
  });
  if (name === 'bus' && busMap) setTimeout(function () { busMap.invalidateSize(); }, 60);
  if (name === 'taxi' && taxiMap) setTimeout(function () { taxiMap.invalidateSize(); }, 60);
  var body = document.querySelector('.phone-body');
  if (body) body.scrollTop = 0;
  if (announce) announceScreen(name);
}

/** 更新左侧可见提示条（给陪同者/演示者看，视障用户主要靠听） */
function setHint(text) {
  var bar = document.getElementById('voice-hint');
  if (bar && text) { bar.textContent = text; bar.style.color = ''; }
}

/** 当前界面的"说明词"：我在哪、能做什么（长按音量键时先播报这个）
 *  注意：尽量不要在说明里念出"开始"等指令词，避免扬声器声音被麦克风听成指令；
 *        完整指令列表由"帮助"口令播报。 */
function screenGuideText() {
  if (wizard.active) {                      // 向导中：播报当前该说什么
    if (wizard.step === 'board') return '请问在哪一站上车？';
    if (wizard.step === 'alight') return '请问在哪一站下车？';
    return '上车站' + busStopName(wizard.board) + '，下车站' + busStopName(wizard.alight) + '。确认吗？';
  }
  if (currentView === 'home') {
    return '主界面。可以说：公交，或者打车。';
  }
  if (currentView === 'bus') {
    var b = busStopName(Number(document.getElementById('sel-board').value));
    var a = busStopName(Number(document.getElementById('sel-alight').value));
    return '公交页。上车站' + b + '，下车站' + a + '。';
  }
  return '打车页。目的地' + taxiDest.name + '。';
}

/** 播报"当前是什么界面、能做什么" */
function announceScreen(name) {
  name = name || currentView;
  if (name === 'home') {
    setHint('当前：主界面 · 可以说「公交」或「打车」');
  } else if (name === 'bus') {
    setHint('当前：公交页 · 可以说「开始」「换站」「还有几站」');
  } else if (name === 'taxi') {
    setHint('当前：打车页 · 可以说「开始」「打车去某地」');
  }
  speak(screenGuideText(), PRIORITY.CONFIRM);
}

function helpScript() {
  if (wizard.active) {
    setHint('帮助 · 选站向导：说站名 / 第几个站 / 取消');
    speak('正在设置站。可以说站名，比如' + busStopName(1) + '。也可以说：' +
      MOCK_BUS_ROUTE.stops.map(function (s) { return s.name; }).join('、') + '。说取消可退出。', PRIORITY.CONFIRM);
    return;
  }
  if (currentView === 'bus') {
    setHint('帮助 · 公交页：开始 / 换站 / 在某某站上车 / 在某某站下车 / 还有几站 / 停止 / 返回');
    speak('这里是公交页。可以说：开始、换站、在某某站上车、在某某站下车、还有几站、停止、返回。', PRIORITY.CONFIRM);
  } else if (currentView === 'taxi') {
    setHint('帮助 · 打车页：开始 / 打车去某地 / 停止 / 返回');
    speak('这里是打车页。可以说：开始、打车去某地、停止、返回。', PRIORITY.CONFIRM);
  } else {
    setHint('帮助 · 主界面：公交 / 打车；按住音量加说完松开');
    speak('这是主界面。可以说：公交、打车。按住音量加说完松开即可。', PRIORITY.CONFIRM);
  }
}

/* ============================================================
 * ⑤ 地图（Leaflet + 高德瓦片，GCJ-02）
 * ============================================================ */
var busMap = null, taxiMap = null, busMarker = null, taxiMarker = null;
var taxiPath = [], taxiLayerGroup = null;

var AMAP_TILE = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}';
var AMAP_OPTS = { subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '高德地图' };

function hasLeaflet() { return typeof L !== 'undefined'; }

function baseMapEl(id) {
  var el = document.getElementById(id);
  if (!el) return null;
  if (!hasLeaflet()) {
    el.innerHTML = '<div style="padding:16px;color:#6b7280;font-size:13px">地图未加载（离线时可用下方文字与语音继续演示）</div>';
    return null;
  }
  return el;
}

function ensureBusMap() {
  if (busMap) return;
  if (!baseMapEl('bus-map')) return;

  busMap = L.map('bus-map', { zoomControl: false, attributionControl: false });
  L.tileLayer(AMAP_TILE, AMAP_OPTS).addTo(busMap);

  var stops = MOCK_BUS_ROUTE.stops;
  var path = MOCK_BUS_ROUTE.path;

  L.polyline(path, { color: UI_CONFIG.color.brand, weight: 5, opacity: 0.9 }).addTo(busMap);

  stops.forEach(function (s, i) {
    var isTarget = (i === MOCK_BUS_DEFAULT.boardIndex || i === MOCK_BUS_DEFAULT.alightIndex);
    L.circleMarker([s.lat, s.lng], {
      radius: isTarget ? 7 : 5, color: '#fff', weight: 2, fillColor: '#f97316', fillOpacity: 1
    }).addTo(busMap).bindTooltip(s.name);
  });

  L.circleMarker([MOCK_USER_LOCATION.lat, MOCK_USER_LOCATION.lng], {
    radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1
  }).addTo(busMap).bindTooltip('您的位置');

  busMarker = L.marker(path[0], {
    icon: L.divIcon({ className: '', html: '<div class="bus-pin">🚌</div>', iconSize: [26, 26], iconAnchor: [13, 13] })
  }).addTo(busMap);

  busMap.fitBounds(L.latLngBounds(path).pad(0.22));
}

function buildTaxiPath(dest) {
  return buildRoutePath([
    { lat: MOCK_TAXI.startLat, lng: MOCK_TAXI.startLng },
    { lat: MOCK_TAXI.midLat, lng: MOCK_TAXI.midLng },
    { lat: dest.lat, lng: dest.lng }
  ], 10);
}

function ensureTaxiMap() {
  if (taxiMap) return;
  if (!baseMapEl('taxi-map')) return;

  taxiMap = L.map('taxi-map', { zoomControl: false, attributionControl: false });
  L.tileLayer(AMAP_TILE, AMAP_OPTS).addTo(taxiMap);

  taxiLayerGroup = L.layerGroup().addTo(taxiMap);
  taxiMarker = L.marker([MOCK_TAXI.startLat, MOCK_TAXI.startLng], {
    icon: L.divIcon({ className: '', html: '<div class="bus-pin">🚕</div>', iconSize: [26, 26], iconAnchor: [13, 13] })
  }).addTo(taxiMap);

  renderTaxiRoute();
}

/** 根据当前目的地重绘打车路线（改目的地时调用） */
function renderTaxiRoute() {
  if (!taxiMap || !taxiLayerGroup) return;
  taxiPath = buildTaxiPath(taxiDest);

  taxiLayerGroup.clearLayers();
  L.polyline(taxiPath, { color: '#6b7280', dashArray: '6 6', weight: 3 }).addTo(taxiLayerGroup);
  L.circleMarker([taxiDest.lat, taxiDest.lng], {
    radius: 8, color: '#fff', weight: 3, fillColor: '#16a34a', fillOpacity: 1
  }).addTo(taxiLayerGroup).bindTooltip('目的地：' + taxiDest.name);

  if (taxiMarker) taxiMarker.setLatLng(taxiPath[0]);
  taxiMap.fitBounds(L.latLngBounds(taxiPath).pad(0.28));
}

/* ============================================================
 * ⑥ 公交提醒
 * ============================================================ */
var S = MOCK_BUS_ROUTE.samplesPerSegment;

var busState = { running: false, cur: 0, boarded: false, fast: false, timer: null, lastText: '', boardIndex: 2, alightIndex: 5, dwellUntil: 0, finishAfterDwell: false };

function busStopName(i) {
  var s = MOCK_BUS_ROUTE.stops[i];
  return s ? s.name : '未知站';
}

function fillSelects() {
  var stops = MOCK_BUS_ROUTE.stops;
  var board = document.getElementById('sel-board');
  var alight = document.getElementById('sel-alight');
  if (!board || !alight) return;
  stops.forEach(function (s, i) {
    board.appendChild(new Option(s.name, String(i)));
    alight.appendChild(new Option(s.name, String(i)));
  });
  board.value = String(MOCK_BUS_DEFAULT.boardIndex);
  alight.value = String(MOCK_BUS_DEFAULT.alightIndex);
}

function busTickMs() { return busState.fast ? UI_CONFIG.map.busFastTickMs : UI_CONFIG.map.busTickMs; }
function busDwellMs() { return busState.fast ? UI_CONFIG.map.busFastDwellMs : UI_CONFIG.map.busDwellMs; }

function updateBusStatus(main, sub) {
  var m = document.getElementById('bus-status');
  var s = document.getElementById('bus-sub');
  if (m && main) m.textContent = main;
  if (s && sub) s.textContent = sub;
}

function setBusMarker(cur) {
  if (!busMap || !busMarker) return;
  var p = MOCK_BUS_ROUTE.path[Math.min(cur, MOCK_BUS_ROUTE.path.length - 1)];
  busMarker.setLatLng(p);
  busMap.panTo(p, { animate: true, duration: UI_CONFIG.anim.panDuration });
}

function showSelError(msg) {
  var err = document.getElementById('sel-error');
  if (err) { err.textContent = msg; err.classList.remove('hidden'); }
}

function startBus() {
  var board = document.getElementById('sel-board');
  var alight = document.getElementById('sel-alight');
  var err = document.getElementById('sel-error');
  var bi = Number(board.value);
  var ai = Number(alight.value);

  if (board.value === '' || alight.value === '' || isNaN(bi) || isNaN(ai)) {
    showSelError('请先选择上车和下车车站。'); return;
  }
  if (bi >= ai) { showSelError('下车车站必须在上车车站之后，请重新选择。'); return; }
  if (err) err.classList.add('hidden');

  stopBus(true);
  busState.boardIndex = bi;
  busState.alightIndex = ai;
  busState.boarded = false;
  busState.running = true;
  busState.cur = Math.max(0, bi - 2) * S;

  var startBtn = document.getElementById('btn-start');
  var stopBtn = document.getElementById('btn-stop');
  if (startBtn) startBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;

  activeLogId = 'bus-log';
  var boardName = busStopName(bi), alightName = busStopName(ai);
  busState.lastText = '已开始提醒。' + MOCK_BUS_ROUTE.line + '，您将在 ' + boardName + ' 上车，在 ' + alightName + ' 下车。';
  speak(busState.lastText, PRIORITY.CONFIRM);
  updateBusStatus('正在为您盯着 ' + MOCK_BUS_ROUTE.line, '从 ' + boardName + ' 上车 → 到 ' + alightName + ' 下车');

  setBusMarker(busState.cur);
  busState.timer = setInterval(tickBus, busTickMs());
}

function tickBus() {
  // 到站停靠：这几秒车停着不动，专门用来把到站提醒播完
  if (busState.dwellUntil) {
    if (Date.now() < busState.dwellUntil) return;
    busState.dwellUntil = 0;
    if (busState.finishAfterDwell) {
      busState.finishAfterDwell = false;
      updateBusStatus('提醒结束', '祝您出行顺利');
      stopBus(true);
      return;
    }
  }

  busState.cur += 1;
  setBusMarker(busState.cur);

  if (busState.cur >= MOCK_BUS_ROUTE.path.length - 1) {
    updateBusStatus('已到达终点站', '提醒结束');
    stopBus(true);
    return;
  }
  if (busState.cur % S === 0) handleBusStop(busState.cur / S);
}

function handleBusStop(k) {
  var bi = busState.boardIndex, ai = busState.alightIndex;

  if (!busState.boarded) {
    if (k === bi) {
      busState.boarded = true;
      busState.dwellUntil = Date.now() + busDwellMs();      // 停靠几秒
      busState.lastText = '上车提醒：车已到站，' + busStopName(bi) + '，请上车，注意台阶。';
      speak(busState.lastText, PRIORITY.SAFETY, null, 'reminder');
      buzz([200, 100, 200]);
      updateBusStatus('上车提醒 · 车已到站：' + busStopName(bi), '车辆停靠中，请上车');
    } else if (k < bi) {
      var gap = bi - k;
      busState.lastText = '还有 ' + gap + ' 站到达上车站' + busStopName(bi) + '，请准备上车。';
      speak(busState.lastText, PRIORITY.NORMAL, null, 'reminder');
      updateBusStatus('还有 ' + gap + ' 站到达上车站 ' + busStopName(bi), '请准备上车');
    }
    return;
  }

  var gap2 = ai - k;
  if (gap2 <= 0) {
    busState.dwellUntil = Date.now() + busDwellMs();         // 停靠几秒，播完到站提醒再收尾
    busState.finishAfterDwell = true;
    busState.lastText = '到站提醒：已到达' + busStopName(ai) + '，请下车，请注意脚下台阶。';
    speak(busState.lastText, PRIORITY.SAFETY, null, 'reminder');
    buzz([300, 120, 300, 120, 300]);
    updateBusStatus('到站提醒 · 已到达：' + busStopName(ai), '车辆停靠中，请下车');
  } else if (gap2 === 2) {
    busState.lastText = '还有 2 站到达下车站' + busStopName(ai) + '，请准备下车。';
    speak(busState.lastText, PRIORITY.NORMAL, null, 'reminder');
    updateBusStatus('还有 2 站到达下车站 ' + busStopName(ai), '请准备下车');
  } else if (gap2 === 1) {
    busState.lastText = '下一站' + busStopName(ai) + '，请准备下车。';
    speak(busState.lastText, PRIORITY.NORMAL, null, 'reminder');
    updateBusStatus('下一站 ' + busStopName(ai), '请准备下车');
  } else {
    // 离下车站还远：每站都报一次，保证"一直有声音"
    busState.lastText = '还有 ' + gap2 + ' 站到达下车站' + busStopName(ai) + '。';
    speak(busState.lastText, PRIORITY.NORMAL, null, 'reminder');
    updateBusStatus('还有 ' + gap2 + ' 站到达下车站 ' + busStopName(ai), '正在行驶');
  }
}

function stopBus(silent) {
  if (busState.timer) { clearInterval(busState.timer); busState.timer = null; }
  busState.running = false;
  busState.dwellUntil = 0;
  busState.finishAfterDwell = false;
  var startBtn = document.getElementById('btn-start');
  var stopBtn = document.getElementById('btn-stop');
  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
  if (!silent) addLog(currentLogEl(), '（提醒已停止）');
}

/* ============================================================
 * ⑦ 打车提醒（目的地可变，路径动态生成）
 * ============================================================ */
var taxiState = { running: false, timer: null, eta: 0, fast: false, lastText: '', phase: 'pickup' };
var taxiDest = MOCK_PLACES[MOCK_TAXI_DEFAULT];

function taxiTickMs() { return taxiState.fast ? UI_CONFIG.map.taxiFastTickMs : UI_CONFIG.map.taxiTickMs; }

function setTaxiProgress(ratio) {
  if (!taxiMap || !taxiMarker || !taxiPath.length) return;
  var idx = Math.round(ratio * (taxiPath.length - 1));
  var p = taxiPath[Math.max(0, Math.min(taxiPath.length - 1, idx))];
  taxiMarker.setLatLng(p);
  taxiMap.panTo(p, { animate: true, duration: UI_CONFIG.anim.panDuration });
}

function startTaxi() {
  stopTaxi(true);
  activeLogId = 'taxi-log';
  taxiState.eta = MOCK_TAXI.etaMinutes;
  taxiState.phase = 'pickup';
  taxiState.running = true;

  var el = document.getElementById('taxi-status');
  if (el) el.textContent = '司机还有 ' + taxiState.eta + ' 分钟到达上车点';

  taxiState.lastText = '已开始提醒。去' + taxiDest.name + '。' + MOCK_TAXI.driver + '，' + MOCK_TAXI.car + '，车牌 ' + MOCK_TAXI.plate + '，预计 ' + taxiState.eta + ' 分钟到达上车点。';
  speak(taxiState.lastText, PRIORITY.CONFIRM);
  setTaxiProgress(0);

  taxiState.timer = setInterval(function () {
    taxiState.eta -= 1;
    var st = document.getElementById('taxi-status');

    /* —— 第一段：司机接驾 —— */
    if (taxiState.phase === 'pickup') {
      var totalA = MOCK_TAXI.etaMinutes;
      setTaxiProgress((totalA - Math.max(0, taxiState.eta)) / totalA * 0.5);
      if (taxiState.eta > 0) {
        taxiState.lastText = '司机还有 ' + taxiState.eta + ' 分钟到达上车点。';
        if (st) st.textContent = '司机还有 ' + taxiState.eta + ' 分钟到达上车点';
        speak(taxiState.lastText, PRIORITY.NORMAL, null, 'reminder');
      } else {
        taxiState.lastText = '上车提醒：司机已到达上车点，车牌 ' + MOCK_TAXI.plate + '，请上车。';
        if (st) st.textContent = '上车提醒 · 司机已到达，请上车';
        speak(taxiState.lastText, PRIORITY.SAFETY, null, 'reminder');
        buzz([200, 100, 200]);
        taxiState.phase = 'trip';                 // 转入行程
        taxiState.eta = MOCK_TAXI.tripMinutes;
      }
      return;
    }

    /* —— 第二段：行程中 —— */
    var totalB = MOCK_TAXI.tripMinutes;
    setTaxiProgress(0.5 + (totalB - Math.max(0, taxiState.eta)) / totalB * 0.5);
    if (taxiState.eta > 0) {
      taxiState.lastText = '正在前往' + taxiDest.name + '，还有 ' + taxiState.eta + ' 分钟。';
      if (st) st.textContent = '正在前往 ' + taxiDest.name + '，还有 ' + taxiState.eta + ' 分钟';
      speak(taxiState.lastText, PRIORITY.NORMAL, null, 'reminder');
    } else {
      taxiState.lastText = '到站提醒：已到达目的地' + taxiDest.name + '，请下车。';
      if (st) st.textContent = '到站提醒 · 已到达 ' + taxiDest.name;
      speak(taxiState.lastText, PRIORITY.SAFETY, null, 'reminder');
      buzz([300, 120, 300, 120, 300]);
      stopTaxi(true);
    }
  }, taxiTickMs());
}

function stopTaxi(silent) {
  if (taxiState.timer) { clearInterval(taxiState.timer); taxiState.timer = null; }
  taxiState.running = false;
  if (!silent) addLog(currentLogEl(), '（提醒已结束）');
}

/* ============================================================
 * ⑧ 流程封装
 * ============================================================ */
function startBusFlow() {
  if (currentView !== 'bus') switchView('bus', false);
  ensureBusMap();
  setTimeout(function () { if (busMap) busMap.invalidateSize(); startBus(); }, 120);
}

function startTaxiFlow() {
  if (currentView !== 'taxi') switchView('taxi', false);
  ensureTaxiMap();
  setTimeout(function () { if (taxiMap) taxiMap.invalidateSize(); startTaxi(); }, 120);
}

function stopAll() {
  var wasRunning = busState.running || taxiState.running;
  stopBus(true); stopTaxi(true);
  updateBusStatus('提醒已停止', '可重新开始');
  var ts = document.getElementById('taxi-status');
  if (ts && ts.textContent.indexOf('已到达') === -1) ts.textContent = '提醒已停止';
  speak(wasRunning ? '已停止提醒。' : '当前没有正在进行的提醒。', PRIORITY.CONFIRM);
}

function resetAll() {
  stopBus(true); stopTaxi(true);
  wizard.active = false; wizard.step = 'idle'; wizard.options = null;
  pendingChoice = null;
  updateBusStatus('点击下方「开始提醒」', '共 8 站 · 将播报上车与下车提醒');
  var ts = document.getElementById('taxi-status');
  if (ts) ts.textContent = '点击下方「开始提醒」';
  var board = document.getElementById('sel-board');
  var alight = document.getElementById('sel-alight');
  if (board) board.value = String(MOCK_BUS_DEFAULT.boardIndex);
  if (alight) alight.value = String(MOCK_BUS_DEFAULT.alightIndex);
  var err = document.getElementById('sel-error');
  if (err) err.classList.add('hidden');
  taxiDest = MOCK_PLACES[MOCK_TAXI_DEFAULT];
  renderTaxiRoute();
  switchView('home', false);
  speak('已重置。主界面，可以说：公交，或者打车。', PRIORITY.CONFIRM);
}

/** 急停：立刻静音 + 停识别 + 停模拟，且可马上重新开始 */
function panic(silent) {
  silence();
  abortRecognition();
  stopBus(true); stopTaxi(true);
  wizard.active = false; wizard.step = 'idle'; wizard.options = null;
  updateBusStatus('已急停', '可重新开始');
  var ts = document.getElementById('taxi-status');
  if (ts) ts.textContent = '已急停';
  setVoiceState('idle');
  beep('end');
  if (!silent) speak('已急停。', PRIORITY.CONFIRM);
}

/* ============================================================
 * ⑨ 长按对讲（Push-to-Talk）
 * ============================================================ */
function getSR() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }

var ptt = { active: false, gen: 0, recStartAt: 0, rec: null, err: '', acted: false, fastEnds: 0, lastText: '', lastAt: 0, pendingRestart: false };

function setVoiceState(state) {
  var bar = document.getElementById('voice-hint');
  var up = document.getElementById('vol-up');
  if (bar) {
    if (state === 'listening') { bar.textContent = '🔴 正在播报并持续收听… 可以连续说指令，松开才停'; bar.style.color = '#dc2626'; }
    else { bar.textContent = '长按「音量+ / 键盘 +」：边播报边收听，可连续说指令'; bar.style.color = ''; }
  }
  if (up) up.classList.toggle('flash', state === 'listening');
}

/** 按住：一边播报"当前界面说明"，一边持续收听；说指令立刻执行；松手停止收音 */
function pttStart() {
  if (ptt.active) return;
  if (!getSR()) {
    speak('当前浏览器不支持语音输入，请使用屏幕按钮操作。', PRIORITY.CONFIRM);
    return;
  }

  silence();
  ptt.gen += 1;
  ptt.active = true;
  ptt.acted = false;
  ptt.fastEnds = 0;
  ptt.lastText = '';
  ptt.lastAt = 0;
  ptt.pendingRestart = false;
  ptt.err = '';

  beep('start');
  setVoiceState('listening');

  // ① 先开麦（Chrome 里若先让 TTS 发声，麦克风可能被抢占起不来）
  startRecognition();

  // ② 再播报当前界面说明（若识别到指令会被打断）
  speak(screenGuideText(), PRIORITY.CONFIRM, null, 'guide');
}

/** 启动/重启识别（持续模式，按住期间一直听） */
function startRecognition() {
  var SR = getSR();
  if (!SR || !ptt.active) return;
  try {
    var rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.continuous = true;          // 持续收听
    rec.maxAlternatives = 1;
    rec.onstart = function () { ptt.recStartAt = Date.now(); };
    rec.onresult = function (e) {
      var i = e.results.length - 1;
      var t = (e.results[i][0] && e.results[i][0].transcript || '').trim();
      if (t) onHeardDuringHold(t);
    };
    rec.onerror = function (e) { ptt.err = (e && e.error) || 'error'; };
    rec.onend = function () { onRecEnd(); };
    ptt.rec = rec;
    rec.start();
  } catch (e) {
    ptt.active = false; setVoiceState('idle');
    speak('语音输入启动失败，请重试。', PRIORITY.CONFIRM);
  }
}

/** 按住期间听到内容：命中指令就打断播报、执行并语音反馈，然后继续听（不结束本次按住） */
function onHeardDuringHold(text) {
  if (!ptt.active) return;
  setHint('🎙 听到：「' + text + '」');                 // 可见反馈，便于确认识别是否生效
  if (text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length < 2) return;
  if (isEchoOfAnnouncement(text)) return;              // 过滤"把自己的播报听回来"
  if (text === ptt.lastText && Date.now() - ptt.lastAt < 2500) return;   // 同一句短时间内去重
  if (!wizard.active && !looksLikeCommand(text)) return;  // 向导期间不限指令词（站名不是指令词）

  ptt.lastText = text;
  ptt.lastAt = Date.now();
  ptt.acted = true;

  silence();                       // 打断当前播报
  beep('end');
  if (wizard.active) wizardHandle(text);      // 向导中：按站名处理
  else handleVoiceCommand(text, false);       // 执行并给出语音反馈
  // 注意：不结束本次按住，继续收听，方便连续说指令
}

/** 识别是否只是把正在播报的说明听了回来（回声）。短指令（如"开始"）不拦，避免误伤 */
function isEchoOfAnnouncement(text) {
  if (!currentSpeechText) return false;
  var a = text.replace(/[^\u4e00-\u9fa5]/g, '');
  var b = currentSpeechText.replace(/[^\u4e00-\u9fa5]/g, '');
  if (!a || !b) return false;
  if (a === b) return true;                              // 整句听回来
  if (a.length >= 4 && b.indexOf(a) !== -1) return true; // 较长片段 = 回声
  return false;
}

var CMD_RE = /(公交|巴士|打车|出租|的士|叫车|开始|出发|停止|停下|结束|取消|急停|别说了|闭嘴|安静|返回|首页|回去|退出|帮助|能做什么|怎么用|指令|换站|换车站|改站|还有几站|到哪|还要多久|进度|第几站|上车|下车)|(?:打车)?去[\u4e00-\u9fa5]{2,}/;
function looksLikeCommand(t) { return CMD_RE.test(t); }

/** 识别结束：只要还按着就重启 → 实现"按住期间一直能识别" */
function onRecEnd() {
  ptt.rec = null;
  if (!ptt.active) return;

  if (ptt.err === 'not-allowed' || ptt.err === 'service-not-allowed' || ptt.err === 'audio-capture') {
    ptt.active = false; setVoiceState('idle');
    speak('麦克风不可用，请检查权限或设备。', PRIORITY.CONFIRM);
    return;
  }
  // 正在播报时先不抢麦，等播报结束再恢复（Chrome 里 TTS 与识别会争抢音频）
  if (speaking) { ptt.pendingRestart = true; return; }

  // 连续"刚启动就结束"过多 → 判断为麦克风没声音，避免无限重启
  if (ptt.recStartAt && Date.now() - ptt.recStartAt < 500) ptt.fastEnds += 1;
  else ptt.fastEnds = 0;
  if (ptt.fastEnds > 8) {
    ptt.active = false; setVoiceState('idle');
    speak('麦克风似乎没有声音，请检查设备后重试。', PRIORITY.CONFIRM);
    return;
  }
  setTimeout(function () { if (ptt.active && !ptt.rec && !speaking) startRecognition(); }, 300);
}

/** 松手：停止收音；只停"界面说明"，正在播的提醒语音会播完 */
function pttStop() {
  if (!ptt.active) return;
  ptt.active = false;
  ptt.pendingRestart = false;
  try { if (ptt.rec) ptt.rec.stop(); } catch (e) { }
  if (!ptt.acted && currentSpeechKind === 'guide') silence();   // 不误杀提醒播报
  setVoiceState('idle');
}

function abortRecognition() {
  try { if (ptt.rec) ptt.rec.abort(); } catch (e) { }
  ptt.rec = null; ptt.active = false; ptt.pendingRestart = false;
  ptt.gen += 1;
}

/* ============================================================
 * ⑩ 语音指令解析（选站 / 目的地 / 导航 / 控制）
 * ============================================================ */
var pendingChoice = null;   // 多候选时等待用户说"第一个/第二个"

var CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

function parseOrdinal(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return CN_NUM[t] || 0;
}

function matchByName(list, phrase) {
  var q = String(phrase).replace(/[站的地了]/g, '').trim();
  if (!q) return [];
  var res = [];
  list.forEach(function (item, i) {
    var n = item.name;
    if (n.indexOf(q) !== -1 || q.indexOf(n) !== -1) res.push(i);
  });
  // 剔除完全被更精确项包含的歧义（保留全部，交给候选流程处理）
  return res;
}

/* ---------------- 选站向导（说「开始」后逐句问答） ---------------- */
var wizard = { active: false, step: 'idle', board: -1, alight: -1, options: null };

function startWizard() {
  if (currentView !== 'bus') { switchView('bus', false); ensureBusMap(); }
  wizard.active = true;
  wizard.step = 'board';
  wizard.board = -1;
  wizard.alight = -1;
  wizard.options = null;
  pendingChoice = null;
  speak('开始设置。请问在哪一站上车？', PRIORITY.CONFIRM);
}

function exitWizard(msg) {
  wizard.active = false; wizard.step = 'idle'; wizard.options = null;
  if (msg) speak(msg, PRIORITY.CONFIRM);
}

/** 站名宽松匹配：容忍"在…上车"这类说法 */
function matchStopLoose(phrase) {
  var q = String(phrase).replace(/上车|下车|车站|站|在|到|去|是|的|了|吧|呢|请|说|我|要|想|坐/g, '').trim();
  if (!q) return [];
  var res = [];
  MOCK_BUS_ROUTE.stops.forEach(function (s, i) {
    if (s.name.indexOf(q) !== -1 || q.indexOf(s.name) !== -1) res.push(i);
  });
  return res;
}

/** 向导中听到内容 */
function wizardHandle(raw) {
  var t = String(raw).replace(/\s/g, '');

  if (/急停|别说了|闭嘴|安静/.test(t)) { exitWizard(); panic(false); return; }
  if (/停止|停下|结束|取消|算了|不弄了|退出/.test(t)) { exitWizard('已取消设置。'); return; }
  if (/帮助|能做什么|怎么用|站名/.test(t)) { helpScript(); return; }
  if (/打车|出租|的士/.test(t)) { exitWizard('已取消设置。'); switchView('taxi', true); ensureTaxiMap(); return; }

  // 确认环节
  if (wizard.step === 'confirm') {
    if (/重来|重新|不对|错了|换一个/.test(t)) {
      wizard.step = 'board'; wizard.board = -1; wizard.alight = -1; wizard.options = null;
      speak('好的，重新设置。请问在哪一站上车？', PRIORITY.CONFIRM);
      return;
    }
    if (/确认|确定|是|对|好|可以|没问题|开始|出发|走/.test(t)) { wizardConfirm(); return; }
    speak('请说「确认」开始，或者说「重来」重新设置。', PRIORITY.CONFIRM);
    return;
  }

  // 候选：说"第一个"（注意要映射到候选列表，而不是全站列表）
  if (wizard.options && wizard.options.length > 1) {
    var mo = t.match(/第?([一二两三四五1-5])个?/);
    if (mo) {
      var k = parseOrdinal(mo[1]) - 1;
      if (k >= 0 && k < wizard.options.length) wizardPick(wizard.options[k]);
      else speak('只能选第 1 到第 ' + wizard.options.length + ' 个。', PRIORITY.CONFIRM);
      return;
    }
  }
  // 又说了一次"开始" → 重复当前提问
  if (/开始|出发/.test(t)) {
    speak(wizard.step === 'board' ? '请问在哪一站上车？' : '请问在哪一站下车？', PRIORITY.CONFIRM);
    return;
  }
  // 直接说"第三个站"
  var mi = t.match(/第([一二两三四五]|\d+)站/);
  if (mi) {
    var n = parseOrdinal(mi[1]);
    if (n >= 1 && n <= MOCK_BUS_ROUTE.stops.length) { wizardPick(n - 1); return; }
  }

  var idxs = matchStopLoose(t);
  if (!idxs.length) {
    speak('没听清这一站。请再说一次，或者说「帮助」听站名列表。', PRIORITY.CONFIRM);
    return;
  }
  if (idxs.length > 1) {
    wizard.options = idxs;
    var names = idxs.map(function (i, k) { return '第' + (k + 1) + '个 ' + busStopName(i); });
    speak('找到多个：' + names.join('，') + '。请说第几个。', PRIORITY.CONFIRM);
    return;
  }
  wizardPick(idxs[0]);
}

function wizardPick(idx) {
  wizard.options = null;
  if (wizard.step === 'board') {
    wizard.board = idx;
    wizard.step = 'alight';
    speak('上车站' + busStopName(idx) + '。请问在哪一站下车？', PRIORITY.CONFIRM);
    return;
  }
  if (wizard.step === 'alight') {
    if (wizard.board >= 0 && idx <= wizard.board) {
      var bName = busStopName(wizard.board);
      wizard.step = 'board'; wizard.board = -1;
      speak('下车站必须在' + bName + '之后，请重新说上车站。', PRIORITY.CONFIRM);
      return;
    }
    wizard.alight = idx;
    wizard.step = 'confirm';
    speak('上车站' + busStopName(wizard.board) + '，下车站' + busStopName(idx) + '。确认吗？', PRIORITY.CONFIRM);
  }
}

function wizardConfirm() {
  var board = document.getElementById('sel-board');
  var alight = document.getElementById('sel-alight');
  if (board) board.value = String(wizard.board);
  if (alight) alight.value = String(wizard.alight);
  wizard.active = false; wizard.step = 'idle'; wizard.options = null;
  var err = document.getElementById('sel-error');
  if (err) err.classList.add('hidden');
  startBusFlow();
}

function handleVoiceCommand(raw, quiet) {
  var text = raw.replace(/\s/g, '');

  // 0) 多候选时的序号选择
  if (pendingChoice) {
    var mo = text.match(/第?([一二两三四五1-5])个?/);
    if (mo) { applyChoice(parseOrdinal(mo[1]) - 1); return; }
    if (/取消|算了|不选/.test(text)) { pendingChoice = null; speak('已取消选择。', PRIORITY.CONFIRM); return; }
  }

  // 1) 帮助
  if (/帮助|能做什么|怎么用|指令/.test(text)) { helpScript(); return; }

  // 2) 急停（真·紧急）：立即静音
  if (/急停|别说了|闭嘴|安静|不要说了/.test(text)) { panic(false); return; }
  // 2b) 停止当前提醒（温和）
  if (/停止|停下|结束|取消/.test(text)) { stopAll(); return; }

  // 2c) 换站：给出语音引导，然后接着说站名即可
  if (/换站|换车站|改站|改车站|重新选站|换个站/.test(text)) {
    speak('好的，请说：在某某站上车，或者在某某站下车。', PRIORITY.CONFIRM);
    return;
  }

  // 3) 语音选站：在XX上车 / 在XX下车
  var mStation = text.match(/(?:在|去)?(.+?)(上车|下车)/);
  if (mStation) { setStationByPhrase(mStation[2] === '上车' ? 'board' : 'alight', mStation[1]); return; }
  var mSet = text.match(/(上车站|下车站|出发站|终点站).*?(?:换成|改为|设为|是)(.+)/);
  if (mSet) {
    var type = (mSet[1] === '上车站' || mSet[1] === '出发站') ? 'board' : 'alight';
    setStationByPhrase(type, mSet[2]); return;
  }

  // 4) 进度询问（放在目的地之前，避免"到哪了"被当成目的地）
  if (/还有几站|到哪|还要多久|进度|第几站/.test(text)) { announceProgress(); return; }

  // 5) 打车目的地：打车去XX / 去XX / 到XX
  var mDest = text.match(/(?:打车)?(?:去|到)(.+)/);
  if (mDest) { setTaxiDestByPhrase(mDest[1]); return; }

  // 6) 进入界面
  if (/公交|巴士/.test(text)) { switchView('bus', true); ensureBusMap(); return; }
  if (/打车|出租|的士|叫车/.test(text)) { switchView('taxi', true); ensureTaxiMap(); return; }

  // 7) 控制
  if (/直接开始|马上开始|立即开始/.test(text)) {
    if (currentView === 'taxi') startTaxiFlow(); else startBusFlow();
    return;
  }
  if (/开始|出发/.test(text)) {
    if (currentView === 'taxi') startTaxiFlow();   // 打车页保持"直接开始"
    else startWizard();                            // 公交页：进入选站向导
    return;
  }
  if (/再播报|重播|再说|重复|念一遍/.test(text)) {
    var t = (activeLogId === 'taxi-log' ? taxiState.lastText : busState.lastText);
    speak(t || '还没有可播报的内容，请先开始提醒。', PRIORITY.CONFIRM);
    return;
  }
  if (/返回|首页|回去|退出/.test(text)) { switchView('home', true); return; }

  if (!quiet) speak('没有听懂。可以说：公交、打车、在某某站上车、打车去某地、帮助。', PRIORITY.CONFIRM);
}

function setStationByPhrase(type, phrase) {
  var idxs = matchByName(MOCK_BUS_ROUTE.stops, phrase);
  if (!idxs.length) {
    speak('没有找到这个站。站点有：' + MOCK_BUS_ROUTE.stops.map(function (s) { return s.name; }).join('、') + '。请再说一次。', PRIORITY.CONFIRM);
    return;
  }
  if (idxs.length > 1) {
    pendingChoice = { kind: 'station', type: type, options: idxs };
    var names = idxs.map(function (i, n) { return '第' + (n + 1) + '个 ' + MOCK_BUS_ROUTE.stops[i].name; });
    speak('找到多个：' + names.join('，') + '。请说第几个，比如第一个。', PRIORITY.CONFIRM);
    return;
  }
  applyStation(type, idxs[0]);
}

function applyChoice(n) {
  if (!pendingChoice) return;
  var opts = pendingChoice.options;
  if (n < 0 || n >= opts.length) { speak('只能选第 1 到第 ' + opts.length + ' 个。', PRIORITY.CONFIRM); return; }
  var kind = pendingChoice.kind, type = pendingChoice.type, idx = opts[n];
  pendingChoice = null;
  if (kind === 'station') applyStation(type, idx);
  else if (kind === 'dest') applyTaxiDest(idx);
}

function applyStation(type, idx) {
  if (currentView !== 'bus') switchView('bus', false);
  var board = document.getElementById('sel-board');
  var alight = document.getElementById('sel-alight');
  var b = Number(board.value), a = Number(alight.value);

  if (type === 'board') {
    if (idx >= a) { speak('上车站必须在' + busStopName(a) + '之前，请重新选择。', PRIORITY.CONFIRM); return; }
    board.value = String(idx);
    speak('上车站已设为' + busStopName(idx) + '，下车站是' + busStopName(a) + '。', PRIORITY.CONFIRM);
  } else {
    if (idx <= b) { speak('下车站必须在' + busStopName(b) + '之后，请重新选择。', PRIORITY.CONFIRM); return; }
    alight.value = String(idx);
    speak('下车站已设为' + busStopName(idx) + '，上车站是' + busStopName(b) + '。', PRIORITY.CONFIRM);
  }
  var err = document.getElementById('sel-error');
  if (err) err.classList.add('hidden');
}

function setTaxiDestByPhrase(phrase) {
  var idxs = [];
  MOCK_PLACES.forEach(function (p, i) { if (matchByName([p], phrase).length) idxs.push(i); });
  if (!idxs.length) {
    speak('没听清要去哪。可以说：' + MOCK_PLACES.map(function (p) { return p.name; }).join('、') + '。', PRIORITY.CONFIRM);
    return;
  }
  if (idxs.length > 1) {
    pendingChoice = { kind: 'dest', options: idxs };
    var names = idxs.map(function (i, n) { return '第' + (n + 1) + '个 ' + MOCK_PLACES[i].name; });
    speak('找到多个地点：' + names.join('，') + '。请说第几个。', PRIORITY.CONFIRM);
    return;
  }
  applyTaxiDest(idxs[0]);
}

function applyTaxiDest(idx) {
  taxiDest = MOCK_PLACES[idx];
  renderTaxiRoute();
  if (currentView !== 'taxi') switchView('taxi', false);
  speak('好的，打车去' + taxiDest.name + '。可以说：开始。', PRIORITY.CONFIRM);
}

function announceProgress() {
  if (taxiState.running) {
    speak('去' + taxiDest.name + '，司机还有 ' + Math.max(0, taxiState.eta) + ' 分钟到达。', PRIORITY.CONFIRM);
    return;
  }
  if (busState.running) {
    var k = Math.round(busState.cur / S);
    var target = busState.boarded ? busState.alightIndex : busState.boardIndex;
    var gap = Math.max(0, target - k);
    var word = busState.boarded ? '下车站' : '上车站';
    speak(MOCK_BUS_ROUTE.line + '，还有 ' + gap + ' 站到达' + word + busStopName(target) + '。', PRIORITY.CONFIRM);
    return;
  }
  speak('当前没有正在进行的提醒。', PRIORITY.CONFIRM);
}

/* ============================================================
 * ⑪ 事件绑定
 * ============================================================ */
function bind() {
  // 外置演示控制台
  document.getElementById('c-bus').addEventListener('click', startBusFlow);
  document.getElementById('c-taxi').addEventListener('click', startTaxiFlow);
  document.getElementById('c-stop').addEventListener('click', stopAll);
  document.getElementById('c-reset').addEventListener('click', resetAll);
  document.getElementById('c-help').addEventListener('click', helpScript);
  document.getElementById('c-panic').addEventListener('click', function () { panic(false); });

  // 手机壳音量键：音量+ = 长按说话；音量− = 急停
  var up = document.getElementById('vol-up');
  var down = document.getElementById('vol-down');
  up.addEventListener('pointerdown', function (e) { e.preventDefault(); pttStart(); });
  up.addEventListener('pointerup', function (e) { e.preventDefault(); pttStop(); });
  up.addEventListener('pointerleave', function () { if (ptt.active) pttStop(); });
  up.addEventListener('pointercancel', function () { if (ptt.active) pttStop(); });
  down.addEventListener('click', function () { panic(false); });

  // 键盘：长按 + 说话，松开执行；− 或 Esc 急停
  document.addEventListener('keydown', function (e) {
    if (e.key === '+' || e.key === '=') { if (!e.repeat) pttStart(); e.preventDefault(); }
    else if (e.key === '-' || e.key === '_') { panic(false); e.preventDefault(); }
    else if (e.key === 'Escape') { panic(false); }
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === '+' || e.key === '=') { pttStop(); }
  });

  // 应用内
  document.getElementById('go-bus').addEventListener('click', function () { switchView('bus', false); ensureBusMap(); });
  document.getElementById('go-taxi').addEventListener('click', function () { switchView('taxi', false); ensureTaxiMap(); });
  document.querySelectorAll('[data-back]').forEach(function (b) {
    b.addEventListener('click', function () { switchView('home', false); });
  });

  document.getElementById('btn-start').addEventListener('click', startBus);
  document.getElementById('btn-stop').addEventListener('click', function () {
    stopBus(false); updateBusStatus('提醒已停止', '可重新开始');
  });
  document.getElementById('btn-replay').addEventListener('click', function () {
    activeLogId = 'bus-log';
    speak(busState.lastText || '还没有可播报的内容，请先点击开始提醒。', PRIORITY.CONFIRM);
  });
  document.getElementById('btn-speed').addEventListener('click', function () {
    busState.fast = !busState.fast;
    taxiState.fast = busState.fast;
    this.textContent = busState.fast ? '🐢 恢复速度' : '⏩ 加速演示';
    if (busState.running) { clearInterval(busState.timer); busState.timer = setInterval(tickBus, busTickMs()); }
  });

  document.getElementById('sel-board').addEventListener('change', function () { pendingChoice = null; });
  document.getElementById('sel-alight').addEventListener('change', function () { pendingChoice = null; });

  document.getElementById('taxi-start').addEventListener('click', startTaxi);
  document.getElementById('taxi-replay').addEventListener('click', function () {
    activeLogId = 'taxi-log';
    speak(taxiState.lastText || '还没有可播报的内容，请先点击开始提醒。', PRIORITY.CONFIRM);
  });
}

/* ============================================================
 * ⑫ 启动
 * ============================================================ */
document.addEventListener('DOMContentLoaded', function () {
  applyUIConfig();
  fillSelects();
  bind();
  activeLogId = 'bus-log';
  setVoiceState('idle');
});
