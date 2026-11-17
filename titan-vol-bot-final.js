/* ============================================================================
 * TitanX testnet volume farming bot, v1.0.0
 * ----------------------------------------------------------------------------
 * What it does: opens and closes small, fast, max leverage positions on
 * testnet.titanx.cc to generate trading fees, which are what earn points
 * (weekly epochs, tickets from fees paid, pro rata share of a weekly pool).
 * See ~/workspace/titanx/rea-titanx-report.md for the REA findings.
 *
 * ROUTE: UI driving only. There is no window exposed API client in the app
 * (ES modules are not reachable from the page), and the session private key
 * is a non extractable WebCrypto key in IndexedDB, so this script NEVER
 * touches IndexedDB, NEVER extracts keys, and NEVER calls the API directly.
 * It clicks the same buttons a human clicks, and the app itself signs every
 * request with its own session. That is the only viable route.
 *
 * HOW TO RUN: see README.md in this folder. Short version: log in to
 * testnet.titanx.cc in a headed browser, open the BTC trade page, paste
 * this file into the DevTools console, wait for the control panel to say
 * READY, then press START. It does NOT auto start on injection.
 *
 * SAFETY (all mandatory, all in this file):
 *  - FULL SIZE build (user order 2026-11-17): testMode OFF, no test trade.
 *    First round trip uses 95% margin at max leverage.
 *  - Max hold time: any open position is force closed after maxHoldSeconds,
 *    no matter what.
 *  - Stop on failed close: farming halts, but the bot keeps retrying the
 *    close in rescue mode until the position is gone. It never walks away
 *    from a max leverage open position.
 *  - Balance floor: farming stops below balanceFloorUsdc, and the faucet
 *    reclaim runs (at most once per faucetCooldownMinutes).
 *  - Kill switch: panel STOP button, window.__titanVolBot.stop(), or
 *    localStorage key titan:volbot:kill = "1".
 *  - Session cap check: planned notional is checked against the session
 *    maxNotional from localStorage before every round trip.
 *  - Preflight: no trade unless session is valid, balance is above the
 *    floor, no position is already open on the market, and the form is
 *    on Market order type.
 *
 * TESTNET ONLY. Never real money. Never touches any other account or site.
 * Never stores credentials. No hammering: 30s gaps between round trips,
 * no retries without backoff.
 * ========================================================================== */
