'use strict';

if (typeof browser === "undefined") {
  var browser = chrome;
}

// Clean up any previously injected instance of the content script
if (window.__usagex_cleanup) {
  try {
    window.__usagex_cleanup();
  } catch (e) {
    console.error('[UsageX] Error running cleanup:', e);
  }
}

const UX_ID = 'usagex-v2-root';
const UX_STYLE_ID = 'usagex-v2-styles';
const IDLE_MS = 2 * 60 * 1000;
const TICK_MS = 10000;
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const SESSION_TOKEN_LIMIT = 375000;
const WEEKLY_TOKEN_LIMIT = 3750000;



let lastUrl = location.href;
let lastActive = Date.now();
let isIdle = false;
let sidebarInjected = false;
let isInjecting = false;
let prevSessionPct = null;
let prevWeeklyPct = null;
let usageRateState = 'gray'; // 'extreme' | 'up' | 'neutral' | 'down' | 'gray'

// Global tracking references for cleanups
let tryInjectInterval = null;
let urlCheckInterval = null;
let timeTrackingInterval = null;
let idleCheckInterval = null;
let pollInterval = null;
let peakClockInterval = null;
let globalObserver = null;
let dragMoveHandler = null;
let dragUpHandler = null;
let resetIdleHandler = null;
let windowMsgHandler = null;
let sidebarResizeObserver = null;
let keyboardShortcutHandler = null;

window.__usagex_cleanup = () => {
  if (tryInjectInterval) clearInterval(tryInjectInterval);
  if (urlCheckInterval) clearInterval(urlCheckInterval);
  if (timeTrackingInterval) clearInterval(timeTrackingInterval);
  if (idleCheckInterval) clearInterval(idleCheckInterval);
  if (pollInterval) clearInterval(pollInterval);
  if (peakClockInterval) clearInterval(peakClockInterval);

  if (globalObserver) {
    globalObserver.disconnect();
  }

  if (sidebarResizeObserver) {
    sidebarResizeObserver.disconnect();
  }

  if (resetIdleHandler) {
    ['mousemove','keydown','click','touchstart'].forEach(ev =>
      document.removeEventListener(ev, resetIdleHandler)
    );
  }
  if (keyboardShortcutHandler) {
    document.removeEventListener('keydown', keyboardShortcutHandler, true);
  }

  if (dragMoveHandler) document.removeEventListener('mousemove', dragMoveHandler);
  if (dragUpHandler) document.removeEventListener('mouseup', dragUpHandler);
  if (windowMsgHandler) window.removeEventListener('message', windowMsgHandler);

  // Remove existing elements
  const existingWidget = document.getElementById(UX_ID);
  if (existingWidget) existingWidget.remove();
  const existingStyles = document.getElementById(UX_STYLE_ID);
  if (existingStyles) existingStyles.remove();
  const existingHook = document.getElementById('ux-fetch-hook');
  if (existingHook) existingHook.remove();

  prevSessionPct = null;
  prevWeeklyPct = null;
  usageRateState = 'gray';
  console.log('[UsageX] Cleaned up previous script instance.');
};

// ─── Storage ───────────────────────────────────────────────────────────────────

async function loadToday() {
  const res = await browser.storage.local.get(['today', 'history', 'settings', 'usage_limits']);
  const todayDate = todayStr();
  if (!res.today || res.today.date !== todayDate) {
    const yesterday = res.today;
    if (yesterday) {
      const hist = res.history || [];
      hist.push(yesterday);
      if (hist.length > 30) hist.splice(0, hist.length - 30);
      await browser.storage.local.set({ history: hist });
    }
    await browser.storage.local.set({ today: freshToday() });
    return { today: freshToday(), settings: res.settings || defaultSettings(), usage_limits: res.usage_limits };
  }
  return { today: res.today, settings: res.settings || defaultSettings(), usage_limits: res.usage_limits };
}

async function saveToday(patch) {
  const res = await browser.storage.local.get('today');
  const today = res.today || freshToday();
  const updated = { ...today, ...patch, date: todayStr() };
  await browser.storage.local.set({ today: updated });
  return updated;
}

async function getSettings() {
  const res = await browser.storage.local.get('settings');
  return res.settings || defaultSettings();
}

async function saveSettings(patch) {
  const res = await browser.storage.local.get('settings');
  const s = { ...(res.settings || defaultSettings()), ...patch };
  await browser.storage.local.set({ settings: s });
  return s;
}

function freshToday() {
  return { date: todayStr(), msgs: 0, convos: 0, time_s: 0, tokens_est: 0, effort_breakdown: { low: 0, medium: 0, high: 0, max: 0 } };
}


function defaultSettings() { return { debug_logging: false, sidebar_side: 'left', timezone: 'auto', floating: false, float_x: null, float_y: null, floating_opacity_enabled: true, floating_opacity: 0.85, minimized: false }; }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function setupSidebarResizeObserver(root) {
  if (sidebarResizeObserver) {
    sidebarResizeObserver.disconnect();
  }
  if (!root) return;
  const parent = root.parentElement;
  if (!parent) return;

  sidebarResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const width = entry.contentRect.width;
      const isFloating = root.classList.contains('ux-floating');
      if (!isFloating && width > 0 && width < 180) {
        root.classList.add('ux-parent-collapsed');
      } else {
        root.classList.remove('ux-parent-collapsed');
      }
    }
  });
  sidebarResizeObserver.observe(parent);
}

// ─── Timezone helpers ──────────────────────────────────────────────────────────

function getTimezoneName() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeZoneName: 'short'
  });
  const parts = formatter.formatToParts(new Date());
  return parts.find(p => p.type === 'timeZoneName')?.value || 'UTC';
}

function formatTimeAMPM(date) {
  const h = date.getHours() % 12 || 12;
  const m = date.getMinutes().toString().padStart(2, '0');
  const ampm = date.getHours() >= 12 ? 'PM' : 'AM';
  return `${h}:${m} ${ampm}`;
}

function formatResetTimeDisplay(timestamp, timezone) {
  if (!timestamp) return '-';
  const diff = timestamp - Date.now();
  if (diff <= 0) return 'resetting now';
  const resetDate = new Date(timestamp);
  const timeStr = resetDate.toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  const hoursLeft = Math.floor(diff / (1000 * 60 * 60));
  const minutesLeft = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  let remaining;
  if (hoursLeft >= 24) {
    const days = Math.floor(hoursLeft / 24);
    remaining = `${days}d ${hoursLeft % 24}h remaining`;
  } else if (hoursLeft === 0) {
    remaining = `${minutesLeft}m remaining`;
  } else {
    remaining = `${hoursLeft}h ${minutesLeft}m remaining`;
  }
  return `${remaining} · resets ${timeStr}`;
}

function formatWeeklyResetDisplay(timestamp, timezone) {
  if (!timestamp) return '-';
  const resetDate = new Date(timestamp);
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = dayNames[resetDate.getDay()];
  const date = resetDate.getDate();
  const month = monthNames[resetDate.getMonth()];
  const timeStr = resetDate.toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  const diff = timestamp - Date.now();
  let remaining;
  if (diff <= 0) { remaining = 'resetting now'; }
  else {
    const hoursLeft = Math.floor(diff / (1000 * 60 * 60));
    const minutesLeft = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hoursLeft >= 24) {
      const days = Math.floor(hoursLeft / 24);
      remaining = `${days}d ${hoursLeft % 24}h remaining`;
    } else if (hoursLeft === 0) { remaining = `${minutesLeft}m remaining`; }
    else { remaining = `${hoursLeft}h ${minutesLeft}m remaining`; }
  }
  return `${remaining} · resets ${date} ${month}, ${day} at ${timeStr}`;
}

// ─── Fetch interception (via injected MAIN-world script) ──────────────────────

function injectFetchHook() {
  if (document.getElementById('ux-fetch-hook')) return;
  const script = document.createElement('script');
  script.id = 'ux-fetch-hook';
  script.src = browser.runtime.getURL('inject.js');
  (document.head || document.documentElement).appendChild(script);
}

windowMsgHandler = (event) => {
  if (event.source !== window) return;
  if (event.data.type === '__ux_fetch_msg') {
    onMessageSent({ body: event.data.body }).catch(() => {});
  } else if (event.data.type === '__ux_usage_data') {
    (async () => {
      const d = event.data.data;
      await updateUsageRate(d.session_pct, d.session_resets_at);
      await browser.storage.local.set({ usage_limits: d });
      await updateUI();
    })().catch(() => {});
  }
};
window.addEventListener('message', windowMsgHandler);

// ─── Message tracking ──────────────────────────────────────────────────────────

async function onMessageSent(req) {
  lastActive = Date.now();
  isIdle = false;
  const effort = detectEffort();
  let inputChars = 0;
  try {
    const body = JSON.parse(req.body);
    const lastMsg = body?.messages?.at(-1)?.content;
    if (typeof lastMsg === 'string') inputChars = lastMsg.length;
    else if (Array.isArray(lastMsg)) inputChars = lastMsg.map(b => b.text || '').join('').length;
  } catch (_) {}
  const inputTokens = Math.round(inputChars / 4);
  const thinkTokens = effortThinkTokens(effort);
  const tokenDelta = inputTokens + thinkTokens;
  const res = await browser.storage.local.get('today');
  const today = res.today || freshToday();
  const effortKey = effort.toLowerCase();
  const eb = today.effort_breakdown || { low: 0, medium: 0, high: 0, max: 0 };
  eb[effortKey] = (eb[effortKey] || 0) + 1;
  await saveToday({ msgs: today.msgs + 1, tokens_est: today.tokens_est + tokenDelta, effort_breakdown: eb });
  updateUI().catch(() => {});
  debugLog('msg_sent', { effort, inputTokens, thinkTokens });
  setTimeout(() => {
    fetchUsageLimitsActive().catch(() => {});
  }, 2000);
}

