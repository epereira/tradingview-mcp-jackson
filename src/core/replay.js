/**
 * Core replay mode logic.
 */
import { evaluate, getReplayApi } from '../connection.js';

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

export async function start({ date } = {}) {
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);
  await new Promise(r => setTimeout(r, 500));
  let handled = await dismissReplayDialogs();

  if (date) await evaluate(`${rp}.selectDate(new Date('${date}'))`);
  else await evaluate(`${rp}.selectFirstAvailableDate()`);
  await new Promise(r => setTimeout(r, 1000));

  // If a previous replay session with trades was saved on this chart, TradingView
  // shows a blocking "Continue your last replay?" dialog. While it is open, doStep()
  // and orders silently do nothing, so always start a fresh session.
  handled = handled.concat(await dismissReplayDialogs());
  if (handled.length) await new Promise(r => setTimeout(r, 1000));

  // Check for "Data point unavailable" toast which corrupts the chart
  const toast = await evaluate(`
    (function() {
      var toasts = document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="banner"]');
      for (var i = 0; i < toasts.length; i++) {
        var text = toasts[i].textContent || '';
        if (/data point unavailable|not available for playback/i.test(text)) return text.trim().substring(0, 200);
      }
      return null;
    })()
  `);

  if (toast) {
    // Stop replay to recover chart
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
    throw new Error(`Replay date unavailable: "${toast}". The requested date has no data for this timeframe. Try a more recent date or switch to a higher timeframe (e.g., Daily).`);
  }

  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  const currentDate = await evaluate(wv(`${rp}.currentDate()`));
  return { success: true, replay_started: !!started, date: date || '(first available)', current_date: currentDate, ...(handled.length ? { dialogs_handled: handled } : {}) };
}

// TradingView opens blocking dialogs around replay sessions that contain trades:
//  - "Continue your last replay?"  (on start)             -> click "Start new"
//  - "Leave current replay?"       (on stop / new date)   -> click "Leave" (no save)
//  - a stray date picker left open by the toolbar         -> close it
// While any of these is open, doStep() and orders silently do nothing.
async function dismissReplayDialogs() {
  return evaluate(`
    (function() {
      function vis(e) { return !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }
      function findBtn(root, re, attr) {
        var bs = Array.prototype.slice.call(root.querySelectorAll('button'));
        for (var i = 0; i < bs.length; i++) {
          var b = bs[i];
          var label = attr ? (b.getAttribute('aria-label') || b.getAttribute('data-name') || '') : (b.innerText || '');
          if (re.test(label.trim())) return b;
        }
        return null;
      }
      var handled = [];
      var dialogs = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"], [data-dialog-name], [class*="dialog"]')).filter(vis);
      for (var i = 0; i < dialogs.length; i++) {
        var d = dialogs[i], text = d.innerText || '', b = null;
        if (/dernier replay|last replay|previous replay/i.test(text)) {
          b = findBtn(d, /nouveau|new/i);
          if (b) { b.click(); handled.push('resume_dialog:started_new'); }
        } else if (/Quitter le replay|Leave (the )?(current )?replay|Exit (the )?(current )?replay/i.test(text)) {
          b = findBtn(d, /^(Quitter|Leave|Exit)$/i);
          if (b) { b.click(); handled.push('leave_dialog:left_without_saving'); }
        } else if (/Sélectionner la date|Select date|Select a date/i.test(text)) {
          b = findBtn(d, /Fermer le menu|Close menu|^close$/i, true);
          if (b) { b.click(); handled.push('date_picker:closed'); }
        }
      }
      return handled;
    })()
  `);
}

export async function step() {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  await evaluate(`${rp}.doStep()`);
  const currentDate = await evaluate(wv(`${rp}.currentDate()`));
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed } = {}) {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop() {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    // Try to hide toolbar even if not started
    try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
    return { success: true, action: 'already_stopped' };
  }
  await evaluate(`${rp}.stopReplay()`);
  await new Promise(r => setTimeout(r, 500));
  const handled = await dismissReplayDialogs();
  if (handled.length) await new Promise(r => setTimeout(r, 1000));
  try { await evaluate(`${rp}.hideReplayToolbar()`); } catch {}
  const stillStarted = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (stillStarted) {
    return { success: false, action: 'replay_stopped', error: 'Replay is still running (a confirmation dialog may be open)', ...(handled.length ? { dialogs_handled: handled } : {}) };
  }
  return { success: true, action: 'replay_stopped', ...(handled.length ? { dialogs_handled: handled } : {}) };
}