(function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   * CONFIG. Edit these values, or override after injection with
   * window.__titanVolBot.setConfig({...}). Every value is config, nothing
   * about size, leverage, timing or caps is hardcoded in the logic below.
   * ------------------------------------------------------------------ */
  var DEFAULT_CONFIG = {
    market: 'BTC',            // market symbol as shown in the pair panel
    testMode: false,          // FULL SIZE by user order 2026-11-17: no test trade, 95% margin at max leverage.
    testNotionalUsd: 100,     // notional per open in TEST_MODE (USD)
    marginPct: 95,            // percent of available balance used as margin per trade (full size mode)
    leverage: 'max',          // 'max' = highest the market allows (read live from the leverage slider), or a number like 40
    holdSeconds: 5,           // seconds between open and close
    gapSeconds: 30,           // seconds between round trips
    balanceFloorUsdc: 2000,   // stop farming below this available balance; try the faucet instead
    balanceCriticalUsdc: 500, // below this, hard stop, no faucet spam
    maxHoldSeconds: 30,       // force close any open position after this many seconds, no matter what
    maxRoundTrips: 0,         // 0 = unlimited; set N to stop after N round trips
    maxDailyFeesUsdc: 0,      // 0 = no cap; stop when estimated fees paid today reach this
    faucetEnabled: true,      // reclaim testnet tokens when balance drops under the floor
    faucetCooldownMinutes: 60,// minimum gap between faucet reclaim attempts
    orderType: 'market',      // only 'market' is supported (guaranteed fills)
    alternateSides: true,     // alternate long/short each round trip to stay direction neutral
    firstSide: 'long',        // side of the first round trip
    closeTimeoutSeconds: 20,  // how long to wait for a close to land before rescue mode
    openTimeoutSeconds: 15,   // how long to wait for a position to appear after submit
    confirmModalWaitSeconds: 5, // how long to wait for an order confirm modal after submit
    pollMs: 1000              // polling interval while waiting on the UI
  };

  /* Allow the parent to inject config before this file runs. */
  var config = Object.assign({}, DEFAULT_CONFIG, (window.__titanVolBotConfig || {}));

  /* ------------------------------------------------------------------ *
   * Selectors. All verified against the shipped bundles (release 7de17fc)
   * in ~/workspace/titanx/rea-bundles/. If the app updates and any of
   * these stop matching, the bot stops with a clear "selector not found"
   * error instead of guessing.
   * ------------------------------------------------------------------ */
  var SEL = {
    submitBtn: 'button[type="submit"][data-tour="confirm"]',
    sideToggle: '[data-tour="side"]',
    orderTypeToggle: '[data-tour="market"]',
    sizeInput: 'input[aria-label="Size"]',
    sizeSlider: 'div[role="slider"][aria-label="Size"]',
    leverageBtn: 'button[data-track="order.leverage_open"]',
    leverageSlider: 'div[role="slider"][aria-label="Leverage"]',
    availableRow: '[data-tour="available"]',
    summary: '[data-tour="summary"]',
    limitPriceInput: 'input[aria-label="Limit Price"]',
    closeBtnMarket: 'button.close-action-btn[aria-label="Close position \u00b7 Market"]',
    faucetReclaimRow: 'button[data-track="faucet.reclaim_open"]',
    positionsPanel: null // resolved at runtime: the element that holds position rows
  };

  /* ------------------------------------------------------------------ *
   * Tiny DOM + async helpers.
   * ------------------------------------------------------------------ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function nowIso() { return new Date().toISOString(); }
  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }
  function parseMoney(text) {
    if (text == null) return null;
    var m = String(text).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function findButtonByText(root, text, exact) {
    var btns = $$('button', root);
    var needle = String(text).trim().toLowerCase();
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim().toLowerCase();
      if (exact ? t === needle : t.indexOf(needle) !== -1) return btns[i];
    }
    return null;
  }

  function clickEl(el) {
    if (!el) throw new Error('clickEl: null element');
    el.scrollIntoView({ block: 'nearest' });
    el.click();
  }

  function pressKey(el, key) {
    el.focus();
    var opts = { key: key, code: key, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /* Set a React controlled input value the way React expects it. */
  function setNativeInputValue(input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitFor(fn, timeoutMs, intervalMs, label) {
    var deadline = Date.now() + timeoutMs;
    var lastErr = null;
    while (Date.now() < deadline) {
      try {
        var out = fn();
        if (out) return out;
      } catch (e) { lastErr = e; }
      await sleep(intervalMs || 500);
    }
    throw new Error('timeout waiting for: ' + (label || 'condition') + (lastErr ? ' (last: ' + lastErr.message + ')' : ''));
  }

  /* ------------------------------------------------------------------ *
   * Logging. In memory ring (parent reads it), console, and the panel.
   * ------------------------------------------------------------------ */
  var LOG_MAX = 500;
  var logLines = [];
  function log(level, msg, data) {
    var line = '[' + nowIso() + '] [' + level + '] ' + msg + (data !== undefined ? ' ' + JSON.stringify(data) : '');
    logLines.push(line);
    if (logLines.length > LOG_MAX) logLines.shift();
    try {
      if (level === 'ERROR') console.error('[titan-vol-bot]', msg, data || '');
      else console.log('[titan-vol-bot]', msg, data || '');
    } catch (e) { /* console may be unavailable */ }
    renderPanel();
  }

  /* ------------------------------------------------------------------ *
   * State. Persisted to localStorage so a page reload keeps the tally
   * (round trips, volume, fees). The bot NEVER auto resumes after a
   * reload; the parent must press START again.
   * ------------------------------------------------------------------ */
  var STATE_KEY = 'titan:volbot:state';
  var KILL_KEY = 'titan:volbot:kill';
  var state = {
    status: 'idle', // idle | running | stopping | error | rescue | stopped | paused-route
    roundTrips: 0,
    totalVolumeUsd: 0,
    feesEstUsd: 0,
    feesDate: null,
    balanceStart: null,
    balanceLast: null,
    nextSide: null,
    startedAt: null,
    lastRoundTripAt: null,
    lastError: null,
    rescueAttempts: 0,
    faucetLastAttemptAt: null,
    maxLeverageSeen: null,
    takerFeeEstLast: null
  };

  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      ['roundTrips', 'totalVolumeUsd', 'feesEstUsd', 'feesDate', 'balanceStart',
       'balanceLast', 'nextSide', 'startedAt', 'lastRoundTripAt'].forEach(function (k) {
        if (saved[k] !== undefined) state[k] = saved[k];
      });
    } catch (e) { /* corrupted state: start fresh */ }
  }
  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function setStatus(s, err) {
    state.status = s;
    if (err !== undefined) state.lastError = err;
    saveState();
    renderPanel();
  }
  function killRequested() {
    try { return localStorage.getItem(KILL_KEY) === '1'; } catch (e) { return false; }
  }
  function requestStop() {
    try { localStorage.setItem(KILL_KEY, '1'); } catch (e) { /* ignore */ }
  }
  function clearKill() {
    try { localStorage.removeItem(KILL_KEY); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * On page control panel. This is the activation signal: if this panel
   * is visible and says READY, the injection worked. It also carries the
   * START / STOP buttons and the live tally, so the parent can run the
   * bot without touching the console after injection.
   * ------------------------------------------------------------------ */
  var panelEl = null;
  var panelLogEl = null;
  var panelStatusEl = null;

  function renderPanel() {
    if (!panelEl) return;
    var mode = config.testMode ? 'TEST MODE ($' + config.testNotionalUsd + ' notional)' : 'FULL SIZE (' + config.marginPct + '% margin)';
    if (panelStatusEl) {
      panelStatusEl.textContent =
        'status: ' + state.status +
        ' | ' + mode +
        ' | trips: ' + state.roundTrips +
        ' | volume: $' + Math.round(state.totalVolumeUsd).toLocaleString('en-US') +
        ' | fees est: $' + state.feesEstUsd.toFixed(2) +
        ' | balance: ' + (state.balanceLast == null ? '?' : '$' + state.balanceLast.toLocaleString('en-US')) +
        (state.lastError ? ' | ERROR: ' + state.lastError : '');
      panelStatusEl.style.color = state.status === 'rescue' || state.status === 'error' ? '#ff5c5c' : '#e8e8e8';
    }
    if (panelLogEl) {
      panelLogEl.textContent = logLines.slice(-8).join('\n');
    }
    var startBtn = panelEl.querySelector('[data-vb="start"]');
    var stopBtn = panelEl.querySelector('[data-vb="stop"]');
    if (startBtn) startBtn.disabled = (state.status === 'running' || state.status === 'rescue');
    if (stopBtn) stopBtn.disabled = !(state.status === 'running' || state.status === 'rescue' || state.status === 'stopping');
  }

  function buildPanel() {
    if (panelEl) return;
    var div = document.createElement('div');
    div.id = 'titan-vol-bot-panel';
    div.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;width:340px;' +
      'background:rgba(10,12,16,0.94);color:#e8e8e8;border:1px solid #444;border-radius:10px;' +
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:10px 12px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,0.5);';
    div.innerHTML =
      '<div style="font-weight:700;font-size:13px;">TITAN VOL BOT v' + VERSION +
      ' <span style="color:#8aff8a;">\u25cf ACTIVATED</span></div>' +
      '<div data-vb="status" style="margin:6px 0;word-break:break-word;">status: idle</div>' +
      '<div style="display:flex;gap:8px;margin:6px 0;">' +
      '<button data-vb="start" style="flex:1;padding:7px 0;border-radius:6px;border:0;background:#1fbf5f;color:#fff;font-weight:700;cursor:pointer;">START</button>' +
      '<button data-vb="stop" style="flex:1;padding:7px 0;border-radius:6px;border:0;background:#d33;color:#fff;font-weight:700;cursor:pointer;">STOP</button>' +
      '</div>' +
      '<pre data-vb="log" style="margin:4px 0 0;max-height:150px;overflow:auto;white-space:pre-wrap;' +
      'word-break:break-word;font-size:10.5px;color:#bdbdbd;"></pre>';
    document.body.appendChild(div);
    panelEl = div;
    panelLogEl = div.querySelector('[data-vb="log"]');
    panelStatusEl = div.querySelector('[data-vb="status"]');
    div.querySelector('[data-vb="start"]').addEventListener('click', function () { api.start(); });
    div.querySelector('[data-vb="stop"]').addEventListener('click', function () { api.stop(); });
    renderPanel();
  }

  /* ================================================================== *
   * APP READERS. Read only. No IndexedDB, no key material, no writes.
   * ================================================================== */

  /* Session metadata from localStorage (the app stores this itself).
   * Shape: {sessionId, accountId, party, expiresAt, maxNotional}.
   * The private key lives in IndexedDB and is never read here. */
  function readSession() {
    try {
      var raw = localStorage.getItem('titan:trading-session:v3');
      if (!raw) return { present: false };
      var s = JSON.parse(raw);
      if (!s.sessionId || !s.accountId || !s.expiresAt) return { present: false };
      var expMs = new Date(s.expiresAt).getTime();
      return {
        present: true,
        expired: Date.now() >= expMs,
        expiresAt: s.expiresAt,
        maxNotional: (s.maxNotional == null ? null : Number(s.maxNotional)),
        accountId: s.accountId,
        party: s.party || null
      };
    } catch (e) {
      return { present: false, error: String(e && e.message || e) };
    }
  }

  /* Available balance from the trade form row [data-tour="available"].
   * Text looks like "$12,345.67 USDCx". */
  function readAvailable() {
    var row = $(SEL.availableRow);
    if (!row) return null;
    var spans = $$('span', row);
    for (var i = spans.length - 1; i >= 0; i--) {
      var v = parseMoney(spans[i].textContent);
      if (v != null) return v;
    }
    return parseMoney(row.textContent);
  }

  /* Mark price. Tries, in order: the order summary "Entry price" row,
   * then a "Mark price" label on the page. Returns null if unreadable. */
  function readMarkPrice() {
    var summary = readSummary();
    if (summary && summary.entryPrice) return summary.entryPrice;
    var els = $$('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length === 0 && (el.textContent || '').trim() === 'Mark price') {
        var parent = el.parentElement;
        if (parent) {
          var nums = (parent.textContent || '').replace(/,/g, '').match(/\$?\s*(\d+\.\d+|\d+)/g);
          if (nums) {
            for (var j = 0; j < nums.length; j++) {
              var v = parseMoney(nums[j]);
              if (v != null && v > 0) return v;
            }
          }
        }
      }
    }
    return null;
  }

  /* Order summary rows under [data-tour="summary"]: Margin, Fee, Liq price,
   * and for market orders the estimated entry price. Values may be absent
   * until a size is set. Returns an object with nulls where unreadable. */
  function readSummary() {
    var box = $(SEL.summary);
    var out = { margin: null, fee: null, orderValue: null, entryPrice: null, liqPrice: null };
    if (!box) return out;
    var text = box.textContent || '';
    function grab(labelRe) {
      var idx = text.search(labelRe);
      if (idx === -1) return null;
      var tail = text.slice(idx, idx + 80).replace(/,/g, '');
      // Prefer a $ amount (a value) over a bare number (which may be a rate).
      var m = tail.match(/\$\s*(-?\d+(\.\d+)?)/) || tail.match(/(-?\d+(\.\d+)?)/);
      return m ? parseFloat(m[1]) : null;
    }
    out.margin = grab(/margin/i);
    out.fee = grab(/fee/i);
    out.orderValue = grab(/order value|notional/i);
    out.entryPrice = grab(/entry price/i);
    out.liqPrice = grab(/liq/i);
    return out;
  }

  /* Current market slug from the URL: /trade/<slug> */
  function currentMarketSlug() {
    var m = window.location.pathname.match(/\/trade\/([^\/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* Leverage shown on the form button: aria-label "Leverage 40x". */
  function readLeverage() {
    var btn = $(SEL.leverageBtn);
    if (!btn) return null;
    var label = btn.getAttribute('aria-label') || '';
    var m = label.match(/(\d+)\s*\u00d7/);
    if (m) return parseInt(m[1], 10);
    var txt = (btn.textContent || '').match(/(\d+)\s*\u00d7/);
    return txt ? parseInt(txt[1], 10) : null;
  }

  function leverageLocked() {
    var btn = $(SEL.leverageBtn);
    if (!btn) return true;
    return btn.getAttribute('aria-disabled') === 'true' || btn.disabled === true;
  }

  /* Max leverage from the leverage popover slider (aria-valuemax).
   * Opens the popover, reads, closes it again. */
  async function readMaxLeverage() {
    var btn = $(SEL.leverageBtn);
    if (!btn) throw new Error('selector not found: leverage button');
    if (leverageLocked()) {
      var cur = readLeverage();
      if (cur != null) return cur;
      throw new Error('leverage button locked (a position may be open) and current leverage unreadable');
    }
    clickEl(btn);
    var slider = await waitFor(function () {
      var s = $(SEL.leverageSlider);
      return s && isVisible(s) ? s : null;
    }, 5000, 250, 'leverage slider');
    var max = parseInt(slider.getAttribute('aria-valuemax'), 10);
    clickEl(btn); // close the popover
    await sleep(300);
    if (!max || max <= 0) throw new Error('max leverage unreadable from slider');
    state.maxLeverageSeen = max;
    saveState();
    return max;
  }

  /* Size slider value (percent). */
  function readSizePct() {
    var s = $(SEL.sizeSlider);
    if (!s) return null;
    var v = parseInt(s.getAttribute('aria-valuenow'), 10);
    return isNaN(v) ? null : v;
  }

  /* Positions table: find the row for the configured market.
   * Returns {size, entryPrice, side} or null when no open position. */
  function readOpenPosition() {
    var market = config.market;
    var rows = $$('tr');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var text = row.textContent || '';
      if (text.indexOf(market) === -1) continue;
      if (/long/i.test(text) || /short/i.test(text)) {
        var cells = $$('td', row);
        var size = null, entry = null;
        if (cells.length >= 2) size = parseMoney(cells[1].textContent);
        for (var c = 0; c < cells.length; c++) {
          var t = cells[c].textContent || '';
          if (/entry/i.test(t) || /\//.test(t)) {
            var n = parseMoney(t);
            if (n != null) { entry = n; break; }
          }
        }
        return {
          size: size,
          entryPrice: entry,
          side: /short/i.test(text) && !/long/i.test(text) ? 'short' : 'long',
          rowText: text.slice(0, 200)
        };
      }
    }
    return null;
  }

  /* The positions tab must be active for the close buttons to exist. */
  function ensurePositionsTab() {
    var tab = findButtonByText(document, 'Positions', true);
    if (tab) {
      var selected = tab.getAttribute('aria-selected') || tab.getAttribute('data-state') || '';
      var active = selected === 'true' || selected === 'active' ||
        (tab.className || '').indexOf('active') !== -1;
      if (!active) clickEl(tab);
    }
  }

  /* ================================================================== *
   * ACTIONS. Each one verifies its own result and throws on failure.
   * ================================================================== */

  async function ensureMarket() {
    var slug = currentMarketSlug();
    var want = config.market.toLowerCase();
    if (slug && slug.toLowerCase() === want) return;
    log('WARN', 'not on the configured market page', { slug: slug, want: want });
    window.location.assign('/trade/' + want);
    await waitFor(function () {
      var s = $(SEL.submitBtn);
      return s && isVisible(s) ? s : null;
    }, 20000, 500, 'trade form after market navigation');
    var slug2 = currentMarketSlug();
    if (!slug2 || slug2.toLowerCase() !== want) {
      throw new Error('market navigation failed: still on ' + slug2 + ', want ' + want);
    }
    log('INFO', 'navigated to market page', { slug: slug2 });
  }

  async function ensureOrderTypeMarket() {
    if (config.orderType !== 'market') throw new Error('only market orders are supported');
    var limitInput = $(SEL.limitPriceInput);
    if (!limitInput) return; // already on market (no limit price field)
    var toggle = $(SEL.orderTypeToggle);
    var marketBtn = toggle ? findButtonByText(toggle, 'Market', true) : findButtonByText(document, 'Market', true);
    if (!marketBtn) throw new Error('order type toggle: Market button not found while Limit is active');
    clickEl(marketBtn);
    await sleep(500);
    if ($(SEL.limitPriceInput)) throw new Error('could not switch order type back to Market');
    log('INFO', 'order type switched to Market');
  }

  async function setSide(side) {
    var toggle = $(SEL.sideToggle);
    if (!toggle) throw new Error('selector not found: side toggle');
    var label = side === 'long' ? 'Buy / Long' : 'Sell / Short';
    var btn = findButtonByText(toggle, label, true);
    if (!btn) throw new Error('side button not found: ' + label);
    if (btn.getAttribute('aria-pressed') !== 'true') clickEl(btn);
    await sleep(300);
    var pressed = btn.getAttribute('aria-pressed');
    if (pressed !== null && pressed !== 'true') throw new Error('side did not switch to ' + side);
    log('INFO', 'side set', { side: side });
  }

  /* Set leverage to the highest the market allows, via the popover
   * slider keyboard controls (focus + End key). Verifies the result. */
  async function setLeverageMax() {
    var want = config.leverage === 'max' ? null : Number(config.leverage);
    var btn = $(SEL.leverageBtn);
    if (!btn) throw new Error('selector not found: leverage button');
    if (leverageLocked()) throw new Error('leverage locked (a position or order is open on this market)');
    var cur = readLeverage();
    var max = await readMaxLeverage();
    var target = want || max;
    if (target > max) {
      log('WARN', 'configured leverage above market max, using max', { want: want, max: max });
      target = max;
    }
    if (cur === target) { log('INFO', 'leverage already at target', { lev: target }); return target; }
    clickEl(btn);
    var slider = await waitFor(function () {
      var s = $(SEL.leverageSlider);
      return s && isVisible(s) ? s : null;
    }, 5000, 250, 'leverage slider');
    slider.focus();
    pressKey(slider, 'End'); // jump to max
    await sleep(300);
    var now = parseInt(slider.getAttribute('aria-valuenow'), 10);
    var guard = 0;
    while (now > target && guard < 60) { // step down if target is below max
      pressKey(slider, 'ArrowLeft');
      await sleep(120);
      now = parseInt(slider.getAttribute('aria-valuenow'), 10);
      guard++;
    }
    if (now !== target) throw new Error('leverage did not reach target', { want: target, got: now });
    clickEl(btn); // close popover
    await sleep(300);
    var shown = readLeverage();
    if (shown !== target) throw new Error('leverage display mismatch after set', { want: target, shown: shown });
    log('INFO', 'leverage set', { lev: target, max: max });
    return target;
  }

  /* Set size by percent of max affordable, via the size slider keyboard
   * controls (End, then ArrowLeft steps). Verifies aria-valuenow. */
  async function setSizePct(pct) {
    var slider = $(SEL.sizeSlider);
    if (!slider) throw new Error('selector not found: size slider');
    if (slider.getAttribute('aria-disabled') === 'true') throw new Error('size slider disabled');
    slider.focus();
    pressKey(slider, 'End'); // 100
    await sleep(300);
    var now = readSizePct();
    var guard = 0;
    while (now != null && now > pct && guard < 120) {
      pressKey(slider, 'ArrowLeft');
      await sleep(100);
      now = readSizePct();
      guard++;
    }
    while (now != null && now < pct && guard < 120) {
      pressKey(slider, 'ArrowRight');
      await sleep(100);
      now = readSizePct();
      guard++;
    }
    if (now !== pct) throw new Error('size slider did not reach target pct', { want: pct, got: now });
    await sleep(400); // let the form recompute margin/fee
    log('INFO', 'size slider set', { pct: pct });
  }

  /* Type an exact base size into the size input (TEST_MODE path).
   * Verifies the form picked it up via the summary margin. */
  async function setSizeBase(base) {
    var input = $(SEL.sizeInput);
    if (!input) throw new Error('selector not found: size input');
    if (input.disabled) throw new Error('size input disabled');
    input.focus();
    setNativeInputValue(input, base.toFixed(6));
    await sleep(600);
    var shown = parseMoney(input.value);
    if (shown == null || Math.abs(shown - base) > base * 0.2 + 0.000001) {
      throw new Error('size input did not take the typed value', { want: base, shown: shown });
    }
    var summary = readSummary();
    if (summary.margin == null || summary.margin <= 0) {
      throw new Error('form margin is zero after typing size; size was rejected');
    }
    log('INFO', 'size typed', { base: base, margin: summary.margin, feeEst: summary.fee });
    return summary;
  }

  /* Submit the order. Handles the optional confirm modal (it appears only
   * if the user enabled order confirmation in settings). */
  async function submitOrder(side) {
    var btn = $(SEL.submitBtn);
    if (!btn) throw new Error('selector not found: submit button');
    if (btn.disabled) {
      var warn = readFormWarning();
      throw new Error('submit button disabled' + (warn ? ': ' + warn : ''));
    }
    clickEl(btn);
    var confirmBtn = null;
    try {
      confirmBtn = await waitFor(function () {
        var b = findButtonByText(document, side === 'long' ? 'Confirm Buy' : 'Confirm Sell', true);
        return b && isVisible(b) ? b : null;
      }, config.confirmModalWaitSeconds * 1000, 400, 'order confirm modal');
    } catch (e) { confirmBtn = null; }
    if (confirmBtn) {
      log('INFO', 'order confirm modal appeared, confirming');
      clickEl(confirmBtn);
      await sleep(800);
    } else {
      // No modal: either confirmation is off, or the click did nothing.
      // The position check below will tell us which.
      log('INFO', 'no confirm modal (confirmation likely off)');
    }
  }

  function readFormWarning() {
    var status = $('[role="status"]');
    if (status && status.textContent) return status.textContent.trim().slice(0, 200);
    return null;
  }

  async function waitForPosition(timeoutMs) {
    return waitFor(function () { return readOpenPosition(); }, timeoutMs, config.pollMs, 'open position');
  }

  /* Close the open position at market. Returns after the position is gone.
   * Throws on timeout; the caller then enters rescue mode. */
  async function closePosition() {
    ensurePositionsTab();
    await sleep(500);
    var btn = $(SEL.closeBtnMarket);
    if (!btn) {
      // Fallback: any close button whose aria-label starts with Close position.
      btn = document.querySelector('button[aria-label^="Close position"]');
      if (!btn) throw new Error('close button not found for market ' + config.market);
    }
    if (!isVisible(btn)) throw new Error('close button not visible');
    clickEl(btn);
    // The close modal may or may not appear (there is a "don't show again" option).
    var modalBtn = null;
    try {
      modalBtn = await waitFor(function () {
        var b = findButtonByText(document, 'Close 100% at market', true);
        return b && isVisible(b) ? b : null;
      }, 4000, 300, 'close confirm button');
    } catch (e) { modalBtn = null; }
    if (modalBtn) {
      log('INFO', 'close modal appeared, confirming 100% at market');
      clickEl(modalBtn);
    } else {
      log('INFO', 'no close modal (close likely executed directly)');
    }
    await waitFor(function () { return readOpenPosition() === null; },
      config.closeTimeoutSeconds * 1000, config.pollMs, 'position to close');
    log('INFO', 'position closed');
  }

  /* ================================================================== *
   * FAUCET. The reclaim modal auto claims on open (the app calls
   * claimInline on mount), so the bot only has to open it and wait for
   * the done state. Cooldown is respected: at most one attempt per
   * faucetCooldownMinutes, and if the modal reports a cooldown the bot
   * records it and does not retry until then.
   * ================================================================== */
  async function claimFaucet() {
    if (!config.faucetEnabled) return false;
    var now = Date.now();
    if (state.faucetLastAttemptAt && now - state.faucetLastAttemptAt < config.faucetCooldownMinutes * 60000) {
      log('INFO', 'faucet skipped: inside cooldown window');
      return false;
    }
    state.faucetLastAttemptAt = now;
    saveState();
    var before = readAvailable();
    log('INFO', 'faucet: attempting reclaim', { balanceBefore: before });

    // The app auto prompts the reclaim modal when balance is low, so it
    // may already be open. Otherwise open the wallet menu and click the row.
    var modalOpen = await waitFor(function () {
      return findButtonByText(document, 'Back to trading', true) ||
        document.body.textContent.indexOf('Top up your account') !== -1 ? true : null;
    }, 3000, 500, 'auto prompted reclaim modal').catch(function () { return false; });

    if (!modalOpen) {
      var row = $(SEL.faucetReclaimRow);
      if (!row) {
        // Open the wallet menu: the trigger is the header button showing the
        // address or balance. Best effort: look for a header button with a
        // 0x address or a USDCx balance in its text.
        var headerBtn = null;
        var btns = $$('header button');
        for (var i = 0; i < btns.length; i++) {
          var t = btns[i].textContent || '';
          if (/0x[0-9a-fA-F]{4}/.test(t) || /USDCx/.test(t)) { headerBtn = btns[i]; break; }
        }
        if (!headerBtn) {
          log('WARN', 'faucet: wallet menu trigger not found; parent must reclaim manually');
          return false;
        }
        clickEl(headerBtn);
        await sleep(800);
        row = $(SEL.faucetReclaimRow);
        if (!row) {
          log('WARN', 'faucet: reclaim row not in wallet menu (balance may already be above 2,000)');
          return false;
        }
      }
      clickEl(row);
      await sleep(1000);
    }

    // Wait for the done state ("Funds received" / "Back to trading") or a
    // cooldown message. The claim itself is automatic on modal open.
    var done = false, cooldownHours = null;
    var deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      var body = document.body.textContent || '';
      if (body.indexOf('Funds received') !== -1 || findButtonByText(document, 'Back to trading', true)) { done = true; break; }
      var cd = body.match(/Try again in (\d+)h/);
      if (/Faucet on cooldown/.test(body)) { cooldownHours = cd ? parseInt(cd[1], 10) : 1; break; }
      if (/Account already funded/.test(body)) { log('INFO', 'faucet: account already funded'); break; }
      await sleep(1000);
    }
    if (cooldownHours != null) {
      state.faucetLastAttemptAt = Date.now() + cooldownHours * 3600000;
      saveState();
      log('WARN', 'faucet on cooldown', { hours: cooldownHours });
      var closeBtn = findButtonByText(document, 'Back to trading', true) || findButtonByText(document, 'Cancel', true);
      if (closeBtn) clickEl(closeBtn);
      return false;
    }
    if (done) {
      var backBtn = findButtonByText(document, 'Back to trading', true);
      if (backBtn) clickEl(backBtn);
      await sleep(1500);
      var after = readAvailable();
      log('INFO', 'faucet: reclaim done', { balanceBefore: before, balanceAfter: after });
      return after != null && before != null && after > before;
    }
    log('WARN', 'faucet: modal did not reach done state within 60s');
    return false;
  }

  /* ================================================================== *
   * ROUND TRIP + LOOP.
   * ================================================================== */
  function plannedNotional(balance, leverage) {
    if (config.testMode) return config.testNotionalUsd;
    return balance * (config.marginPct / 100) * leverage;
  }

  async function preflight() {
    if (killRequested()) throw new Error('kill switch set');
    var sess = readSession();
    if (!sess.present) throw new Error('no trading session in this browser (log in and enable trading first)');
    if (sess.expired) throw new Error('trading session expired at ' + sess.expiresAt + '; re-authorize trading in the app');
    var balance = readAvailable();
    if (balance == null) throw new Error('available balance unreadable');
    state.balanceLast = balance;
    if (state.balanceStart == null) state.balanceStart = balance;
    if (balance < config.balanceCriticalUsdc) throw new Error('balance below critical floor', { balance: balance });
    if (balance < config.balanceFloorUsdc) {
      log('WARN', 'balance below floor, trying faucet', { balance: balance });
      var ok = await claimFaucet();
      balance = readAvailable();
      if (balance == null || balance < config.balanceFloorUsdc) {
        throw new Error('balance still below floor after faucet attempt', { balance: balance, faucetOk: ok });
      }
    }
    var open = readOpenPosition();
    if (open) throw new Error('a position is already open on ' + config.market + '; not touching unknown state', { open: open });
    // Max leverage is read live once, then cached; the market does not change mid session.
    var maxLev = state.maxLeverageSeen || await readMaxLeverage();
    var lev = config.leverage === 'max' ? maxLev : Math.min(Number(config.leverage), maxLev);
    var notional = plannedNotional(balance, lev);
    if (sess.maxNotional != null && sess.maxNotional > 0 && notional > sess.maxNotional) {
      throw new Error('session maxNotional cap too low for planned size', { cap: sess.maxNotional, planned: Math.round(notional) });
    }
    if (config.maxDailyFeesUsdc > 0) {
      var today = new Date().toISOString().slice(0, 10);
      if (state.feesDate !== today) { state.feesDate = today; state.feesEstUsd = 0; saveState(); }
      if (state.feesEstUsd >= config.maxDailyFeesUsdc) throw new Error('daily fee cap reached', { fees: state.feesEstUsd });
    }
    return { session: sess, balance: balance, maxLeverage: maxLev, leverage: lev, notional: notional };
  }

  async function runRoundTrip() {
    var side = state.nextSide || config.firstSide;
    var t0 = Date.now();
    log('INFO', '--- round trip start ---', { side: side, mode: config.testMode ? 'TEST' : 'FULL' });
    var pf = await preflight();
    await ensureMarket();
    await ensureOrderTypeMarket();
    var lev = await setLeverageMax();
    await setSide(side);

    var feeOpenEst = null, openNotional = null;
    if (config.testMode) {
      var mark = readMarkPrice();
      if (!mark) throw new Error('mark price unreadable; cannot size the test trade');
      var base = config.testNotionalUsd / mark;
      var summary = await setSizeBase(base);
      feeOpenEst = summary.fee;
      openNotional = config.testNotionalUsd;
    } else {
      await setSizePct(config.marginPct);
      await sleep(400);
      var s2 = readSummary();
      feeOpenEst = s2.fee;
      if (s2.margin == null || s2.margin <= 0) throw new Error('margin is zero after setting size; form rejected the size');
      var avail = readAvailable();
      if (avail != null) {
        var marginFrac = s2.margin / avail;
        if (marginFrac > 0.99) throw new Error('margin would use more than 99% of balance; size slider misread', { margin: s2.margin, avail: avail });
        if (marginFrac < config.marginPct / 100 - 0.15) throw new Error('margin far below target pct; size slider misread', { margin: s2.margin, avail: avail, frac: marginFrac });
      }
      openNotional = s2.margin * lev;
      log('INFO', 'full size ready', { margin: s2.margin, notional: Math.round(openNotional), feeEst: feeOpenEst });
    }

    await submitOrder(side);
    var pos = await waitForPosition(config.openTimeoutSeconds * 1000);
    var entryPrice = pos.entryPrice || readMarkPrice();
    if (entryPrice && pos.size) openNotional = pos.size * entryPrice;
    log('INFO', 'position open', { side: pos.side, size: pos.size, entry: entryPrice, notional: Math.round(openNotional || 0) });

    // Hold. Watch the position every second; if it vanishes early, abort.
    var holdUntil = Date.now() + config.holdSeconds * 1000;
    var forceCloseAt = Date.now() + config.maxHoldSeconds * 1000;
    while (Date.now() < holdUntil) {
      if (killRequested()) { log('WARN', 'kill requested during hold; closing now'); break; }
      if (!readOpenPosition()) throw new Error('position vanished during hold (liquidated or closed externally?)');
      await sleep(500);
    }

    // Close, with a hard deadline. Any failure here goes to rescue mode.
    try {
      await closePosition();
    } catch (e) {
      log('ERROR', 'close failed, entering rescue mode', { err: String(e && e.message || e) });
      setStatus('rescue', 'close failed: ' + String(e && e.message || e));
      await rescueLoop();
      return; // rescueLoop either closed it (trip counted as rescued) or the parent stopped us
    }
    if (Date.now() > forceCloseAt) log('WARN', 'hold exceeded maxHoldSeconds before close finished');

    var balanceAfter = readAvailable();
    var closeNotional = openNotional; // close happens seconds later at ~the same price; flagged as estimate
    var volume = (openNotional || 0) + (closeNotional || 0);
    state.roundTrips += 1;
    state.totalVolumeUsd += volume;
    if (feeOpenEst != null) state.feesEstUsd += feeOpenEst;
    if (balanceAfter != null) state.balanceLast = balanceAfter;
    state.lastRoundTripAt = nowIso();
    state.nextSide = config.alternateSides ? (side === 'long' ? 'short' : 'long') : side;
    saveState();
    log('INFO', '--- round trip done ---', {
      trips: state.roundTrips,
      volumeTrip: Math.round(volume),
      volumeTotal: Math.round(state.totalVolumeUsd),
      feesEstTotal: +state.feesEstUsd.toFixed(2),
      balanceAfter: balanceAfter,
      ms: Date.now() - t0
    });
  }

  /* Rescue mode: farming is halted, but the bot keeps trying to close the
   * open position every 30s until it is gone or the parent stops it.
   * It never walks away from a max leverage open position on its own. */
  async function rescueLoop() {
    state.rescueAttempts = 0;
    while (true) {
      if (killRequested() || state.status === 'stopped') {
        log('ERROR', 'rescue stopped by parent with position possibly still open; CLOSE IT MANUALLY');
        return;
      }
      if (!readOpenPosition()) {
        log('INFO', 'rescue: position is gone');
        state.nextSide = state.nextSide || config.firstSide;
        setStatus('stopped', 'rescued close; loop halted, parent must restart');
        return;
      }
      state.rescueAttempts += 1;
      log('ERROR', 'rescue attempt ' + state.rescueAttempts + ': trying to close again');
      try {
        await closePosition();
      } catch (e) {
        log('ERROR', 'rescue close attempt failed', { err: String(e && e.message || e) });
      }
      if (!readOpenPosition()) {
        log('INFO', 'rescue: position closed on attempt ' + state.rescueAttempts);
        setStatus('stopped', 'rescued close; loop halted, parent must restart');
        return;
      }
      await sleep(30000);
    }
  }

  var loopRunning = false;
  async function loop() {
    if (loopRunning) return;
    loopRunning = true;
    clearKill();
    setStatus('running');
    state.startedAt = state.startedAt || nowIso();
    if (!state.nextSide) state.nextSide = config.firstSide;
    saveState();
    log('INFO', 'loop started', { mode: config.testMode ? 'TEST' : 'FULL', market: config.market });
    try {
      while (true) {
        if (killRequested()) { log('INFO', 'kill switch set, stopping loop'); break; }
        if (state.status === 'rescue') break;
        if (config.maxRoundTrips > 0 && state.roundTrips >= config.maxRoundTrips) {
          log('INFO', 'max round trips reached', { n: state.roundTrips });
          break;
        }
        try {
          await runRoundTrip();
        } catch (e) {
          var msg = String(e && e.message || e);
          log('ERROR', 'round trip failed, loop halted', { err: msg });
          setStatus('error', msg);
          break;
        }
        if (killRequested()) { log('INFO', 'kill switch set after round trip, stopping'); break; }
        if (state.status === 'rescue' || state.status === 'error') break;
        // Gap between round trips, checked once a second so STOP is responsive.
        var gapUntil = Date.now() + config.gapSeconds * 1000;
        while (Date.now() < gapUntil) {
          if (killRequested()) break;
          await sleep(1000);
        }
        if (killRequested()) break;
      }
    } finally {
      loopRunning = false;
      if (state.status === 'running') setStatus('stopped');
      log('INFO', 'loop ended', { status: state.status, trips: state.roundTrips, volume: Math.round(state.totalVolumeUsd) });
    }
  }

  /* ================================================================== *
   * PUBLIC API + ACTIVATION.
   * ================================================================== */
  var api = {
    version: VERSION,
    config: config,
    activated: false,
    status: function () {
      return {
        version: VERSION,
        status: state.status,
        config: Object.assign({}, config),
        state: Object.assign({}, state),
        session: readSession(),
        balance: readAvailable(),
        marketSlug: currentMarketSlug(),
        killRequested: killRequested(),
        log: logLines.slice(-50)
      };
    },
    start: function () {
      if (state.status === 'running' || state.status === 'rescue') return 'already running';
      if (state.status === 'error' || state.status === 'stopped') {
        state.lastError = null;
      }
      loop();
      return 'starting';
    },
    stop: function () {
      requestStop();
      if (state.status === 'running') setStatus('stopping');
      log('INFO', 'stop requested (current round trip, if any, will close first)');
      return 'stopping';
    },
    setConfig: function (patch) {
      Object.assign(config, patch || {});
      log('INFO', 'config updated', patch || {});
      renderPanel();
      return Object.assign({}, config);
    },
    getLog: function () { return logLines.slice(); },
    getState: function () { return Object.assign({}, state); },
    readSession: readSession,
    readAvailable: readAvailable,
    claimFaucet: claimFaucet,
    resetStats: function () {
      state.roundTrips = 0; state.totalVolumeUsd = 0; state.feesEstUsd = 0;
      state.balanceStart = readAvailable(); state.feesDate = new Date().toISOString().slice(0, 10);
      saveState(); renderPanel();
      return 'stats reset';
    }
  };
  window.__titanVolBot = api;

  /* Route observer: if the user navigates away from the trade page while
   * running, finish the current round trip safely and halt. The parent
   * must press START again after coming back. Never auto resume. */
  var lastPath = window.location.pathname;
  setInterval(function () {
    if (window.location.pathname === lastPath) return;
    var from = lastPath;
    lastPath = window.location.pathname;
    log('WARN', 'route changed', { from: from, to: lastPath });
    if (state.status === 'running') {
      requestStop();
      setStatus('paused-route', 'navigated away from the trade page');
      log('WARN', 'loop halted by route change; press START after returning to the trade page');
    }
    renderPanel();
  }, 2000);

  /* Activation: wait for the trade form, then render the panel and prove
   * the injection worked. No trading starts here. */
  async function activate() {
    loadState();
    clearKill();
    state.status = 'idle';
    try {
      await waitFor(function () {
        var b = $(SEL.submitBtn);
        return b && isVisible(b) ? b : null;
      }, 30000, 500, 'trade form submit button');
    } catch (e) {
      log('ERROR', 'ACTIVATION FAILED: trade form not found. Are you on a /trade page while logged in?', { err: String(e.message) });
      buildPanel();
      if (panelStatusEl) panelStatusEl.textContent = 'ACTIVATION FAILED: trade form not found. Open /trade/BTC while logged in, then re-inject.';
      return;
    }
    buildPanel();
    var sess = readSession();
    var bal = readAvailable();
    var lev = readLeverage();
    api.activated = true;
    log('INFO', 'ACTIVATED', {
      route: window.location.pathname,
      marketSlug: currentMarketSlug(),
      session: sess.present ? (sess.expired ? 'EXPIRED' : 'ok') : 'NONE',
      maxNotional: sess.maxNotional,
      expiresAt: sess.expiresAt,
      balance: bal,
      leverage: lev,
      testMode: config.testMode,
      market: config.market
    });
    if (!sess.present) log('WARN', 'no trading session found in this browser; log in and enable trading, then re-inject');
    if (sess.present && sess.expired) log('WARN', 'trading session expired; re-authorize trading in the app, then re-inject');
    if (bal != null && bal < config.balanceFloorUsdc) log('WARN', 'balance below floor; the faucet will be tried on start', { balance: bal });
    log('INFO', 'READY. Press START in the panel or call __titanVolBot.start(). TEST_MODE is ' + (config.testMode ? 'ON' : 'OFF') + '.');
  }

  activate();
})();