function effortThinkTokens(effort) {
  const map = { Low: 250, Medium: 1500, High: 6000, Max: 20000 };
  return map[effort] || 250;
}

function detectEffort() {
  const selectors = [
    '[data-testid="model-selector"]',
    'button[aria-label*="model"]',
    'button[aria-label*="effort"]',
    '[class*="model-selector"]',
    '[class*="ModelSelector"]',
  ];
  let text = '';
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) { text = el.textContent || ''; break; }
  }
  if (!text) {
    document.querySelectorAll('button').forEach(btn => {
      const t = btn.textContent || '';
      if (t.match(/\b(Low|Medium|High|Max)\b/)) text = t;
    });
  }
  const match = text.match(/\b(Low|Medium|High|Max)\b/);
  return match ? match[1] : 'Low';
}

// ─── URL tracking ──────────────────────────────────────────────────────────────

function checkUrlChange() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (location.pathname.startsWith('/chat/')) {
      browser.storage.local.get('today').then(res => {
        const today = res.today || freshToday();
        saveToday({ convos: today.convos + 1 });
      }).catch(() => {});
      debugLog('new_convo', { url: location.href });
    }
    setTimeout(() => updateUI().catch(() => {}), 500);
  }
}

// ─── Time tracking ─────────────────────────────────────────────────────────────

function startTimeTracking() {
  timeTrackingInterval = setInterval(() => {
    if (!isIdle) {
      browser.storage.local.get('today').then(res => {
        const today = res.today || freshToday();
        saveToday({ time_s: today.time_s + 10 }).catch(() => {});
      }).catch(() => {});
    }
  }, TICK_MS);

  resetIdleHandler = () => {
    lastActive = Date.now();
    if (isIdle) { isIdle = false; updateUI().catch(() => {}); }
  };
  ['mousemove','keydown','click','touchstart'].forEach(ev =>
    document.addEventListener(ev, resetIdleHandler, { passive: true })
  );
  idleCheckInterval = setInterval(() => {
    if (Date.now() - lastActive > IDLE_MS) isIdle = true;
  }, 30000);
}

// ─── UI Injection ──────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById(UX_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = UX_STYLE_ID;
  style.textContent = getCSS();
  document.head.appendChild(style);
}

function findInjectTarget() {
  const userBtn = document.querySelector('[data-testid="user-menu-button"]');
  if (userBtn) {
    return userBtn.closest('nav') || userBtn.closest('[class*="sidebar"]') || userBtn.closest('[class*="Sidebar"]') || userBtn.closest('[class*="side"]') || userBtn.closest('div');
  }
  const strategies = [
    () => document.querySelector('nav[class*="sidebar"]'),
    () => document.querySelector('aside'),
    () => document.querySelector('[class*="Sidebar"]'),
    () => document.querySelector('[class*="sidebar"]'),
  ];
  for (const fn of strategies) {
    try { const el = fn(); if (el) return el; } catch (_) {}
  }
  return null;
}

function findUserProfileEl(sidebar) {
  const strategies = [
    () => sidebar.querySelector('[data-testid="user-menu-button"]'),
    () => sidebar.querySelector('[class*="UserMenu"]'),
    () => sidebar.querySelector('[class*="user-menu"]'),
    () => sidebar.querySelector('[class*="profile"]'),
  ];
  for (const fn of strategies) {
    try {
      const el = fn();
      if (el && el !== document.getElementById(UX_ID)) {
        let ancestor = el;
        while (ancestor && ancestor.parentElement !== sidebar) {
          ancestor = ancestor.parentElement;
        }
        if (ancestor) return ancestor;
      }
    } catch (_) {}
  }
  const children = [...sidebar.children];
  return children[children.length - 1] || null;
}

async function openDebugViewer() {
  const url = browser.runtime.getURL("debug-viewer.html");
  window.open(url, "usagex-debug-viewer", "width=800,height=600,menubar=no,toolbar=no");
}

async function injectSidebar() {
  if (isInjecting) return;
  if (document.getElementById(UX_ID)) { sidebarInjected = true; return; }
  const sidebar = findInjectTarget();
  if (!sidebar) return;
  const userProfile = findUserProfileEl(sidebar);
  if (!userProfile) return;
  isInjecting = true;
  try {
    injectStyles();
    const root = document.createElement('div');
    root.id = UX_ID;
    root.classList.add('font-sans');
    root.innerHTML = getSidebarHTML();

    // Add the pulse dot, tooltip target, remaining estimate, and shortcut note without rebuilding the template.
    const sessionPctEl = root.querySelector('#ux-session-pct');
    if (sessionPctEl && !root.querySelector('#ux-rate-dot')) {
      const pctWrap = document.createElement('span');
      pctWrap.className = 'ux-pct-wrap';
      sessionPctEl.parentElement.replaceChild(pctWrap, sessionPctEl);
      pctWrap.appendChild(sessionPctEl);

      const dotEl = document.createElement('span');
      dotEl.id = 'ux-rate-dot';
      dotEl.className = 'ux-rate-dot ux-rate-gray';
      dotEl.setAttribute('data-tooltip', 'Usage rate: Calculating...');
      pctWrap.appendChild(dotEl);
    }

    const sessionTrack = root.querySelector('#ux-bar-session')?.parentElement;
    if (sessionTrack) {
      sessionTrack.id = 'ux-session-track';
      sessionTrack.classList.add('ux-track-session');
    }

    const weeklyTrack = root.querySelector('#ux-bar-weekly')?.parentElement;
    if (weeklyTrack) {
      weeklyTrack.id = 'ux-weekly-track';
      weeklyTrack.classList.add('ux-track-weekly');
    }

    const sessionTimeEl = root.querySelector('#ux-session-time');
    if (sessionTimeEl && !root.querySelector('#ux-session-remaining')) {
      const remainingEl = document.createElement('div');
      remainingEl.id = 'ux-session-remaining';
      remainingEl.className = 'ux-meta';
      remainingEl.style.display = 'none';
      sessionTimeEl.insertAdjacentElement('afterend', remainingEl);
    }

    const advancedBtn = root.querySelector('#ux-advanced-btn');
    if (advancedBtn && !root.querySelector('.ux-shortcut-note')) {
      const shortcutNote = document.createElement('div');
      shortcutNote.className = 'ux-shortcut-note';
      shortcutNote.textContent = 'Alt+U to toggle panel';
      advancedBtn.insertAdjacentElement('beforebegin', shortcutNote);
    }

    // Apply saved mode classes before insertion
    const settingsRes = await browser.storage.local.get('settings');
    const s = settingsRes.settings || defaultSettings();
    if (s.minimized) {
      root.classList.add('ux-minimized');
    }
    if (s.floating) {
      root.classList.add('ux-floating');
      const fx = s.float_x != null ? s.float_x : window.innerWidth - 240;
      const fy = s.float_y != null ? s.float_y : window.innerHeight - 200;
      root.style.left = fx + 'px';
      root.style.top  = fy + 'px';
      document.body.appendChild(root);
    } else {
      if (s.sidebar_side === 'right') root.classList.add('ux-side-right');
      sidebar.insertBefore(root, userProfile);
    }
    sidebarInjected = true;
    setupSidebarResizeObserver(root);
    bindEvents();
    prevSessionPct = null;
    prevWeeklyPct = null;
    await updateUI();
    debugLog('injected', { sidebar: sidebar.tagName, floating: s.floating });
  } finally {
    isInjecting = false;
  }
}

// ─── UI Update ─────────────────────────────────────────────────────────────────

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function getThresholdColor(pct) {
  if (pct == null) return 'var(--ux-accent)';
  if (pct > 80) return 'var(--ux-red)';
  if (pct > 50) return 'var(--ux-yellow)';
  return 'var(--ux-green-bright)';
}

// Keep percentage and token calculations centralized so the UI stays in sync.
function formatPctValue(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return '-';
  const rounded = Math.round(Number(pct) * 10) / 10;
  return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded);
}

function getSessionTokensUsed(sessionPct) {
  const pct = clamp(Number(sessionPct) || 0, 0, 100);
  return Math.round((pct / 100) * SESSION_TOKEN_LIMIT);
}

function formatTokenCount(value) {
  return new Intl.NumberFormat('en-IN').format(Math.max(0, Math.round(value || 0)));
}

function getSessionTooltipText(sessionPct) {
  if (sessionPct == null) return '';
  const usedTokens = getSessionTokensUsed(sessionPct);
  return `${formatTokenCount(usedTokens)} / ${formatTokenCount(SESSION_TOKEN_LIMIT)} tokens (${formatPctValue(sessionPct)}%)`;
}

function getWeeklyTooltipText(weeklyPct) {
  if (weeklyPct == null) return '';
  const pct = clamp(Number(weeklyPct) || 0, 0, 100);
  const usedTokens = Math.round((pct / 100) * WEEKLY_TOKEN_LIMIT);
  return `${formatTokenCount(usedTokens)} / ${formatTokenCount(WEEKLY_TOKEN_LIMIT)} tokens (${formatPctValue(weeklyPct)}%)`;
}

