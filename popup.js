'use strict';

if (typeof browser === 'undefined') var browser = chrome;

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayStr() { return new Date().toISOString().slice(0, 10); }

function freshToday() {
  return {
    date: todayStr(),
    msgs: 0,
    convos: 0,
    time_s: 0,
    tokens_est: 0,
    effort_breakdown: { low: 0, medium: 0, high: 0, max: 0 },
    processed_msg_uuids: [],
    recent_sent_prompts: []
  };
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTokens(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtPct(pct) {
  if (pct == null || isNaN(Number(pct))) return '—';
  const v = Math.round(Number(pct) * 10) / 10;
  return `${Number.isInteger(v) ? Math.trunc(v) : v}%`;
}

function getThresholdColor(pct) {
  if (pct == null) return '';
  if (Number(pct) > 80) return '#ef4444';
  if (Number(pct) > 50) return '#f59e0b';
  return '#4ade80';
}

const SESSION_TOKEN_LIMIT = 375000;
const WEEKLY_TOKEN_LIMIT = 3750000;

function formatTokenCount(value) {
  return new Intl.NumberFormat('en-IN').format(Math.max(0, Math.round(value || 0)));
}

function getSessionTooltipText(sessionPct) {
  if (sessionPct == null) return '';
  const used = Math.round((Number(sessionPct) / 100) * SESSION_TOKEN_LIMIT);
  return `${formatTokenCount(used)} / ${formatTokenCount(SESSION_TOKEN_LIMIT)} tokens (${Math.round(sessionPct)}%)`;
}

function getWeeklyTooltipText(weeklyPct) {
  if (weeklyPct == null) return '';
  const used = Math.round((Number(weeklyPct) / 100) * WEEKLY_TOKEN_LIMIT);
  return `${formatTokenCount(used)} / ${formatTokenCount(WEEKLY_TOKEN_LIMIT)} tokens (${Math.round(weeklyPct)}%)`;
}

function getPeakStatus() {
  const now  = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istMs = utcMs + 5.5 * 3600000;
  const ist   = new Date(istMs);
  const curH  = ist.getHours() + ist.getMinutes() / 60;
  const day   = ist.getDay(); // 0 = Sun
  const isWeekend = day === 0 || day === 6;
  const inPeak    = !isWeekend && (curH >= 18.5 || curH < 0.5);
  return { inPeak, isWeekend };
}

function formatResetDisplay(timestamp) {
  if (!timestamp) return '';
  const diff = new Date(timestamp).getTime() - Date.now();
  if (diff <= 0) return 'Resetting now…';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h remaining`;
  if (h === 0)  return `${m}m remaining`;
  return `${h}h ${m}m remaining`;
}

function calcUsageRateState(sessionPct, sessionResetsAt) {
  if (sessionPct == null || !sessionResetsAt) return 'gray';
  const pct = Number(sessionPct);
  if (!isFinite(pct)) return 'gray';
  const msRemaining = new Date(sessionResetsAt).getTime() - Date.now();
  if (msRemaining <= 0) return 'gray';
  const hoursElapsed = 5 - msRemaining / 3600000;
  if (hoursElapsed <= 0) return pct > 0 ? 'extreme' : 'gray';
  const rate = pct / hoursElapsed;
  if (rate >= 30) return 'extreme';
  if (rate > 21)  return 'up';
  if (rate >= 19) return 'neutral';
  return 'down';
}

// ─── DOM shorthand ───────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function setBar(barId, pct) {
  const b = el(barId);
  if (b) b.style.width = Math.min(100, Math.max(0, pct || 0)) + '%';
}

function showFeedback(elemId, msg) {
  const e = el(elemId);
  if (!e) return;
  e.textContent = msg;
  e.classList.add('visible');
  setTimeout(() => e.classList.remove('visible'), 2200);
}

// ─── Tab switching ───────────────────────────────────────────────────────────

function initTabs() {
  const tabs   = document.querySelectorAll('.px-tab');
  const panels = document.querySelectorAll('.px-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => { t.classList.remove('px-tab-active'); t.setAttribute('aria-selected', 'false'); });
      panels.forEach(p => p.classList.remove('px-panel-active'));
      tab.classList.add('px-tab-active');
      tab.setAttribute('aria-selected', 'true');
      const panel = el(tab.getAttribute('aria-controls'));
      if (panel) panel.classList.add('px-panel-active');
    });
  });
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function refreshDashboard() {
  const res = await browser.storage.local.get(['today', 'usage_limits', 'debug_logs']);
  const today  = res.today         || freshToday();
  const limits = res.usage_limits  || {};

  // ── Status banner + live dot ──
  const { inPeak } = getPeakStatus();
  
  let onClaude = false;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && tabs[0].url) {
      const url = tabs[0].url;
      if (url.includes('claude.ai')) {
        onClaude = true;
      }
    }
  } catch (_) {}

  const bannerEl  = el('px-status-banner');
  const statusTxt = el('px-status-text');
  if (bannerEl && statusTxt) {
    if (onClaude) {
      bannerEl.className = 'px-status-banner px-status-active';
      statusTxt.textContent = 'Sidebar active on Claude.ai';
    } else {
      bannerEl.className = 'px-status-banner px-status-inactive';
      statusTxt.textContent = 'Open claude.ai to track usage';
    }
  }

  const liveDot = el('px-live-dot');
  if (liveDot) {
    liveDot.className = 'px-live-dot ' + (inPeak ? 'dot-peak' : 'dot-off');
  }

  // ── Usage bars ──
  const sessionPct = limits.session_pct;
  const weeklyPct  = limits.weekly_pct;

  const sessionPctEl = el('px-session-pct');
  if (sessionPctEl) {
    sessionPctEl.textContent = fmtPct(sessionPct);
    sessionPctEl.style.color = getThresholdColor(sessionPct);
  }
  const weeklyPctEl = el('px-weekly-pct');
  if (weeklyPctEl) {
    weeklyPctEl.textContent = fmtPct(weeklyPct);
    weeklyPctEl.style.color = getThresholdColor(weeklyPct);
  }

  setBar('px-bar-session', sessionPct);
  const sessionBar = el('px-bar-session');
  if (sessionBar) sessionBar.style.background = getThresholdColor(sessionPct) || '#cc9966';

  setBar('px-bar-weekly', weeklyPct);
  const weeklyBar = el('px-bar-weekly');
  if (weeklyBar) weeklyBar.style.background = getThresholdColor(weeklyPct) || '#4ade80';

  // ── Tooltips for tracks ──
  const sessionTrack = el('px-track-session');
  if (sessionTrack && sessionPct != null) {
    sessionTrack.setAttribute('data-tooltip', getSessionTooltipText(sessionPct));
  } else if (sessionTrack) {
    sessionTrack.removeAttribute('data-tooltip');
  }

  const weeklyTrack = el('px-track-weekly');
  if (weeklyTrack && weeklyPct != null) {
    weeklyTrack.setAttribute('data-tooltip', getWeeklyTooltipText(weeklyPct));
  } else if (weeklyTrack) {
    weeklyTrack.removeAttribute('data-tooltip');
  }

  // ── Rate dot ──
  const rateDot = el('px-rate-dot');
  if (rateDot) {
    const state = calcUsageRateState(sessionPct, limits.session_resets_at);
    rateDot.className = 'px-rate-dot rate-' + state;
    const labels = {
      extreme: 'Overuse ≥30%/h — burning fast!',
      up:      'Above normal >21%/h',
      neutral: 'On track ~20%/h',
      down:    'Below normal <19%/h — good!',
      gray:    'Calculating…',
    };
    rateDot.setAttribute('data-tooltip', labels[state] || 'Calculating…');
    rateDot.removeAttribute('title');
  }

  // ── Reset times ──
  const sessionTimeEl = el('px-session-time');
  if (sessionTimeEl) sessionTimeEl.textContent = formatResetDisplay(limits.session_resets_at);

  const weeklyTimeEl = el('px-weekly-time');
  if (weeklyTimeEl) weeklyTimeEl.textContent = formatResetDisplay(limits.weekly_resets_at);

  // ── Debug badge (Tools tab) ──
  const debugLogs = res.debug_logs || [];
  const badge = el('px-debug-badge');
  if (badge) badge.textContent = debugLogs.length;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

async function exportData() {
  const res  = await browser.storage.local.get(['today', 'history', 'settings', 'usage_limits', 'debug_logs']);
  const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `usagex-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function openDebugViewer() {
  const url = browser.runtime.getURL('debug-viewer.html');
  browser.tabs.create({ url });
}

async function resetTodayStats() {
  const histRes = await browser.storage.local.get('history');
  await browser.storage.local.set({ today: freshToday(), history: histRes.history || [] });
  await refreshDashboard();
  showFeedback('px-action-feedback', '✓ Daily counters reset');
}

async function clearDebugLogs() {
  await browser.storage.local.set({ debug_logs: [] });
  const badge = el('px-debug-badge');
  if (badge) badge.textContent = '0';
  showFeedback('px-action-feedback', '✓ Debug logs cleared');
}

function initTools() {
  el('px-btn-export')?.addEventListener('click', async () => {
    await exportData();
    showFeedback('px-action-feedback', '✓ Exported successfully');
  });

  el('px-btn-debug')?.addEventListener('click', async () => {
    await openDebugViewer();
    window.close();
  });

  el('px-btn-reset')?.addEventListener('click', async () => {
    if (confirm('Reset daily counters (messages, time, tokens)? Session & weekly % are unaffected. This cannot be undone.')) {
      await resetTodayStats();
    }
  });

  el('px-btn-clear-logs')?.addEventListener('click', async () => {
    if (confirm('Clear all debug logs? This cannot be undone.')) {
      await clearDebugLogs();
    }
  });
}

// ─── Open Claude button ──────────────────────────────────────────────────────

function initOpenClaude() {
  const btn = el('px-open-claude');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const tabs = await browser.tabs.query({ url: ['https://claude.ai/*', 'https://www.claude.ai/*'] });
      if (tabs.length > 0) {
        await browser.tabs.update(tabs[0].id, { active: true });
        const win = await browser.windows.get(tabs[0].windowId);
        await browser.windows.update(win.id, { focused: true });
      } else {
        await browser.tabs.create({ url: 'https://claude.ai/' });
      }
    } catch (_) {
      browser.tabs.create({ url: 'https://claude.ai/' });
    }
    window.close();
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  initTabs();
  initTools();
  initOpenClaude();
  await refreshDashboard();
}

document.addEventListener('DOMContentLoaded', init);