// Replay trading goes through the replay trading model (one per chart). In some
// layouts (replay broker mode, multi-frame) the model is not created until the
// "Trading en replay" panel is used, so buy()/sell() silently no-op. This snippet
// lazily initialises the models and returns the active one.
function tradeModelExpr(rp) {
  return `(function(){
    var r = ${rp};
    var ctl = r._replayUIController && r._replayUIController.tradingUIController
      ? r._replayUIController.tradingUIController() : null;
    if (!ctl) return null;
    var m = ctl.activeModel ? ctl.activeModel() : null;
    if (!m && typeof ctl._initTradingModels === 'function') {
      try { ctl._initTradingModels(); } catch (e) {}
      m = ctl.activeModel ? ctl.activeModel() : null;
    }
    return m;
  })()`;
}

// Read position / realized P&L / executions, preferring the trading model over
// _replayApi.position(), which stays null in replay-broker mode.
function tradeStateExpr(rp) {
  return `(function(){
    function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
    var r = ${rp};
    var m = ${tradeModelExpr(rp)};
    var pos = null, pnl = null, execs = [];
    if (m) {
      try { pos = unwrap(m.position()); } catch (e) {}
      try { pnl = unwrap(m.realizedPL()); } catch (e) {}
      try { execs = unwrap(m.executions()) || []; } catch (e) {}
    }
    if (pos == null) { try { pos = unwrap(r.position()); } catch (e) {} }
    if (pnl == null) { try { pnl = unwrap(r.realizedPL()); } catch (e) {} }
    var position = pos ? { side: pos.side === 1 || pos.qty > 0 ? 'long' : 'short', qty: Math.abs(pos.qty || 0), avg_price: pos.avgPrice, unrealized_pnl: pos.extra && pos.extra.pl != null ? pos.extra.pl : null } : null;
    var last = execs.length ? execs[execs.length - 1] : null;
    return {
      model_ready: !!m,
      position: position,
      realized_pnl: pnl,
      execution_count: execs.length,
      last_execution: last ? { side: last.side === 1 ? 'buy' : 'sell', qty: last.qty, price: last.price, time: last.time_t } : null,
    };
  })()`;
}

async function readTradeState(rp) {
  return evaluate(tradeStateExpr(rp));
}

export async function trade({ action, qty = 1 } = {}) {
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (!['buy', 'sell', 'close'].includes(action)) throw new Error('Invalid action. Use: buy, sell, or close');

  const quantity = Number(qty);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('qty must be a positive number');

  const modelReady = await evaluate(`!!(${tradeModelExpr(rp)})`);
  if (!modelReady) throw new Error('Replay trading model not available. Open the "Replay trading" panel once, or make sure the active chart is in replay mode.');

  const before = await readTradeState(rp);
  if (action === 'close' && !before.position) {
    return { success: true, action, note: 'No open position to close', ...before };
  }

  if (action === 'buy') await evaluate(`${rp}.buy(${quantity})`);
  else if (action === 'sell') await evaluate(`${rp}.sell(${quantity})`);
  else await evaluate(`${rp}.closePosition()`);

  // Fills are applied asynchronously; poll briefly until an execution shows up.
  let after = before;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 150));
    after = await readTradeState(rp);
    if (after.execution_count > before.execution_count) break;
  }

  if (after.execution_count === before.execution_count) {
    return { success: false, action, error: 'Order was not executed (no new execution reported by replay trading model)', ...after };
  }
  return { success: true, action, qty: action === 'close' ? undefined : quantity, ...after };
}

export async function status() {
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  let tradeState = { position: null, realized_pnl: null };
  if (st.is_replay_started) {
    try { tradeState = await readTradeState(rp); } catch {}
  }
  return { success: true, ...st, position: tradeState.position, realized_pnl: tradeState.realized_pnl, execution_count: tradeState.execution_count ?? 0, last_execution: tradeState.last_execution ?? null };
}