// Estimate remaining messages from msg_sent debug logs in the active 5-hour session window.
function estimateMessagesRemaining(sessionPct, sessionResetAt, debugLogs) {
  if (sessionPct == null || Number(sessionPct) <= 0 || !sessionResetAt) return null;

  const resetAtMs = new Date(sessionResetAt).getTime();
  if (!Number.isFinite(resetAtMs)) return null;

  const now = Date.now();
  const sessionStartMs = resetAtMs - SESSION_WINDOW_MS;
  if (now <= sessionStartMs) return null;

  const sessionLogs = (debugLogs || []).filter((log) => {
    return log?.event === 'msg_sent' &&
      typeof log?.timestamp === 'number' &&
      log.timestamp >= sessionStartMs &&
      log.timestamp <= now;
  });

  if (sessionLogs.length === 0) return null;

  const totalTokens = sessionLogs.reduce((sum, log) => {
    const inputTokens = Number(log?.data?.inputTokens) || 0;
    const thinkTokens = Number(log?.data?.thinkTokens) || 0;
    return sum + inputTokens + thinkTokens;
  }, 0);

  if (totalTokens <= 0) return null;

  const avgTokensPerMessage = totalTokens / sessionLogs.length;
  if (!Number.isFinite(avgTokensPerMessage) || avgTokensPerMessage <= 0) return null;

  const remainingTokens = Math.max(0, SESSION_TOKEN_LIMIT - getSessionTokensUsed(sessionPct));
  return Math.max(0, Math.floor(remainingTokens / avgTokensPerMessage));
}

// Calculate usage rate = session% / hours elapsed in 5h window.
// Mirrors SuperClaude's logic: ideal pace is ~20%/h (100% over 5h).
// ≥30%/h → extreme (purple ↑↑), >21%/h → up (red ↑),
// 19–21%/h → neutral (gray =), <19%/h → down (green ↓)
function calcUsageRateState(sessionPct, sessionResetsAt) {
  if (sessionPct == null || !sessionResetsAt) return 'gray';
  const pct = Number(sessionPct);
  if (!Number.isFinite(pct)) return 'gray';

  const SESSION_HOURS = 5;
  const resetMs = new Date(sessionResetsAt).getTime();
  if (!Number.isFinite(resetMs)) return 'gray';

  const msRemaining = resetMs - Date.now();
  if (msRemaining <= 0) return 'gray';

  const hoursElapsed = SESSION_HOURS - msRemaining / 3600000;
  // Not enough time elapsed for a meaningful rate
  if (hoursElapsed <= 0) return pct > 0 ? 'extreme' : 'gray';

  const ratePerHour = pct / hoursElapsed;

  if (ratePerHour >= 30) return 'extreme';
  if (ratePerHour > 21)  return 'up';
  if (ratePerHour >= 19) return 'neutral';
  return 'down';
}

async function updateUsageRate(sessionPct, sessionResetsAt) {
  if (sessionPct == null || Number.isNaN(Number(sessionPct))) return;
  try {
    usageRateState = calcUsageRateState(sessionPct, sessionResetsAt);
    await browser.storage.local.set({ usagex_usage_rate_state: usageRateState });
  } catch (_) {
    usageRateState = 'gray';
  }
}

// Keep shortcut and header collapse behavior identical.
async function setPanelCollapsed(collapsed, options = {}) {
  const root = document.getElementById(UX_ID);
  if (!root) return;

  const { persist = true, resetViews = true } = options;
  root.classList.toggle('ux-minimized', collapsed);

  if (resetViews && collapsed) {
    root.classList.remove('ux-settings-open');
    root.classList.remove('ux-advanced-open');
  }

  if (persist) {
    await saveSettings({ minimized: collapsed });
  }
}

async function togglePanelCollapsed(options = {}) {
  const root = document.getElementById(UX_ID);
  if (!root) return;
  const nextCollapsed = !root.classList.contains('ux-minimized');
  await setPanelCollapsed(nextCollapsed, options);
}

function setupKeyboardShortcut() {
  if (keyboardShortcutHandler) {
    document.removeEventListener('keydown', keyboardShortcutHandler, true);
  }

  keyboardShortcutHandler = (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if ((event.key || '').toLowerCase() !== 'u') return;
    event.preventDefault();

    const root = document.getElementById(UX_ID);
    if (!root) {
      injectSidebar().catch(() => {});
      return;
    }

    togglePanelCollapsed().catch(() => {});
  };

  document.addEventListener('keydown', keyboardShortcutHandler, true);
}

async function updateUI() {
  const root = document.getElementById(UX_ID);
  if (!root) return;

  const { today, settings, usage_limits } = await loadToday();
  const tz = settings.timezone === 'auto' ? getTimezoneName() : settings.timezone;

  // Usage % from API or DOM
  const sessionPct = usage_limits?.session_pct;
  const weeklyPct = usage_limits?.weekly_pct;

  // Recalculate rate live (so it refreshes on every UI poll, not just on fetch)
  usageRateState = calcUsageRateState(sessionPct, usage_limits?.session_resets_at);

  setEl('#ux-session-pct', sessionPct != null ? `${formatPctValue(sessionPct)}%` : '—');
  setEl('#ux-weekly-pct', weeklyPct != null ? `${formatPctValue(weeklyPct)}%` : '—');

  // Progress bars
  const animateSession = sessionPct != null && (prevSessionPct === null || Math.abs(sessionPct - prevSessionPct) > 5);
  const animateWeekly = weeklyPct != null && (prevWeeklyPct === null || Math.abs(weeklyPct - prevWeeklyPct) > 5);

  if (sessionPct != null) prevSessionPct = sessionPct;
  if (weeklyPct != null) prevWeeklyPct = weeklyPct;

  setWidth('#ux-bar-session', clamp(sessionPct ?? 0, 0, 100), animateSession);
  setWidth('#ux-bar-weekly', clamp(weeklyPct ?? 0, 0, 100), animateWeekly);

  const sessionBar = root.querySelector('#ux-bar-session');
  if (sessionBar) sessionBar.style.background = getThresholdColor(sessionPct);

  const weeklyBar = root.querySelector('#ux-bar-weekly');
  if (weeklyBar) weeklyBar.style.background = getThresholdColor(weeklyPct);

  const sessionPctEl = root.querySelector('#ux-session-pct');
  if (sessionPctEl) sessionPctEl.style.color = getThresholdColor(sessionPct);

  const weeklyPctEl = root.querySelector('#ux-weekly-pct');
  if (weeklyPctEl) weeklyPctEl.style.color = getThresholdColor(weeklyPct);

  const rateDotEl = root.querySelector('#ux-rate-dot');
  if (rateDotEl) {
    const rateConfig = {
      extreme: { label: 'Overuse (≥30%/h) — burning fast!', cls: 'ux-rate-extreme' },
      up:      { label: 'Above normal (>21%/h)',             cls: 'ux-rate-up'      },
      neutral: { label: 'On track (~20%/h)',                 cls: 'ux-rate-neutral' },
      down:    { label: 'Below normal (<19%/h) — good!',    cls: 'ux-rate-down'   },
      gray:    { label: 'Usage rate: Calculating...',        cls: 'ux-rate-gray'   },
    };
    const cfg = rateConfig[usageRateState] || rateConfig.gray;
    rateDotEl.className = 'ux-rate-dot ' + cfg.cls;
    rateDotEl.textContent = '';
    
    let tooltipText = cfg.label;
    if (sessionPct != null && Number(sessionPct) >= 100) {
      tooltipText = 'Usage limit fully reached';
    }
    rateDotEl.setAttribute('data-tooltip', tooltipText);
  }

  const sessionTrack = root.querySelector('#ux-session-track');
  if (sessionTrack) {
    const tooltipText = getSessionTooltipText(sessionPct);
    if (tooltipText && Number(sessionPct) > 0) {
      sessionTrack.setAttribute('data-tooltip', tooltipText);
    } else {
      sessionTrack.removeAttribute('data-tooltip');
    }
  }

  const weeklyTrack = root.querySelector('#ux-weekly-track');
  if (weeklyTrack) {
    const weeklyTooltipText = getWeeklyTooltipText(weeklyPct);
    if (weeklyTooltipText && Number(weeklyPct) > 0) {
      weeklyTrack.setAttribute('data-tooltip', weeklyTooltipText);
    } else {
      weeklyTrack.removeAttribute('data-tooltip');
    }
  }

  // Minimized badge
  const minimizedBadge = root.querySelector('#ux-minimized-badge');
  if (minimizedBadge) {
    const maxPct = (sessionPct != null && weeklyPct != null)
      ? Math.max(sessionPct, weeklyPct)
      : (sessionPct ?? weeklyPct);

    if (maxPct != null) {
      minimizedBadge.textContent = `${maxPct}%`;
      minimizedBadge.style.display = '';

      let titleStr = '';
      if (sessionPct != null) titleStr += `Session: ${sessionPct}%`;
      if (weeklyPct != null) {
        if (titleStr) titleStr += ' | ';
        titleStr += `Weekly: ${weeklyPct}%`;
      }
      minimizedBadge.dataset.tooltip = titleStr;

      if (maxPct >= 80) {
        minimizedBadge.style.background = 'rgba(192, 57, 43, 0.15)';
        minimizedBadge.style.color = '#ff8888';
        minimizedBadge.style.border = '1px solid rgba(192, 57, 43, 0.3)';
      } else if (maxPct >= 50) {
        minimizedBadge.style.background = 'rgba(217, 154, 38, 0.15)';
        minimizedBadge.style.color = '#ffcc66';
        minimizedBadge.style.border = '1px solid rgba(217, 154, 38, 0.3)';
      } else {
        minimizedBadge.style.background = 'rgba(78, 155, 106, 0.15)';
        minimizedBadge.style.color = '#88dfa8';
        minimizedBadge.style.border = '1px solid rgba(78, 155, 106, 0.3)';
      }
    } else {
      minimizedBadge.style.display = 'none';
    }
  }

  // Reset times
  if (usage_limits?.session_resets_at) {
    const sessionTimeStr = formatResetTimeDisplay(new Date(usage_limits.session_resets_at).getTime(), tz);
    const sessionTimeEl = root.querySelector('#ux-session-time');
    if (sessionTimeEl) {
      const [sessionRemaining, sessionReset] = sessionTimeStr.split(' · ');
      sessionTimeEl.innerHTML = sessionReset
        ? `<span class="ux-time-remaining">${sessionRemaining}</span> <span class="ux-time-reset">· ${sessionReset}</span>`
        : `<span class="ux-time-remaining">${sessionTimeStr}</span>`;
    }
  } else {
    setEl('#ux-session-time', '');
  }
  if (usage_limits?.weekly_resets_at) {
    const weeklyTimeStr = formatWeeklyResetDisplay(new Date(usage_limits.weekly_resets_at).getTime(), tz);
    const weeklyTimeEl = root.querySelector('#ux-weekly-time');
    if (weeklyTimeEl) {
      const [weeklyRemaining, weeklyReset] = weeklyTimeStr.split(' · ');
      weeklyTimeEl.innerHTML = weeklyReset
        ? `<span class="ux-time-remaining">${weeklyRemaining}</span> <span class="ux-time-reset">· ${weeklyReset}</span>`
        : `<span class="ux-time-remaining">${weeklyTimeStr}</span>`;
    }
  } else {
    setEl('#ux-weekly-time', '');
  }

  // Debug count
  const dbgRes = await browser.storage.local.get('debug_logs');
  const debugLogs = dbgRes.debug_logs || [];
  const dbgCount = debugLogs.length;
  setEl('#ux-debug-count', `${dbgCount} logs`);

  const sessionRemainingEstimate = estimateMessagesRemaining(sessionPct, usage_limits?.session_resets_at, debugLogs);
  const sessionRemainingEl = root.querySelector('#ux-session-remaining');
  if (sessionRemainingEl) {
    sessionRemainingEl.textContent = sessionRemainingEstimate != null ? `~${sessionRemainingEstimate} messages remaining` : '';
    sessionRemainingEl.style.display = sessionRemainingEstimate != null ? 'block' : 'none';
  }

  // Settings panel state
  const dbgToggle  = root.querySelector('#ux-setting-debug');
  const sideSelect = root.querySelector('#ux-setting-side');
  const tzSelect   = root.querySelector('#ux-setting-timezone');
  const floatToggle = root.querySelector('#ux-setting-float');
  if (dbgToggle)   dbgToggle.checked   = settings.debug_logging !== false;
  if (sideSelect)  sideSelect.value    = settings.sidebar_side || 'left';
  if (tzSelect)    tzSelect.value      = settings.timezone || 'auto';
  if (floatToggle) floatToggle.checked = settings.floating === true;

  const isFloating = settings.floating === true;
  const isOpacityEnabled = settings.floating_opacity_enabled !== false;
  const opacityVal = settings.floating_opacity != null ? settings.floating_opacity : 0.85;

  const opacityRow = root.querySelector('#ux-opacity-slider-row');
  if (opacityRow) {
    opacityRow.style.display = (isFloating && isOpacityEnabled) ? 'flex' : 'none';
  }

  const opacitySlider = root.querySelector('#ux-setting-opacity-slider');
  if (opacitySlider) {
    const sliderVal = Math.round(opacityVal * 100);
    opacitySlider.value = sliderVal;
    const pct = ((sliderVal - 10) / (100 - 10)) * 100;
    opacitySlider.style.setProperty('--ux-slider-pct', `${pct}%`);
  }

  const opacityValText = root.querySelector('#ux-opacity-val');
  if (opacityValText) {
    opacityValText.textContent = `${Math.round(opacityVal * 100)}%`;
  }

  const opacityToggle = root.querySelector('#ux-setting-floating-opacity-enabled');
  if (opacityToggle) {
    opacityToggle.checked = isOpacityEnabled;
  }

  if (isFloating && isOpacityEnabled) {
    root.style.setProperty('--ux-floating-opacity', String(opacityVal));
  } else {
    root.style.setProperty('--ux-floating-opacity', '1');
  }
  updatePeakClock();
}

// ─── Peak Hours Clock ──────────────────────────────────────────────────────────

function getPeakClockIST() {
  // Returns current time as fractional hours in IST (UTC+5:30)
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istMs = utcMs + 5.5 * 3600000;
  const ist = new Date(istMs);
  return { h: ist.getHours(), m: ist.getMinutes(), dayOfWeek: ist.getDay() };
}

function updatePeakClock() {
  const root = document.getElementById(UX_ID);
  if (!root) return;

  const { h, m, dayOfWeek } = getPeakClockIST();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // Current time as fractional hours (0-24)
  const curH = h + m / 60;

  // Peak zone: 18:30 to 24:30 (= next day 0:30), grey on weekends
  const zoneColor = isWeekend ? '#555555' : 'var(--ux-red)';

  const inPeak = !isWeekend && (curH >= 18.5 || curH < 0.5);

  // Current time, formatted for display (e.g. "5:55 PM")
  const h12 = h % 12 || 12;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const timeStr = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;

  // Short status message for the always-visible line
  const statusMsg = inPeak
    ? 'Peak \u2014 limits deplete faster'
    : 'Off-peak \u2014 good time to use Claude';

  // Fuller message for the hover tooltip
  const tooltip = inPeak
    ? 'Peak hours (6:30 PM\u201312:30 AM IST) \u2014 Claude limits deplete faster'
    : isWeekend
      ? 'Weekends are off-peak \u2014 good time to use Claude'
      : 'Off-peak \u2014 good time to use Claude';

  // Peak zone split into two strip segments to handle the midnight wrap:
  // 18.5 -> 24 and 0 -> 0.5
  const zoneA = root.querySelector('#ux-peak-zone-a');
  const zoneB = root.querySelector('#ux-peak-zone-b');
  if (zoneA && zoneB) {
    zoneA.style.left = `${(18.5 / 24) * 100}%`;
    zoneA.style.width = `${((24 - 18.5) / 24) * 100}%`;
    zoneA.style.background = zoneColor;
    zoneB.style.left = '0%';
    zoneB.style.width = `${(0.5 / 24) * 100}%`;
    zoneB.style.background = zoneColor;
  }

  // Current time marker position along the 24h strip
  const nowMarker = root.querySelector('#ux-peak-now');
  if (nowMarker) nowMarker.style.left = `${(curH / 24) * 100}%`;

  // Status label
  const statusEl = root.querySelector('#ux-peak-status');
  if (statusEl) {
    statusEl.textContent = inPeak ? 'Peak' : 'Off-peak';
    statusEl.classList.remove('ux-peak-status-peak', 'ux-peak-status-off');
    statusEl.classList.add(inPeak ? 'ux-peak-status-peak' : 'ux-peak-status-off');
  }

  // Live pulsing dot in header (minimized state indicators)
  const liveDot = root.querySelector('#ux-live-dot');
  if (liveDot) {
    liveDot.classList.remove('ux-live-dot-peak', 'ux-live-dot-off');
    liveDot.classList.add(inPeak ? 'ux-live-dot-peak' : 'ux-live-dot-off');
    const wrapEl = liveDot.closest('.ux-title-icon-wrap');
    if (wrapEl) {
      wrapEl.setAttribute('data-tooltip', inPeak ? 'Peak hours (limits deplete faster)' : 'Off-peak hours (good time to use)');
    }
  }

  // WEEKEND badge + 7-day popup, shown only on Sat/Sun
  const weekendBadge = root.querySelector('#ux-weekend-badge');
  if (weekendBadge) weekendBadge.style.display = isWeekend ? 'inline-block' : 'none';

  // Mark today's column in the 7-day popup (0 = Mon ... 6 = Sun)
  const todayIdx = (dayOfWeek + 6) % 7;
  root.querySelectorAll('#ux-week-popup .ux-week-day').forEach((el) => {
    const idx = parseInt(el.getAttribute('data-day'), 10);
    el.classList.toggle('ux-week-day-today', idx === todayIdx);
  });

  // Always-visible line: current time and short status
  const timeEl = root.querySelector('#ux-peak-time');
  if (timeEl) timeEl.textContent = `${timeStr} \u00b7 ${statusMsg}`;

  // Fuller explanation on hover
  const track = root.querySelector('#ux-peak-track');
  if (track) track.setAttribute('data-tooltip', tooltip);
}

function setEl(sel, text) {
  const root = document.getElementById(UX_ID);
  if (!root) return;
  const el = root.querySelector(sel);
  if (el) el.textContent = text;
}

function setWidth(sel, pct, animate) {
  const root = document.getElementById(UX_ID);
  if (!root) return;
  const el = root.querySelector(sel);
  if (el) {
    if (animate) {
      if (el.style.width === '0%' || el.style.width === '') {
        el.style.transition = 'none';
        el.style.width = '0%';
        el.offsetWidth; // force reflow
      }
      el.style.transition = 'width 900ms cubic-bezier(0.16, 1, 0.3, 1)';
    } else {
      el.style.transition = 'none';
    }
    el.style.width = `${Math.min(100, pct)}%`;
  }
}

// ─── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  const root = document.getElementById(UX_ID);
  if (!root) return;

  root.querySelector('#ux-btn-minimize')?.addEventListener('click', async () => {
    await togglePanelCollapsed();
  });

  root.querySelector('#ux-btn-settings')?.addEventListener('click', () => {
    root.classList.remove('ux-advanced-open');
    root.classList.toggle('ux-settings-open');
    updateUI().catch(() => {});
  });

  // Settings back → main view
  root.querySelector('#ux-settings-back-btn')?.addEventListener('click', () => {
    root.classList.remove('ux-settings-open');
    root.classList.remove('ux-advanced-open');
  });

  // Advanced back → settings
  root.querySelector('#ux-advanced-back-btn')?.addEventListener('click', () => {
    root.classList.remove('ux-advanced-open');
  });

  root.querySelector('#ux-advanced-btn')?.addEventListener('click', () => {
    root.classList.add('ux-advanced-open');
  });

  root.querySelector('#ux-btn-export')?.addEventListener('click', async () => {
    await exportData();
    const chip = root.querySelector('#ux-export-chip');
    const label = root.querySelector('#ux-export-label');
    if (chip && label) {
      chip.textContent = '✓ Saved';
      label.style.display = 'none';
      chip.classList.add('ux-chip-visible');
      setTimeout(() => {
        chip.classList.remove('ux-chip-visible');
        chip.textContent = '';
        label.style.display = '';
      }, 2000);
    }
  });
  root.querySelector('#ux-btn-debug')?.addEventListener('click', () => openDebugViewer());

  root.querySelector('#ux-setting-debug')?.addEventListener('change', async (e) => {
    await saveSettings({ debug_logging: e.target.checked });
  });

  root.querySelector('#ux-setting-floating-opacity-enabled')?.addEventListener('change', async (e) => {
    await saveSettings({ floating_opacity_enabled: e.target.checked });
    updateUI().catch(() => {});
  });

  root.querySelector('#ux-setting-opacity-slider')?.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value) / 100;
    root.style.setProperty('--ux-floating-opacity', String(val));
    const pct = ((parseFloat(e.target.value) - 10) / (100 - 10)) * 100;
    e.target.style.setProperty('--ux-slider-pct', `${pct}%`);
    const opacityValText = root.querySelector('#ux-opacity-val');
    if (opacityValText) {
      opacityValText.textContent = `${e.target.value}%`;
    }
  });

  root.querySelector('#ux-setting-opacity-slider')?.addEventListener('change', async (e) => {
    const val = parseFloat(e.target.value) / 100;
    await saveSettings({ floating_opacity: val });
  });

  root.querySelector('#ux-setting-side')?.addEventListener('change', async (e) => {
    const side = e.target.value;
    await saveSettings({ sidebar_side: side });
    const s = await getSettings();
    if (!s.floating) {
      if (side === 'right') {
        root.classList.add('ux-side-right');
      } else {
        root.classList.remove('ux-side-right');
      }
    }
  });

  root.querySelector('#ux-setting-timezone')?.addEventListener('change', async (e) => {
    await saveSettings({ timezone: e.target.value });
    updateUI().catch(() => {});
  });

  // Float toggle — move DOM node, never destroy+recreate
  root.querySelector('#ux-setting-float')?.addEventListener('change', async (e) => {
    const enable = e.target.checked;
    await saveSettings({ floating: enable });
    if (enable) {
      // Move from sidebar into body as floating panel
      const s = await getSettings();
      const fx = s.float_x != null ? s.float_x : window.innerWidth - 240;
      const fy = s.float_y != null ? s.float_y : window.innerHeight - 200;
      root.style.left = fx + 'px';
      root.style.top  = fy + 'px';
      root.classList.add('ux-floating');
      root.classList.remove('ux-side-right'); // Clean up sidebar side classes when entering float mode
      document.body.appendChild(root); // moves node — no clone
    } else {
      // Move back into sidebar
      root.classList.remove('ux-floating');
      root.style.left = '';
      root.style.top  = '';
      const s = await getSettings();
      if (s.sidebar_side === 'right') {
        root.classList.add('ux-side-right');
      } else {
        root.classList.remove('ux-side-right');
      }
      const sidebar = findInjectTarget();
      const userProfile = sidebar ? findUserProfileEl(sidebar) : null;
      if (sidebar && userProfile) {
        sidebar.insertBefore(root, userProfile);
      } else if (sidebar) {
        sidebar.appendChild(root);
      }
    }
    setupSidebarResizeObserver(root);
    updateUI().catch(() => {});
  });

  root.querySelector('#ux-btn-reset')?.addEventListener('click', async () => {
    await browser.storage.local.set({ today: freshToday(), history: [] });
    await updateUI();
  });

  root.querySelector('#ux-btn-clear-debug')?.addEventListener('click', async () => {
    await browser.storage.local.set({ debug_logs: [] });
    await updateUI();
  });

  // Draggable headers (active on home screen, settings screen, or advanced screen when floating)
  const handles = root.querySelectorAll('#ux-drag-handle, .ux-settings-header');
  if (handles.length > 0) {
    let dragging = false, ox = 0, oy = 0;
    handles.forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        if (!root.classList.contains('ux-floating')) return;
        // Avoid dragging when clicking buttons, selects, inputs, or links within the header
        if (e.target.closest('button, select, input, a')) return;
        dragging = true;
        ox = e.clientX - root.getBoundingClientRect().left;
        oy = e.clientY - root.getBoundingClientRect().top;
        root.style.transition = 'none';
        e.preventDefault();
      });
    });

    if (dragMoveHandler) document.removeEventListener('mousemove', dragMoveHandler);
    if (dragUpHandler) document.removeEventListener('mouseup', dragUpHandler);

    dragMoveHandler = (e) => {
      if (!dragging) return;
      const nx = Math.max(0, Math.min(window.innerWidth  - root.offsetWidth,  e.clientX - ox));
      const ny = Math.max(0, Math.min(window.innerHeight - root.offsetHeight, e.clientY - oy));
      root.style.left = nx + 'px';
      root.style.top  = ny + 'px';
    };

    dragUpHandler = async () => {
      if (!dragging) return;
      dragging = false;
      root.style.transition = '';
      const nx = parseFloat(root.style.left);
      const ny = parseFloat(root.style.top);
      await saveSettings({ float_x: nx, float_y: ny });
    };

    document.addEventListener('mousemove', dragMoveHandler);
    document.addEventListener('mouseup', dragUpHandler);
  }
}

// ─── Export helpers ────────────────────────────────────────────────────────────

async function exportData() {
  const res = await browser.storage.local.get(['today', 'history', 'settings', 'usage_limits', 'debug_logs']);
  download('usagex-export.json', JSON.stringify(res, null, 2));
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = 'data:application/json,' + encodeURIComponent(text);
  a.download = filename;
  a.click();
}

// ─── Debug logging ─────────────────────────────────────────────────────────────

async function debugLog(event, data) {
  const settings = await getSettings();
  if (!settings.debug_logging) return;
  const res = await browser.storage.local.get('debug_logs');
  const logs = res.debug_logs || [];
  const message = typeof data === 'object' ? JSON.stringify(data) : String(data);
  logs.push({
    timestamp: Date.now(),
    ts: new Date().toISOString(),
    event: event,
    scope: event,
    data: data,
    message: `${event}: ${message}`
  });
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await browser.storage.local.set({ debug_logs: logs });
}

// ─── HTML template ─────────────────────────────────────────────────────────────

function getSidebarHTML() {
  return `
<div id="ux-inner">
  <div id="ux-main-view">

    <div class="ux-header" id="ux-drag-handle">
      <div class="ux-title">
        <div class="ux-title-icon-wrap">
          <svg class="ux-title-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="m12 14 4-4"/>
            <path d="M3.34 19a10 10 0 1 1 17.32 0"/>
          </svg>
          <div class="ux-dot" id="ux-live-dot"></div>
        </div>
        <span class="ux-name">Usage</span>
        <span class="ux-minimized-badge" id="ux-minimized-badge" style="display: none;"></span>
      </div>
      <div class="ux-icon-row">
        <button class="ux-icn" id="ux-btn-settings" aria-label="Settings" data-tooltip="Settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button class="ux-icn" id="ux-btn-minimize" aria-label="Minimize" data-tooltip="Minimize">
          <svg class="ux-icon-minimize" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          <svg class="ux-icon-expand" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>
    </div>

    <div id="ux-bars-section">
      <div class="ux-bar-item">
        <div class="ux-bar-top">
          <span class="ux-bar-label">Session (5h)</span>
          <span class="ux-pct" id="ux-session-pct">—</span>
        </div>
        <div class="ux-track"><div class="ux-fill ux-fill-session" id="ux-bar-session" style="width:0%"></div></div>
        <div class="ux-time" id="ux-session-time"></div>
      </div>

      <div class="ux-bar-item">
        <div class="ux-bar-top">
          <span class="ux-bar-label">Weekly</span>
          <span class="ux-pct" id="ux-weekly-pct">—</span>
        </div>
        <div class="ux-track"><div class="ux-fill ux-fill-weekly" id="ux-bar-weekly" style="width:0%"></div></div>
        <div class="ux-time" id="ux-weekly-time"></div>
      </div>
    </div>

    <div id="ux-peak-strip-wrap">
      <div class="ux-bar-top">
        <span class="ux-bar-label">Peak hours</span>
        <span class="ux-peak-status-group">
          <span class="ux-weekend-badge" id="ux-weekend-badge">
            WEEKEND
            <div class="ux-week-popup" id="ux-week-popup">
              <div class="ux-week-popup-row">
                <span class="ux-week-day ux-week-day-peak" data-day="0"></span>
                <span class="ux-week-day ux-week-day-peak" data-day="1"></span>
                <span class="ux-week-day ux-week-day-peak" data-day="2"></span>
                <span class="ux-week-day ux-week-day-peak" data-day="3"></span>
                <span class="ux-week-day ux-week-day-peak" data-day="4"></span>
                <span class="ux-week-day" data-day="5"></span>
                <span class="ux-week-day" data-day="6"></span>
              </div>
              <div class="ux-week-popup-labels"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
              <div class="ux-week-popup-caption">Peak hours apply Mon\u2013Fri only</div>
            </div>
          </span>
          <span class="ux-peak-status" id="ux-peak-status">—</span>
        </span>
      </div>
      <div class="ux-peak-track" id="ux-peak-track" data-tooltip="">
        <div class="ux-peak-zone" id="ux-peak-zone-a"></div>
        <div class="ux-peak-zone" id="ux-peak-zone-b"></div>
        <div class="ux-peak-now" id="ux-peak-now"></div>
      </div>
      <div class="ux-time" id="ux-peak-time"></div>
    </div>

    <div class="ux-action-row">
      <button class="ux-act-btn" id="ux-btn-export">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span id="ux-export-label">Export JSON</span>
        <span id="ux-export-chip" class="ux-export-chip" aria-live="polite"></span>
      </button>
      <button class="ux-act-btn" id="ux-btn-debug">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span id="ux-debug-count">0 logs</span>
      </button>
    </div>
  </div>

  <div id="ux-settings-panel">
    <div class="ux-settings-header">
      <button class="ux-header-back-btn" id="ux-settings-back-btn" aria-label="Back" data-tooltip="Back">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
      </button>
      <span class="ux-settings-title">Settings</span>
    </div>
    <div class="ux-setting-row">
      <span class="ux-setting-label">Float panel</span>
      <label class="ux-toggle">
        <input type="checkbox" id="ux-setting-float">
        <span class="ux-toggle-track"></span>
      </label>
    </div>
    <div class="ux-setting-row" id="ux-opacity-slider-row" style="display: none;">
      <span class="ux-setting-label">Panel opacity</span>
      <div style="display: flex; align-items: center; gap: 8px;">
        <input type="range" id="ux-setting-opacity-slider" min="10" max="100" step="5" class="ux-range-slider" style="width: 80px;">
        <span id="ux-opacity-val" style="font-size: 11.5px; color: var(--ux-text-2); min-width: 28px; text-align: right;">85%</span>
      </div>
    </div>
    <div class="ux-setting-row">
      <span class="ux-setting-label">Sidebar side</span>
      <select id="ux-setting-side" class="ux-select">
        <option value="left">Left</option>
        <option value="right">Right</option>
      </select>
    </div>
    <div class="ux-setting-row">
      <span class="ux-setting-label">Debug logging</span>
      <label class="ux-toggle">
        <input type="checkbox" id="ux-setting-debug">
        <span class="ux-toggle-track"></span>
      </label>
    </div>
    <button class="ux-advanced-btn" id="ux-advanced-btn">Advanced</button>
    <div class="ux-settings-btns">
      <button class="ux-settings-btn ux-btn-destructive" id="ux-btn-reset">Reset local stats</button>
      <button class="ux-settings-btn ux-btn-destructive" id="ux-btn-clear-debug">Clear debug logs</button>
    </div>
  </div>

  <div id="ux-advanced-panel">
    <div class="ux-settings-header">
      <button class="ux-header-back-btn" id="ux-advanced-back-btn" aria-label="Back" data-tooltip="Back">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
      </button>
      <span class="ux-settings-title">Advanced</span>
    </div>
    <div class="ux-setting-row">
      <span class="ux-setting-label">Timezone</span>
      <select id="ux-setting-timezone" class="ux-select">
        <option value="auto">Auto-detect</option>
        <option value="IST">IST (UTC+5:30)</option>
        <option value="EST">EST (UTC-5)</option>
        <option value="CST">CST (UTC-6)</option>
        <option value="MST">MST (UTC-7)</option>
        <option value="PST">PST (UTC-8)</option>
        <option value="GMT">GMT (UTC+0)</option>
        <option value="CET">CET (UTC+1)</option>
        <option value="EET">EET (UTC+2)</option>
        <option value="MSK">MSK (UTC+3)</option>
        <option value="GST">GST (UTC+4)</option>
        <option value="PKT">PKT (UTC+5)</option>
        <option value="BST">BST (UTC+6)</option>
        <option value="WIB">WIB (UTC+7)</option>
        <option value="CST-Asia">CST (UTC+8)</option>
        <option value="JST">JST (UTC+9)</option>
        <option value="AEST">AEST (UTC+10)</option>
        <option value="NZST">NZST (UTC+12)</option>
      </select>
    </div>
    <div class="ux-setting-row">
      <span class="ux-setting-label">Floating opacity</span>
      <label class="ux-toggle">
        <input type="checkbox" id="ux-setting-floating-opacity-enabled">
        <span class="ux-toggle-track"></span>
      </label>
    </div>
  </div>

</div>`;
}

// ─── CSS ──────────────────────────────────────────────────

function getCSS() {
  return `
#usagex-v2-root {
  --ux-border: #2a2a2a;
  --ux-border-subtle: #232323;
  --ux-surface: #1c1c1c;
  --ux-surface-2: #222222;
  --ux-hover: #2c2c2c;
  --ux-accent: #cc9966;
  --ux-accent-dim: #b8895a;
  --ux-green-bright: #4ade80;
  --ux-yellow: #f59e0b;
  --ux-red: #ef4444;
  --ux-text-1: #d4cdc5;
  --ux-text-2: #a09890;
  --ux-text-3: #706860;
  --ux-text-4: #4a4540;
  --ux-font: inherit;
  --ux-radius: 6px;
  font-family: var(--ux-font);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ux-text-1);
  border-top: 1px solid var(--ux-border);
  box-sizing: border-box;
}
#usagex-v2-root.ux-parent-collapsed {
  display: none !important;
}
#usagex-v2-root *, #usagex-v2-root *::before, #usagex-v2-root *::after {
  box-sizing: inherit;
}
#usagex-v2-root.ux-floating {
  position: fixed;
  z-index: 2147483647;
  width: 224px;
  border-top: none;
  border-radius: 12px;
  background: #222222;
  box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5),
              0 8px 10px -6px rgba(0,0,0,0.5),
              inset 0 1px 1px 0 rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.08);
  bottom: auto !important;
  right: auto !important;
  opacity: var(--ux-floating-opacity, 0.85);
  transition: opacity 0.2s ease-in-out;
}
#usagex-v2-root.ux-floating:hover {
  opacity: 1;
}
.ux-range-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 80px;
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(to right, var(--ux-accent) 0%, var(--ux-accent) var(--ux-slider-pct, 50%), #333 var(--ux-slider-pct, 50%), #333 100%);
  outline: none;
  cursor: pointer;
  transition: background 0.15s;
}
.ux-range-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--ux-text-1);
  border: 2px solid var(--ux-accent);
  box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  cursor: grab;
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.15s;
}
.ux-range-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
  box-shadow: 0 0 0 3px rgba(204,153,102,0.2), 0 1px 4px rgba(0,0,0,0.4);
}
.ux-range-slider::-webkit-slider-thumb:active {
  cursor: grabbing;
  transform: scale(1.1);
}
.ux-range-slider::-moz-range-thumb {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--ux-text-1);
  border: 2px solid var(--ux-accent);
  box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  cursor: grab;
}
.ux-range-slider::-moz-range-track {
  height: 5px;
  border-radius: 3px;
  background: #333;
}
#usagex-v2-root.ux-floating.ux-minimized { border-radius: 10px; }
#usagex-v2-root.ux-floating #ux-drag-handle,
#usagex-v2-root.ux-floating .ux-settings-header { cursor: grab; }
#usagex-v2-root.ux-floating #ux-drag-handle:active,
#usagex-v2-root.ux-floating .ux-settings-header:active { cursor: grabbing; }
#usagex-v2-root.ux-side-right {
  position: fixed;
  bottom: 28px;
  right: 18px;
  z-index: 99999;
  width: 224px;
  border-top: none;
  border-radius: 12px;
  background: #222222;
  box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5),
              0 8px 10px -6px rgba(0,0,0,0.5),
              inset 0 1px 1px 0 rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.08);
}
#usagex-v2-root.ux-minimized #ux-bars-section,
#usagex-v2-root.ux-minimized #ux-peak-strip-wrap,
#usagex-v2-root.ux-minimized .ux-action-row { display: none; }
#usagex-v2-root.ux-minimized .ux-header { margin-bottom: 0; }
.ux-icon-expand { display: none; }
#usagex-v2-root.ux-minimized .ux-icon-minimize { display: none; }
#usagex-v2-root.ux-minimized .ux-icon-expand  { display: block; }
.ux-minimized-badge {
  display: none;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  line-height: 1.2;
  letter-spacing: 0.01em;
  margin-left: 5px;
}
#usagex-v2-root.ux-minimized .ux-minimized-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: translateY(1.5px);
}
#usagex-v2-root.ux-minimized .ux-dot::before {
  animation: none;
}
#usagex-v2-root.ux-minimized .ux-dot {
  opacity: 0.6;
}
#ux-settings-panel { display: none; }
#usagex-v2-root.ux-settings-open #ux-main-view  { display: none; }
#usagex-v2-root.ux-settings-open #ux-settings-panel { display: flex; flex-direction: column; }
#ux-advanced-panel { display: none; }
#usagex-v2-root.ux-advanced-open #ux-settings-panel { display: none; }
#usagex-v2-root.ux-advanced-open #ux-advanced-panel { display: flex; flex-direction: column; }
#ux-inner { padding: 13px 14px 12px; }
.ux-header {
  display: flex; align-items: center;
  justify-content: space-between;
  margin-bottom: 12px; user-select: none;
}
.ux-title { display: flex; align-items: center; gap: 7px; }
.ux-title-icon-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}
.ux-title-icon {
  color: var(--ux-text-3);
  display: block;
  transition: color 0.2s ease;
}
.ux-header:hover .ux-title-icon {
  color: var(--ux-text-2);
}
.ux-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 5px;
  height: 5px;
}
.ux-dot::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--ux-accent);
  box-shadow: 0 0 0 1.5px var(--ux-surface);
  animation: ux-pulse 3s ease-in-out infinite;
}
.ux-dot.ux-live-dot-peak::before {
  background: var(--ux-red);
  animation: ux-pulse-red 2s ease-in-out infinite;
}
.ux-dot.ux-live-dot-off::before {
  background: var(--ux-green-bright);
  animation: ux-pulse-green 3s ease-in-out infinite;
}
@keyframes ux-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
@keyframes ux-pulse-red {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 1.5px var(--ux-surface), 0 0 4px var(--ux-red); }
  50% { opacity: 0.4; box-shadow: 0 0 0 1.5px var(--ux-surface), 0 0 0px var(--ux-red); }
}
@keyframes ux-pulse-green {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 1.5px var(--ux-surface), 0 0 3px var(--ux-green-bright); }
  50% { opacity: 0.4; box-shadow: 0 0 0 1.5px var(--ux-surface), 0 0 0px var(--ux-green-bright); }
}
.ux-name { font-size: 13px; font-weight: 600; color: var(--ux-text-1); letter-spacing: 0.01em; }
/* ── Claude-style tooltips ── */
#usagex-v2-root [data-tooltip] {
  position: relative;
}
#usagex-v2-root [data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  top: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%) translateY(-3px);
  background: rgba(26, 26, 26, 0.85) !important;
  backdrop-filter: blur(8px) !important;
  -webkit-backdrop-filter: blur(8px) !important;
  color: #e0e0e0 !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  line-height: 16px !important;
  display: block !important;
  box-sizing: border-box !important;
  padding: 4px 8px !important;
  border-radius: 4px !important;
  white-space: nowrap !important;
  pointer-events: none !important;
  opacity: 0;
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 2147483647;
  border: 1px solid #333 !important;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important;
  font-family: var(--ux-font) !important;
  letter-spacing: 0.01em !important;
}
#usagex-v2-root [data-tooltip]:hover::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
/* Align title icon tooltip to the left so it doesn't overflow the screen edge */
#usagex-v2-root .ux-title-icon-wrap[data-tooltip]::after {
  left: 0;
  transform: translateY(-3px);
}
#usagex-v2-root .ux-title-icon-wrap[data-tooltip]:hover::after {
  transform: translateY(0);
}
/* Only show the tooltip when the panel is minimized */
#usagex-v2-root:not(.ux-minimized) .ux-title-icon-wrap[data-tooltip]::after {
  display: none !important;
}
#usagex-v2-root #ux-rate-dot[data-tooltip]::after {
  top: auto;
  bottom: calc(100% + 7px);
  transform: translateX(-50%) translateY(3px);
}
#usagex-v2-root #ux-rate-dot[data-tooltip]:hover::after {
  transform: translateX(-50%) translateY(0);
}
/* Badge tooltip appears above (it sits in the title row, not a button) */
#usagex-v2-root .ux-minimized-badge[data-tooltip]::after {
  top: auto;
  bottom: calc(100% + 7px);
  transform: translateX(-50%) translateY(3px);
}
#usagex-v2-root .ux-minimized-badge[data-tooltip]:hover::after {
  transform: translateX(-50%) translateY(0);
}
.ux-icon-row { display: flex; gap: 2px; }
.ux-icn {
  width: 26px; height: 26px; border-radius: 6px;
  border: 1px solid transparent; background: transparent;
  display: flex; align-items: center; justify-content: center;
  color: var(--ux-text-3); cursor: pointer; padding: 0;
  transition: background 0.15s, color 0.12s, border-color 0.12s;
}
.ux-icn:hover { background: var(--ux-hover); border-color: var(--ux-border); color: var(--ux-text-1); }
.ux-icn svg { display: block; transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.ux-icn:hover svg { transform: scale(1.18) rotate(-8deg); }
.ux-icn:active svg { transform: scale(0.92); transition-duration: 0.1s; }
#ux-bars-section { display: flex; flex-direction: column; gap: 12px; }
.ux-bar-item {
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.ux-bar-item:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}
.ux-bar-item:first-child {
  margin-bottom: 8px;
}
.ux-bar-top {
  display: flex; justify-content: space-between;
  align-items: baseline; margin-bottom: 6px;
}
.ux-bar-label { font-size: 14px; color: var(--ux-text-1); font-weight: 600; }
.ux-pct-wrap {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.ux-pct { font-size: 14px; font-weight: 700; color: var(--ux-accent); letter-spacing: -0.01em; }
.ux-rate-dot {
  width: 8px;
  height: 8px;
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
  position: relative;
}
.ux-rate-dot::before {
  content: "";
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
  border-radius: 50%;
}
/* Unique palette — distinct from SuperClaude's purple/red/gray/green */
.ux-rate-gray::before    { background: #3f3f46; }
.ux-rate-down::before    { background: #2dd4bf; animation: ux-dot-pulse 2.5s ease-in-out infinite; }
.ux-rate-neutral::before { background: #64748b; animation: ux-dot-pulse 3s ease-in-out infinite; }
.ux-rate-up::before      { background: #fbbf24; animation: ux-dot-pulse 1.1s ease-in-out infinite; }
.ux-rate-extreme::before {
  background: #f97316;
  animation: ux-dot-pulse 0.5s ease-in-out infinite;
  box-shadow: 0 0 5px rgba(249,115,22,0.7);
}
@keyframes ux-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.35; transform: scale(0.8); }
}
#usagex-v2-root .ux-track { height: 4px; background: #282828; border-radius: 2px; overflow: hidden; margin-bottom: 6px; }
#usagex-v2-root .ux-track[data-tooltip] { overflow: visible; cursor: help; }
#usagex-v2-root .ux-track.ux-track-session[data-tooltip]::after,
#usagex-v2-root .ux-track.ux-track-weekly[data-tooltip]::after {
  top: auto;
  bottom: calc(100% + 7px);
  transform: translateX(-50%) translateY(3px);
}
#usagex-v2-root .ux-track.ux-track-session[data-tooltip]:hover::after,
#usagex-v2-root .ux-track.ux-track-weekly[data-tooltip]:hover::after {
  transform: translateX(-50%) translateY(0);
}
.ux-fill { height: 100%; border-radius: 2px; transition: none; }
.ux-fill-session { background: var(--ux-accent); }
.ux-fill-weekly  { background: var(--ux-green-bright); }
.ux-time {
  font-size: 11px;
  color: var(--ux-text-3);
  line-height: 1.4;
  letter-spacing: 0.01em;
}
.ux-time-remaining {
  color: var(--ux-text-2);
  font-weight: 600;
  font-size: 11.5px;
}
.ux-time-reset {
  color: var(--ux-text-3);
  font-size: 10px;
  font-weight: 400;
}
.ux-meta {
  font-size: 10.5px;
  color: var(--ux-text-2);
  line-height: 1.35;
  margin-top: 3px;
}
#ux-session-remaining {
  font-size: 11px;
  color: #666;
  margin-top: 4px;
  font-style: italic;
}
.ux-action-row { display: flex; gap: 8px; margin-top: 12px; }
.ux-act-btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 5px 10px; background: #1a1a1a;
  border: 1px solid #333; border-radius: 6px;
  font-size: 11px; color: #aaa; cursor: pointer;
  font-family: var(--ux-font); font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease, border-color 0.15s ease;
  position: relative;
}
.ux-act-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--ux-text-2);
}
.ux-act-btn:active {
  background: rgba(255, 255, 255, 0.15);
  color: var(--ux-text-1);
  transform: scale(0.97);
  transition-duration: 0.08s;
}
.ux-export-chip {
  display: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--ux-green-bright);
  pointer-events: none;
}
.ux-export-chip.ux-chip-visible {
  display: inline;
}
.ux-act-btn:focus-visible {
  outline: 2px solid var(--ux-accent-dim);
  outline-offset: 2px;
}
.ux-settings-btn:focus-visible {
  outline: 2px solid var(--ux-accent-dim);
  outline-offset: 2px;
}
.ux-act-btn svg { flex-shrink: 0; transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.ux-act-btn:hover svg { transform: translateY(-1px) scale(1.12); }
.ux-act-btn:active svg { transform: scale(0.9); transition-duration: 0.1s; }
.ux-settings-header {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600; color: var(--ux-text-1);
  margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--ux-border);
  user-select: none;
}
.ux-settings-title { flex: 1; letter-spacing: 0.01em; }
.ux-header-back-btn {
  flex-shrink: 0; width: 22px; height: 22px; border-radius: 5px;
  border: 1px solid transparent; background: transparent;
  display: flex; align-items: center; justify-content: center;
  color: var(--ux-text-3); cursor: pointer; padding: 0;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.ux-header-back-btn:hover { background: var(--ux-hover); border-color: var(--ux-border); color: var(--ux-text-1); }
.ux-header-back-btn svg { transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.ux-header-back-btn:hover svg { transform: translateX(-2px) scale(1.1); }
.ux-header-back-btn:active svg { transform: translateX(-1px) scale(0.92); transition-duration: 0.1s; }
.ux-setting-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 0; border-bottom: 1px solid var(--ux-border-subtle);
}
.ux-setting-label { font-size: 13px; font-weight: 500; color: var(--ux-text-2); }
.ux-shortcut-note {
  padding: 8px 0 2px;
  font-size: 11px;
  color: var(--ux-text-3);
}
.ux-toggle { position: relative; width: 32px; height: 18px; flex-shrink: 0; }
.ux-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
.ux-toggle-track {
  position: absolute; inset: 0; background: #2a2a2a;
  border-radius: 9px; cursor: pointer; transition: background 0.2s; border: 1px solid #3a3a3a;
}
.ux-toggle-track::after {
  content: ""; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px;
  background: #606060; border-radius: 50%; transition: transform 0.2s, background 0.2s;
}
.ux-toggle input:checked + .ux-toggle-track { background: #1a3020; border-color: #2a4a30; }
.ux-toggle input:checked + .ux-toggle-track::after { transform: translateX(14px); background: var(--ux-green-bright); }
.ux-select {
  background: var(--ux-surface); border: 1px solid var(--ux-border);
  border-radius: 5px; color: var(--ux-text-1); font-size: 11.5px;
  padding: 3px 7px; font-family: var(--ux-font); cursor: pointer;
  font-weight: 500; outline: none; transition: border-color 0.12s;
}
.ux-select:focus { border-color: var(--ux-accent-dim); }
.ux-advanced-btn {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; margin: 8px 0 6px; padding: 7px 0;
  background: transparent; border: none;
  border-bottom: 1px solid var(--ux-border-subtle);
  font-size: 13px; color: var(--ux-text-2); cursor: pointer;
  font-family: var(--ux-font); font-weight: 500; text-align: left; transition: color 0.12s;
}
.ux-advanced-btn::after { content: "\\203A"; font-size: 16px; color: var(--ux-text-4); }
.ux-advanced-btn:hover { color: var(--ux-text-1); }
.ux-settings-btns { display: flex; flex-direction: column; gap: 6px; margin-top: 9px; }
.ux-settings-btn {
  width: 100%; padding: 7px 0; background: rgba(255, 255, 255, 0.05);
  border: none; border-radius: var(--ux-radius);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08), 0 1px 2px rgba(0, 0, 0, 0.15);
  font-size: 12px; color: var(--ux-text-2); cursor: pointer;
  font-family: var(--ux-font); font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;
}
.ux-settings-btn:hover { background: rgba(255, 255, 255, 0.1); color: var(--ux-text-1); }
.ux-settings-btn.ux-btn-destructive {
  background: rgba(192, 57, 43, 0.1);
  box-shadow: inset 0 0 0 1px rgba(192, 57, 43, 0.25), 0 1px 2px rgba(0,0,0,0.15);
  color: #c07070;
}
.ux-settings-btn.ux-btn-destructive:hover {
  background: rgba(192, 57, 43, 0.2);
  box-shadow: inset 0 0 0 1px rgba(192, 57, 43, 0.4), 0 1px 2px rgba(0,0,0,0.15);
  color: #e07070;
}
.ux-settings-btn.ux-btn-destructive:active {
  background: rgba(192, 57, 43, 0.28);
  color: #ff8888;
  transform: scale(0.98);
}
#ux-peak-strip-wrap {
  display: flex;
  flex-direction: column;
  margin-top: 14px;
  padding: 12px 2px 4px 2px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.ux-peak-track {
  position: relative;
  height: 6px;
  background: #282828;
  border-radius: 3px;
  margin-bottom: 5px;
  overflow: visible;
  cursor: help;
}
.ux-peak-zone {
  position: absolute;
  top: 0;
  height: 100%;
  background: var(--ux-red);
  opacity: 0.8;
  border-radius: 3px;
  pointer-events: none;
}
.ux-peak-now {
  position: absolute;
  top: -4px;
  left: 0%;
  width: 2px;
  height: 14px;
  background: var(--ux-accent);
  border-radius: 1px;
  transform: translateX(-1px);
  transition: left 1s linear;
  pointer-events: none;
}
.ux-peak-now::after {
  content: "";
  position: absolute;
  top: -3px;
  left: 50%;
  transform: translateX(-50%);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ux-accent);
  box-shadow: 0 0 0 2px var(--ux-surface);
}
.ux-peak-status {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ux-text-2);
}
#usagex-v2-root .ux-peak-track[data-tooltip]::after {
  top: auto;
  bottom: calc(100% + 7px);
  transform: translateX(-50%) translateY(3px);
  white-space: normal !important;
  max-width: 200px;
  text-align: center;
}
#usagex-v2-root .ux-peak-track[data-tooltip]:hover::after {
  transform: translateX(-50%) translateY(0);
}
.ux-peak-status-peak { color: var(--ux-red) !important; }
.ux-peak-status-off  { color: var(--ux-green-bright) !important; }
.ux-peak-status-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ux-weekend-badge {
  position: relative;
  display: none;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--ux-text-3);
  border: 1px solid var(--ux-border);
  border-radius: 4px;
  padding: 1px 5px;
  cursor: help;
}
.ux-week-popup {
  position: absolute;
  bottom: calc(100% + 7px);
  right: 0;
  width: 150px;
  background: rgba(26, 26, 26, 0.95);
  border: 1px solid #333;
  border-radius: 6px;
  padding: 8px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.15s ease;
  z-index: 20;
}
.ux-weekend-badge:hover .ux-week-popup {
  opacity: 1;
  visibility: visible;
}
.ux-week-popup-row {
  display: flex;
  gap: 3px;
  margin-bottom: 4px;
}
.ux-week-day {
  flex: 1;
  height: 14px;
  border-radius: 3px;
  background: #555555;
}
.ux-week-day-peak {
  background: var(--ux-red);
  opacity: 0.85;
}
.ux-week-day-today {
  outline: 1px solid var(--ux-accent);
  outline-offset: 1px;
}
.ux-week-popup-labels {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--ux-text-4);
  margin-bottom: 4px;
  padding: 0 1px;
}
.ux-week-popup-caption {
  font-size: 10px;
  font-weight: 400;
  letter-spacing: normal;
  color: var(--ux-text-3);
  line-height: 1.4;
  text-align: center;
}
  `;
}

// ─── Active Usage limits fetching ──────────────────────────────────────────────

async function fetchUsageLimitsActive() {
  try {
    let orgId = document.cookie.split('; ').find(row => row.startsWith('lastActiveOrg='))?.split('=')[1] || null;
    
    if (!orgId) {
      const orgsRes = await fetch('/api/organizations');
      if (!orgsRes.ok) {
        await debugLog('active_fetch_failed', { status: orgsRes.status, stage: 'organizations' });
        return;
      }
      const orgs = await orgsRes.json();
      if (!Array.isArray(orgs) || orgs.length === 0) {
        await debugLog('active_fetch_failed', { reason: 'empty_orgs', stage: 'organizations' });
        return;
      }
      orgId = orgs[0].uuid;
    }
    
    if (!orgId) {
      await debugLog('active_fetch_failed', { reason: 'no_orgId' });
      return;
    }
    
    const usageRes = await fetch(`/api/organizations/${orgId}/usage`);
    if (!usageRes.ok) {
      await debugLog('active_fetch_failed', { status: usageRes.status, stage: 'usage', orgId });
      return;
    }
    const json = await usageRes.json();
    
    if (json.five_hour || json.seven_day) {
      const data = {
        session_pct: json.five_hour ? (json.five_hour.utilization ?? null) : null,
        session_resets_at: json.five_hour ? (json.five_hour.resets_at || null) : null,
        weekly_pct: json.seven_day ? (json.seven_day.utilization ?? null) : null,
        weekly_resets_at: json.seven_day ? (json.seven_day.resets_at || null) : null,
      };
      await updateUsageRate(data.session_pct, data.session_resets_at);
      await browser.storage.local.set({ usage_limits: data });
      await updateUI();
      await debugLog('active_fetch_success', data);
    }
  } catch (err) {
    await debugLog('active_fetch_error', { message: err.message });
    console.error('[UsageX] Error active fetching usage limits:', err);
  }
}

function pollUsageLimits() {
  pollInterval = setInterval(async () => {
    await fetchUsageLimitsActive();
  }, 60000);
}

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  injectFetchHook();
  setupKeyboardShortcut();
  await fetchUsageLimitsActive().catch(() => {});

  let attempts = 0;
  tryInjectInterval = setInterval(async () => {
    attempts++;
    if (sidebarInjected || attempts > 30) { clearInterval(tryInjectInterval); return; }
    await injectSidebar();
  }, 500);

  urlCheckInterval = setInterval(checkUrlChange, 1000);
  startTimeTracking();
  pollUsageLimits();

  // Update peak clock every minute so the time dot stays accurate
  peakClockInterval = setInterval(() => {
    updatePeakClock();
  }, 60000);

  let observerTimeout = null;
  globalObserver = new MutationObserver(() => {
    if (observerTimeout) clearTimeout(observerTimeout);
    observerTimeout = setTimeout(async () => {
      const existing = document.getElementById(UX_ID);
      const settings = await getSettings().catch(() => ({}));
      if (!existing) {
        sidebarInjected = false;
        await injectSidebar();
      } else if (!settings.floating && !existing.classList.contains('ux-floating')) {
        const sidebar = findInjectTarget();
        if (sidebar && existing.parentElement !== sidebar) {
          const userProfile = findUserProfileEl(sidebar);
          if (userProfile) {
            sidebar.insertBefore(existing, userProfile);
          } else {
            sidebar.appendChild(existing);
          }
          setupSidebarResizeObserver(existing);
        }
      }
    }, 100);
  });
  globalObserver.observe(document.body, { childList: true, subtree: true });
}

init();
