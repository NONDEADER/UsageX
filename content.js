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
let alertedFlags = {
  session80: false,
  weekly80: false,
  limitReached: false,
  usageRateState: null,
  peakHoursState: null,
  peakHoursApproaching: false
};

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
let storageOnChangedHandler = null;

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
    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(ev =>
      document.removeEventListener(ev, resetIdleHandler)
    );
  }
  if (keyboardShortcutHandler) {
    document.removeEventListener('keydown', keyboardShortcutHandler, true);
  }

  if (dragMoveHandler) document.removeEventListener('mousemove', dragMoveHandler);
  if (dragUpHandler) document.removeEventListener('mouseup', dragUpHandler);
  if (windowMsgHandler) window.removeEventListener('message', windowMsgHandler);
  if (storageOnChangedHandler) browser.storage.onChanged.removeListener(storageOnChangedHandler);

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
  alertedFlags = {
    session80: false,
    weekly80: false,
    limitReached: false,
    usageRateState: null,
    peakHoursState: null,
    peakHoursApproaching: false
  };
  console.log('[UsageX] Cleaned up previous script instance.');
};

// ─── Storage ───────────────────────────────────────────────────────────────────

async function loadToday() {
  try {
    await UsageXDB.migrateFromStorage();
  } catch (err) {
    console.error('[UsageX] Migration failed:', err);
  }
  const res = await browser.storage.local.get(['today', 'history', 'settings', 'usage_limits']);
  const settings = res.settings || defaultSettings();
  const ianaTz = getIANATimezone(settings.timezone);
  const todayDate = todayStr(ianaTz);
  // If date has changed, archive yesterday into IndexedDB and reset today in storage.local
  if (!res.today || res.today.date !== todayDate) {
    if (res.today && res.today.date) {
      // Archive yesterday to IndexedDB
      try { await UsageXDB.saveDailyStats(res.today.date, res.today); } catch (_) {}
    }
    const fresh = freshToday(ianaTz);
    await browser.storage.local.set({ today: fresh });
    return { today: fresh, settings: settings, usage_limits: res.usage_limits };
  }
  return { today: res.today, settings: settings, usage_limits: res.usage_limits };
}

async function saveToday(patch) {
  const res = await browser.storage.local.get(['today', 'settings']);
  const settings = res.settings || defaultSettings();
  const ianaTz = getIANATimezone(settings.timezone);
  const today = res.today || freshToday(ianaTz);
  const updated = { ...today, ...patch, date: todayStr(ianaTz) };
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

function freshToday(ianaTz) {
  return {
    date: todayStr(ianaTz),
    msgs: 0,
    convos: 0,
    time_s: 0,
    tokens_est: 0,
    effort_breakdown: { low: 0, medium: 0, high: 0, max: 0 },
    extended_thinking: { on: 0, off: 0 },
    last_model: null,
    models_used: {},
    processed_msg_uuids: [],
    recent_sent_prompts: []
  };
}


function defaultSettings() {
  return {
    debug_logging: false,
    sidebar_side: 'left',
    timezone: 'auto',
    floating: false,
    float_x: null,
    float_y: null,
    floating_opacity_enabled: true,
    floating_opacity: 0.85,
    minimized: false,
    resizable: false,
    float_width: null,
    float_height: null,
    notifications_browser: false,
    notifications_toast: true,
    alert_limits_reset: true,
    alert_usage_threshold: true,
    alert_peak_hours: true,
    toast_position: 'bottom-right',
    alert_session_threshold: 80,
    alert_weekly_threshold: 80
  };
}
function todayStr(ianaTz) {
  try {
    const tz = ianaTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(new Date());
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

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

const TZ_MAP = {
  'HST': 'Pacific/Honolulu',
  'AKST': 'America/Anchorage',
  'PST': 'America/Los_Angeles',
  'MST': 'America/Denver',
  'CST': 'America/Chicago',
  'EST': 'America/New_York',
  'AST': 'America/Halifax',
  'BRT': 'America/Sao_Paulo',
  'GMT': 'Etc/GMT',
  'CET': 'Europe/Paris',
  'EET': 'Europe/Athens',
  'MSK': 'Europe/Moscow',
  'GST': 'Asia/Dubai',
  'PKT': 'Asia/Karachi',
  'IST': 'Asia/Kolkata',
  'NPT': 'Asia/Kathmandu',
  'BST': 'Asia/Dhaka',
  'ICT': 'Asia/Bangkok',
  'CST-Asia': 'Asia/Shanghai',
  'SGT': 'Asia/Singapore',
  'JST': 'Asia/Tokyo',
  'KST': 'Asia/Seoul',
  'ACST': 'Australia/Darwin',
  'AEST': 'Australia/Sydney',
  'NZST': 'Pacific/Auckland'
};

function getIANATimezone(timezone) {
  if (!timezone || timezone === 'auto') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return TZ_MAP[timezone] || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

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
  const ianaTz = getIANATimezone(timezone);
  const timeStr = resetDate.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ianaTz
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
  const ianaTz = getIANATimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ianaTz
  });
  const parts = formatter.formatToParts(resetDate);
  const day = parts.find(p => p.type === 'weekday')?.value || '';
  const date = parts.find(p => p.type === 'day')?.value || '';
  const month = parts.find(p => p.type === 'month')?.value || '';
  const hour = parts.find(p => p.type === 'hour')?.value || '';
  const minute = parts.find(p => p.type === 'minute')?.value || '';
  const dayPeriod = parts.find(p => p.type === 'dayPeriod')?.value || '';
  const timeStr = `${hour}:${minute} ${dayPeriod}`;

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
  return `${remaining} · resets ${day}, ${month} ${date} · ${timeStr}`;
}

// ─── Fetch interception (via injected MAIN-world script) ──────────────────────

function injectFetchHook() {
  if (document.getElementById('ux-fetch-hook')) return;
  const script = document.createElement('script');
  script.id = 'ux-fetch-hook';
  script.src = browser.runtime.getURL('inject.js');
  (document.head || document.documentElement).appendChild(script);
}

// ─── Account management & migration helpers ───────────────────────────────────

function sanitizeAccountId(id) {
  if (!id) return '';
  return String(id).replace(/[^a-zA-Z0-9_]/g, '_');
}

async function switchAccount(oldAccountId, newAccountId) {
  const storage = typeof browser !== "undefined" ? browser.storage : chrome.storage;
  
  // 1. Save current live stats to the old account's namespace
  if (oldAccountId) {
    const liveData = await storage.local.get(['today', 'usage_limits', 'conv_stats', 'user_email', 'user_name', 'user_plan']);
    const archive = {};
    if (liveData.today) archive[`today_${oldAccountId}`] = liveData.today;
    if (liveData.usage_limits) archive[`usage_limits_${oldAccountId}`] = liveData.usage_limits;
    if (liveData.conv_stats) archive[`conv_stats_${oldAccountId}`] = liveData.conv_stats;
    if (liveData.user_email) archive[`user_email_${oldAccountId}`] = liveData.user_email;
    if (liveData.user_name) archive[`user_name_${oldAccountId}`] = liveData.user_name;
    if (liveData.user_plan) archive[`user_plan_${oldAccountId}`] = liveData.user_plan;
    await storage.local.set(archive);
  }

  // 2. Load the new account's stats
  const newData = await storage.local.get([
    `today_${newAccountId}`,
    `usage_limits_${newAccountId}`,
    `conv_stats_${newAccountId}`,
    `user_email_${newAccountId}`,
    `user_name_${newAccountId}`,
    `user_plan_${newAccountId}`,
    'settings'
  ]);

  const settings = newData.settings || defaultSettings();
  const ianaTz = getIANATimezone(settings.timezone);

  const updates = {
    active_account_id: newAccountId,
    today: newData[`today_${newAccountId}`] || freshToday(ianaTz),
    usage_limits: newData[`usage_limits_${newAccountId}`] || {},
    conv_stats: newData[`conv_stats_${newAccountId}`] || {},
    user_email: newData[`user_email_${newAccountId}`] || '',
    user_name: newData[`user_name_${newAccountId}`] || '',
    user_plan: newData[`user_plan_${newAccountId}`] || ''
  };

  await storage.local.set(updates);

  if (typeof updateUI === 'function') {
    await updateUI();
  }
}

async function handleUserInfo(uuid, email, name) {
  const accountId = sanitizeAccountId(uuid || email);
  if (!accountId) return;

  const storage = typeof browser !== "undefined" ? browser.storage : chrome.storage;
  const res = await storage.local.get(['active_account_id', 'first_account_id', 'user_email', 'user_name']);
  const currentActive = res.active_account_id;
  let firstAccount = res.first_account_id;

  if (!firstAccount) {
    firstAccount = accountId;
    await storage.local.set({ first_account_id: accountId });
  }

  if (currentActive === accountId) {
    const updates = {};
    if (email && res.user_email !== email) updates.user_email = email;
    if (name && res.user_name !== name) updates.user_name = name;
    if (Object.keys(updates).length > 0) {
      await storage.local.set(updates);
      if (typeof updateUI === 'function') {
        await updateUI();
      }
    }
    return;
  }

  console.log('[UsageX] Account switch detected from', currentActive, 'to', accountId);

  if (email || name) {
    const targetArchive = {};
    if (email) targetArchive[`user_email_${accountId}`] = email;
    if (name) targetArchive[`user_name_${accountId}`] = name;
    await storage.local.set(targetArchive);
  }

  if (!currentActive) {
    if (accountId === firstAccount) {
      const updates = { active_account_id: accountId };
      if (email) updates.user_email = email;
      if (name) updates.user_name = name;
      await storage.local.set(updates);
      if (typeof updateUI === 'function') {
        await updateUI();
      }
    } else {
      await switchAccount(currentActive, accountId);
    }
  } else {
    await switchAccount(currentActive, accountId);
  }
}

windowMsgHandler = (event) => {
  if (event.source !== window) return;
  if (event.data.type === '__ux_fetch_msg') {
    onMessageSent({ body: event.data.body, convoId: event.data.convoId || null }).catch(() => { });
  } else if (event.data.type === '__ux_usage_data') {
    (async () => {
      const d = event.data.data;
      await updateUsageRate(d.session_pct, d.session_resets_at);
      await browser.storage.local.set({ usage_limits: d });
      await updateUI();
    })().catch(() => { });
  } else if (event.data.type === '__ux_convo_history') {
    onConversationHistory(event.data.data, event.data.convoId || null, event.data.convoName || null, event.data.modelId || null, event.data.thinkingMode || null).catch(() => { });
  } else if (event.data.type === '__ux_user_info') {
    (async () => {
      const email = event.data.email;
      const name = event.data.name;
      const plan = event.data.plan;
      if (!email && !name && !plan) return;
      const storage = typeof browser !== "undefined" ? browser.storage : chrome.storage;
      const res = await storage.local.get(['active_account_id', 'user_email', 'user_name', 'user_plan']);
      const currentActive = res.active_account_id;
      const updates = {};
      if (email && res.user_email !== email) updates.user_email = email;
      if (name && res.user_name !== name) updates.user_name = name;
      if (plan && res.user_plan !== plan) updates.user_plan = plan;
      if (currentActive) {
        if (email) updates[`user_email_${currentActive}`] = email;
        if (name) updates[`user_name_${currentActive}`] = name;
        if (plan) updates[`user_plan_${currentActive}`] = plan;
      }
      if (Object.keys(updates).length > 0) {
        await storage.local.set(updates);
        if (typeof updateUI === 'function') {
          await updateUI();
        }
      }
    })().catch(() => { });
  }
};
window.addEventListener('message', windowMsgHandler);

storageOnChangedHandler = (changes, area) => {
  if (area !== 'local') return;
  
  let needsUIUpdate = false;
  
  if (changes.settings) {
    const oldVal = changes.settings.oldValue || {};
    const newVal = changes.settings.newValue || {};
    if (oldVal.alert_session_threshold !== newVal.alert_session_threshold) {
      alertedFlags.session80 = false;
    }
    if (oldVal.alert_weekly_threshold !== newVal.alert_weekly_threshold) {
      alertedFlags.weekly80 = false;
    }
    needsUIUpdate = true;
  }
  
  if (changes.today || changes.active_account_id || changes.usage_limits) {
    needsUIUpdate = true;
  }
  
  if (needsUIUpdate) {
    updateUI().catch(() => { });
  }
};
browser.storage.onChanged.addListener(storageOnChangedHandler);

// ─── Message tracking ──────────────────────────────────────────────────────────

function getPromptFingerprint(text) {
  if (!text) return '';
  const cleaned = text.trim();
  return `${cleaned.length}_${cleaned.slice(0, 50)}`;
}

async function onMessageSent(req) {
  lastActive = Date.now();
  isIdle = false;
  let parsedBody = null;
  let promptText = '';
  try {
    parsedBody = JSON.parse(req.body);
    if (parsedBody) {
      if (typeof parsedBody.prompt === 'string') {
        promptText = parsedBody.prompt;
      } else if (typeof parsedBody.text === 'string') {
        promptText = parsedBody.text;
      } else {
        const lastMsg = parsedBody.messages?.at(-1)?.content;
        if (typeof lastMsg === 'string') {
          promptText = lastMsg;
        } else if (Array.isArray(lastMsg)) {
          promptText = lastMsg.map(b => b.text || '').join('');
        }
      }
    }
  } catch (_) { }
  const inputChars = promptText.length;
  const { effort, isThinking } = detectEffortAndThinking(parsedBody);
  const modelId = parsedBody?.model || null;
  const inputTokens = Math.round(inputChars / 4);
  const thinkTokens = isThinking ? effortThinkTokens(effort) : 0;
  const tokenDelta = inputTokens + thinkTokens;
  const { today } = await loadToday();

  // Record fingerprint to avoid double counting when history is loaded
  const fingerprint = getPromptFingerprint(promptText);
  const recent = today.recent_sent_prompts || [];
  if (fingerprint) {
    recent.push(fingerprint);
    if (recent.length > 20) recent.shift();
  }

  const lastModelToUse = modelId || today.last_model || null;
  const supportsEffortLevel = lastModelToUse ? modelSupportsEffortLevel(lastModelToUse) : false;
  const supportsExtended = lastModelToUse ? modelSupportsExtendedToggle(lastModelToUse) : false;
  const effortKey = effort.toLowerCase();
  const eb = today.effort_breakdown || { low: 0, medium: 0, high: 0, max: 0 };
  const et = today.extended_thinking || { on: 0, off: 0 };
  const mu = today.models_used || {};

  // Count effort breakdown independently of thinking state.
  // When thinking is off, effort is still set (e.g. "low") and should be tracked.
  if (supportsEffortLevel) {
    eb[effortKey] = (eb[effortKey] || 0) + 1;
  }
  if (supportsExtended) {
    const isExtendedOn = parsedBody?.thinking_mode ? (parsedBody.thinking_mode !== 'off') : isThinking;
    if (isExtendedOn) {
      et.on = (et.on || 0) + 1;
    } else {
      et.off = (et.off || 0) + 1;
    }
  }
  // Track per-model message count
  if (lastModelToUse) {
    mu[lastModelToUse] = (mu[lastModelToUse] || 0) + 1;
  }

  await saveToday({
    msgs: today.msgs + 1,
    tokens_est: today.tokens_est + tokenDelta,
    effort_breakdown: eb,
    extended_thinking: et,
    last_model: lastModelToUse,
    models_used: mu,
    recent_sent_prompts: recent
  });

  // Feature 14: track per-conversation stats
  const convoId = req.convoId || (location.pathname.startsWith('/chat/') ? location.pathname.split('/')[2] : null);
  if (convoId) {
    const convRes = await browser.storage.local.get('conv_stats');
    const convStats = convRes.conv_stats || {};
    const existing = convStats[convoId] || { msgs: 0, tokens_est: 0, started_at: Date.now(), name: null };
    const updatedConvo = {
      ...existing,
      msgs: existing.msgs + 1,
      tokens_est: existing.tokens_est + tokenDelta,
      last_active: Date.now()
    };
    convStats[convoId] = updatedConvo;
    await browser.storage.local.set({ conv_stats: convStats });
    // Also sync to IndexedDB for popup history
    await UsageXDB.saveConvoStats(convoId, updatedConvo).catch(() => {});
  }

  updateUI().catch(() => { });
  debugLog('msg_sent', { effort, isThinking, inputTokens, thinkTokens });
  setTimeout(() => {
    fetchUsageLimitsActive().catch(() => { });
  }, 2000);
}

async function onConversationHistory(chatMessages, convoId, convoName, modelId, thinkingMode) {
  if (!Array.isArray(chatMessages)) return;

  const { today } = await loadToday();
  if (!today.processed_msg_uuids) {
    today.processed_msg_uuids = [];
  }
  if (!today.recent_sent_prompts) {
    today.recent_sent_prompts = [];
  }

  let updated = false;
  let newMsgs = 0;
  let newTokenDelta = 0;
  const eb = today.effort_breakdown || { low: 0, medium: 0, high: 0, max: 0 };
  const et = today.extended_thinking || { on: 0, off: 0 };
  const mu = today.models_used || {};

  const isMessageToday = (dateStr) => {
    try {
      // Compare the message date string against the stored today.date
      // today.date is already computed with the correct timezone in loadToday()
      const msgDateOnly = dateStr ? dateStr.slice(0, 10) : '';
      return msgDateOnly === today.date;
    } catch (_) {
      return false;
    }
  };

  const activeModel = modelId || today.last_model || null;
  const supportsEffortLevel = activeModel ? modelSupportsEffortLevel(activeModel) : false;
  const supportsExtended = activeModel ? modelSupportsExtendedToggle(activeModel) : false;

  let isExtendedOn = false;
  if (supportsExtended) {
    if (thinkingMode) {
      isExtendedOn = (thinkingMode !== 'off');
    } else {
      isExtendedOn = chatMessages.some(m => m.sender === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'thinking'));
    }
  }

  for (let i = 0; i < chatMessages.length; i++) {
    const msg = chatMessages[i];
    if (msg.sender !== 'human' || !msg.uuid) continue;

    if (isMessageToday(msg.created_at) && !today.processed_msg_uuids.includes(msg.uuid)) {
      let promptText = '';
      if (Array.isArray(msg.content)) {
        promptText = msg.content.map(b => b.text || '').join('');
      } else if (typeof msg.content === 'string') {
        promptText = msg.content;
      }

      const fingerprint = getPromptFingerprint(promptText);
      const recent = today.recent_sent_prompts || [];
      const matchIndex = recent.indexOf(fingerprint);

      if (matchIndex !== -1) {
        // Already counted via completion. Just record UUID.
        recent.splice(matchIndex, 1);
        today.recent_sent_prompts = recent;
        today.processed_msg_uuids.push(msg.uuid);
        updated = true;
        continue;
      }

      // Detect thinking status and effort level from the following assistant response
      let isThinking = false;
      let thinkingTextLength = 0;
      const nextMsg = chatMessages[i + 1];
      if (nextMsg && nextMsg.sender === 'assistant' && Array.isArray(nextMsg.content)) {
        const thinkingBlock = nextMsg.content.find(b => b.type === 'thinking');
        if (thinkingBlock) {
          isThinking = true;
          thinkingTextLength = (thinkingBlock.thinking || '').length;
        }
      }

      let effort = 'Low';
      if (isThinking) {
        const estThinkingTokens = Math.round(thinkingTextLength / 4);
        if (estThinkingTokens >= 15000) effort = 'Max';
        else if (estThinkingTokens >= 4000) effort = 'High';
        else if (estThinkingTokens >= 800) effort = 'Medium';
        else effort = 'Low';
      }

      const inputTokens = Math.round(promptText.length / 4);
      const thinkTokens = isThinking ? effortThinkTokens(effort) : 0;
      const tokenDelta = inputTokens + thinkTokens;

      // Count effort breakdown independently of thinking state.
      // When thinking is off, effort is still set (e.g. "low") and should be tracked.
      if (supportsEffortLevel) {
        const effortKey = effort.toLowerCase();
        eb[effortKey] = (eb[effortKey] || 0) + 1;
      }
      if (supportsExtended) {
        if (isExtendedOn) {
          et.on = (et.on || 0) + 1;
        } else {
          et.off = (et.off || 0) + 1;
        }
      }

      newMsgs += 1;
      newTokenDelta += tokenDelta;

      today.processed_msg_uuids.push(msg.uuid);
      updated = true;
    }
  }

  if (updated) {
    if (today.processed_msg_uuids.length > 500) {
      today.processed_msg_uuids.splice(0, today.processed_msg_uuids.length - 500);
    }
    // Track per-model message count for conversation history sync
    if (activeModel && newMsgs > 0) {
      mu[activeModel] = (mu[activeModel] || 0) + newMsgs;
    }
    await saveToday({
      msgs: today.msgs + newMsgs,
      tokens_est: today.tokens_est + newTokenDelta,
      effort_breakdown: eb,
      extended_thinking: et,
      last_model: activeModel,
      models_used: mu,
      processed_msg_uuids: today.processed_msg_uuids,
      recent_sent_prompts: today.recent_sent_prompts
    });

    // Feature 14: update conv_stats from history sync
    if (convoId && newMsgs > 0) {
      const convRes = await browser.storage.local.get('conv_stats');
      const convStats = convRes.conv_stats || {};
      const existing = convStats[convoId] || { msgs: 0, tokens_est: 0, started_at: Date.now(), name: null };
      const updatedConvo = {
        ...existing,
        msgs: existing.msgs + newMsgs,
        tokens_est: existing.tokens_est + newTokenDelta,
        last_active: Date.now(),
        name: convoName || existing.name || null
      };
      convStats[convoId] = updatedConvo;
      await browser.storage.local.set({ conv_stats: convStats });
      // Also sync to IndexedDB for popup history
      await UsageXDB.saveConvoStats(convoId, updatedConvo).catch(() => {});
    }

    updateUI().catch(() => { });
    debugLog('history_synced', { newMsgs, newTokenDelta });
  }

  // Save conversation name whenever we have one, independent of new message count.
  // The name-save inside if (updated) only runs when newMsgs > 0, which misses
  // the case where all messages are already counted but the name was never stored.
  if (convoId && convoName) {
    const nameRes = await browser.storage.local.get('conv_stats');
    const nameStats = nameRes.conv_stats || {};
    if (nameStats[convoId] && !nameStats[convoId].name) {
      const namedConvo = { ...nameStats[convoId], name: convoName };
      nameStats[convoId] = namedConvo;
      await browser.storage.local.set({ conv_stats: nameStats });
      await UsageXDB.saveConvoStats(convoId, namedConvo).catch(() => {});
    }
  }
}

function effortThinkTokens(effort) {
  const map = { Low: 250, Medium: 1500, High: 6000, Max: 20000 };
  return map[effort] || 250;
}

// ─── Model helpers ─────────────────────────────────────────────────────────────

function modelDisplayName(modelId) {
  if (!modelId) return null;
  const id = modelId.toLowerCase();
  if (id.includes('sonnet-4-6')) return 'Sonnet 4.6';
  if (id.includes('sonnet-4-5')) return 'Sonnet 4.5';
  if (id.includes('opus-4-8')) return 'Opus 4.8';
  if (id.includes('opus-4-7')) return 'Opus 4.7';
  if (id.includes('opus-4-6')) return 'Opus 4.6';
  if (id.includes('opus-4-5')) return 'Opus 4.5';
  if (id.includes('fable')) return 'Fable 5';
  if (id.includes('mythos')) return 'Mythos 5';
  if (id.includes('haiku-4-5') || id.includes('haiku-4.5')) return 'Haiku 4.5';
  if (id.includes('haiku')) return 'Haiku';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('opus')) return 'Opus';
  return null;
}

function modelPillClass(modelId) {
  if (!modelId) return 'ux-model-pill-other';
  const id = modelId.toLowerCase();
  if (id.includes('sonnet')) return 'ux-model-pill-sonnet';
  if (id.includes('opus')) return 'ux-model-pill-opus';
  if (id.includes('haiku')) return 'ux-model-pill-haiku';
  return 'ux-model-pill-other';
}

function modelSupportsExtendedToggle(modelId) {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return (
    id.includes('sonnet-4') || id.includes('opus-4') ||
    id.includes('fable') || id.includes('mythos') ||
    id.includes('thinking') || id.includes('haiku-4-5') || id.includes('haiku-4.5')
  );
}

function modelSupportsEffortLevel(modelId) {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  if (id.includes('haiku-4-5') || id.includes('haiku-4.5')) return false;
  return (
    id.includes('sonnet-4') || id.includes('opus-4') ||
    id.includes('fable') || id.includes('mythos') ||
    id.includes('thinking')
  );
}

function modelSupportsEffort(modelId) {
  return modelSupportsExtendedToggle(modelId);
}

function detectEffort(parsedBody) {
  return detectEffortAndThinking(parsedBody).effort;
}

function detectEffortAndThinking(parsedBody) {
  let effort = 'Low';
  let isThinking = false;

  // ── 1. Read from request body (primary source) ──
  if (parsedBody) {
    const thinkingMode = parsedBody?.thinking_mode;

    if (thinkingMode === 'off') {
      isThinking = false;
      // Even with thinking off, the model may still have an effort_level set.
      // Read it so the effort breakdown is recorded accurately.
      const effortStr =
        parsedBody?.output_config?.effort ??
        parsedBody?.thinking?.effort ??
        parsedBody?.effort ??
        null;
      if (typeof effortStr === 'string') {
        const e = effortStr.toLowerCase();
        if (e === 'max' || e === 'xhigh') effort = 'Max';
        else if (e === 'high') effort = 'High';
        else if (e === 'medium') effort = 'Medium';
        else effort = 'Low';
      }
    } else if (thinkingMode === 'auto' || thinkingMode === 'extended') {
      isThinking = true;

      const effortStr =
        parsedBody?.output_config?.effort ??
        parsedBody?.thinking?.effort ??
        parsedBody?.effort ??
        null;

      const budget =
        parsedBody?.thinking?.budget_tokens ??
        parsedBody?.thinking_budget ??
        parsedBody?.metadata?.thinking_budget ??
        null;

      if (typeof effortStr === 'string') {
        const e = effortStr.toLowerCase();
        if (e === 'max' || e === 'xhigh') effort = 'Max';
        else if (e === 'high') effort = 'High';
        else if (e === 'medium') effort = 'Medium';
        else effort = 'Low';
      } else if (budget != null && typeof budget === 'number' && budget > 0) {
        if (budget >= 16000) effort = 'Max';
        else if (budget >= 8000) effort = 'High';
        else if (budget >= 2000) effort = 'Medium';
        else effort = 'Low';
      } else {
        effort = 'Low';
      }
    } else {
      // Fallback for when thinking_mode is not present (standard/older API structure)
      const thinkingType = parsedBody?.thinking?.type;
      const isExplicitlyDisabled = thinkingType === 'disabled' || thinkingType === 'none';

      const effortStr =
        parsedBody?.output_config?.effort ??
        parsedBody?.thinking?.effort ??
        parsedBody?.effort ??
        null;

      const budget =
        parsedBody?.thinking?.budget_tokens ??
        parsedBody?.thinking_budget ??
        parsedBody?.metadata?.thinking_budget ??
        null;

      if (!isExplicitlyDisabled) {
        if (typeof effortStr === 'string') {
          const e = effortStr.toLowerCase();
          isThinking = true;
          if (e === 'max' || e === 'xhigh') effort = 'Max';
          else if (e === 'high') effort = 'High';
          else if (e === 'medium') effort = 'Medium';
          else effort = 'Low';
        } else if (budget != null && typeof budget === 'number' && budget > 0) {
          isThinking = true;
          if (budget >= 16000) effort = 'Max';
          else if (budget >= 8000) effort = 'High';
          else if (budget >= 2000) effort = 'Medium';
          else effort = 'Low';
        } else if (thinkingType === 'enabled' || thinkingType === 'adaptive') {
          isThinking = true;
          effort = 'Low';
        }
      }
    }
  }

  // ── 2. DOM fallback ──
  if (!isThinking) {
    const selectors = [
      '[data-testid="model-selector"]',
      'button[aria-label*="model"]',
      'button[aria-label*="effort"]',
      'button[aria-label*="thinking"]',
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
    if (match) {
      effort = match[1];
      const lowerText = text.toLowerCase();
      if (lowerText.includes('think') || lowerText.includes('reason') || lowerText.includes('effort') || effort !== 'Low') {
        isThinking = true;
      }
    }
  }

  return { effort, isThinking };
}

// ─── URL tracking ──────────────────────────────────────────────────────────────

function checkUrlChange() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (location.pathname.startsWith('/chat/')) {
      loadToday().then(({ today }) => {
        saveToday({ convos: today.convos + 1 });
      }).catch(() => { });
      debugLog('new_convo', { url: location.href });
    }
    setTimeout(() => updateUI().catch(() => { }), 500);
  }
}

// ─── Time tracking ─────────────────────────────────────────────────────────────

function startTimeTracking() {
  timeTrackingInterval = setInterval(() => {
    if (!isIdle) {
      loadToday().then(({ today }) => {
        saveToday({ time_s: today.time_s + 10 }).catch(() => { });
      }).catch(() => { });
    }
  }, TICK_MS);

  resetIdleHandler = () => {
    lastActive = Date.now();
    if (isIdle) { isIdle = false; updateUI().catch(() => { }); }
  };
  ['mousemove', 'keydown', 'click', 'touchstart'].forEach(ev =>
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
    try { const el = fn(); if (el) return el; } catch (_) { }
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
    } catch (_) { }
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

    // Apply saved mode classes before insertion
    const settingsRes = await browser.storage.local.get('settings');
    const s = settingsRes.settings || defaultSettings();
    if (s.minimized) {
      root.classList.add('ux-minimized');
    }
    const minBtn = root.querySelector('#ux-btn-minimize');
    if (minBtn) {
      minBtn.setAttribute('data-tooltip', s.minimized ? 'Expand (Alt+U)' : 'Minimize (Alt+U)');
    }
    if (s.floating) {
      root.classList.add('ux-floating');
      const fx = s.float_x != null ? s.float_x : window.innerWidth - 266;
      const fy = s.float_y != null ? s.float_y : window.innerHeight - 200;
      root.style.left = fx + 'px';
      root.style.top = fy + 'px';
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
  if (ratePerHour > 21) return 'up';
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

  const minBtn = root.querySelector('#ux-btn-minimize');
  if (minBtn) {
    minBtn.setAttribute('data-tooltip', collapsed ? 'Expand (Alt+U)' : 'Minimize (Alt+U)');
  }

  if (resetViews && collapsed) {
    root.classList.remove('ux-settings-open');
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
      injectSidebar().catch(() => { });
      return;
    }

    togglePanelCollapsed().catch(() => { });
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
      up: { label: 'Above normal (>21%/h)', cls: 'ux-rate-up' },
      neutral: { label: 'On track (~20%/h)', cls: 'ux-rate-neutral' },
      down: { label: 'Below normal (<19%/h) — good!', cls: 'ux-rate-down' },
      gray: { label: 'Usage rate: Calculating...', cls: 'ux-rate-gray' },
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
        ? `<div class="ux-time-line"><span class="ux-time-remaining">${sessionRemaining}</span></div><div class="ux-time-line"><span class="ux-time-reset"><svg class="ux-reset-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>${sessionReset}</span></div>`
        : `<div class="ux-time-line"><span class="ux-time-remaining">${sessionTimeStr}</span></div>`;
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
        ? `<div class="ux-time-line"><span class="ux-time-remaining">${weeklyRemaining}</span></div><div class="ux-time-line"><span class="ux-time-reset"><svg class="ux-reset-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>${weeklyReset}</span></div>`
        : `<div class="ux-time-line"><span class="ux-time-remaining">${weeklyTimeStr}</span></div>`;
    }
  } else {
    setEl('#ux-weekly-time', '');
  }

  // Debug count
  const dbgRes = await browser.storage.local.get('debug_logs');
  const debugLogs = dbgRes.debug_logs || [];
  const dbgCount = debugLogs.length;
  setEl('#ux-debug-count', `${dbgCount}`);

  const sessionRemainingEstimate = estimateMessagesRemaining(sessionPct, usage_limits?.session_resets_at, debugLogs);
  const sessionTrackForRemaining = root.querySelector('#ux-session-track');
  if (sessionTrackForRemaining) {
    let tipText = getSessionTooltipText(sessionPct);
    if (tipText && Number(sessionPct) > 0) {
      sessionTrackForRemaining.setAttribute('data-tooltip', tipText);
    }
  }
  const sessionRemainingEl = root.querySelector('#ux-session-remaining');
  if (sessionRemainingEl) {
    if (sessionRemainingEstimate != null) {
      sessionRemainingEl.innerHTML = `<div class="ux-time-line"><span class="ux-time-reset"><svg class="ux-reset-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>~${sessionRemainingEstimate} messages left</span></div>`;
      sessionRemainingEl.style.display = 'block';
    } else {
      sessionRemainingEl.style.display = 'none';
    }
  }

  // Settings panel state
  const dbgToggle = root.querySelector('#ux-setting-debug');
  const floatToggle = root.querySelector('#ux-setting-float');
  if (dbgToggle) dbgToggle.checked = settings.debug_logging !== false;

  const browserNotifToggle = root.querySelector('#ux-setting-notifications-browser');
  const toastNotifToggle = root.querySelector('#ux-setting-notifications-toast');
  const limitsResetToggle = root.querySelector('#ux-setting-alert-limits-reset');
  const usageThresholdToggle = root.querySelector('#ux-setting-alert-usage-threshold');
  const peakHoursToggle = root.querySelector('#ux-setting-alert-peak-hours');

  if (browserNotifToggle) browserNotifToggle.checked = settings.notifications_browser === true;
  if (toastNotifToggle) toastNotifToggle.checked = settings.notifications_toast !== false;
  if (limitsResetToggle) limitsResetToggle.checked = settings.alert_limits_reset !== false;
  if (usageThresholdToggle) usageThresholdToggle.checked = settings.alert_usage_threshold !== false;
  if (peakHoursToggle) peakHoursToggle.checked = settings.alert_peak_hours !== false;

  const anyNotifEnabled = (settings.notifications_browser === true || settings.notifications_toast !== false);
  const toastNotifEnabled = (settings.notifications_toast !== false);
  const alertLimitsRow = root.querySelector('#ux-alert-limits-row');
  const alertThresholdRow = root.querySelector('#ux-alert-threshold-row');
  const alertPeakRow = root.querySelector('#ux-alert-peak-row');
  const toastPositionRow = root.querySelector('#ux-toast-position-row');

  if (alertLimitsRow) alertLimitsRow.style.display = anyNotifEnabled ? 'flex' : 'none';
  if (alertThresholdRow) alertThresholdRow.style.display = anyNotifEnabled ? 'flex' : 'none';
  if (alertPeakRow) alertPeakRow.style.display = anyNotifEnabled ? 'flex' : 'none';
  if (toastPositionRow) {
    toastPositionRow.style.display = toastNotifEnabled ? 'flex' : 'none';
    const currentPos = settings.toast_position || 'bottom-right';
    toastPositionRow.querySelectorAll('.ux-toast-pos-btn').forEach(btn => {
      if (btn.dataset.value === currentPos) {
        btn.classList.add('ux-active');
      } else {
        btn.classList.remove('ux-active');
      }
    });
  }

  const toastContainer = document.getElementById('ux-toast-container');
  if (toastContainer) {
    toastContainer.className = `ux-toast-pos-${settings.toast_position || 'bottom-right'}`;
  }

  // Update custom sidebar side dropdown label
  const currentSide = settings.sidebar_side || 'left';
  const sideLabel = root.querySelector('#ux-side-label');
  const sideDropdownEl = root.querySelector('#ux-side-dropdown');
  if (sideLabel && sideDropdownEl) {
    const activeSideOpt = sideDropdownEl.querySelector(`.ux-csel-option[data-value="${currentSide}"]`);
    if (activeSideOpt) {
      sideLabel.textContent = activeSideOpt.textContent;
      sideDropdownEl.querySelectorAll('.ux-csel-option').forEach(o => o.classList.remove('ux-csel-active'));
      activeSideOpt.classList.add('ux-csel-active');
    }
  }
  // Update custom timezone dropdown label
  const currentTz = settings.timezone || 'auto';
  const tzLabel = root.querySelector('#ux-tz-label');
  const tzDropdownEl = root.querySelector('#ux-tz-dropdown');
  if (tzLabel && tzDropdownEl) {
    const activeOpt = tzDropdownEl.querySelector(`.ux-csel-option[data-value="${currentTz}"]`);
    if (activeOpt) {
      tzLabel.textContent = activeOpt.textContent;
      tzDropdownEl.querySelectorAll('.ux-csel-option').forEach(o => o.classList.remove('ux-csel-active'));
      activeOpt.classList.add('ux-csel-active');
    }
  }
  if (floatToggle) floatToggle.checked = settings.floating === true;

  const isFloating = settings.floating === true;
  const isOpacityEnabled = settings.floating_opacity_enabled !== false;
  const opacityVal = settings.floating_opacity != null ? settings.floating_opacity : 0.85;

  const sidebarSideRow = root.querySelector('#ux-sidebar-side-row');
  if (sidebarSideRow) {
    sidebarSideRow.style.display = isFloating ? 'none' : 'flex';
  }

  const opacityCheckboxRow = root.querySelector('#ux-opacity-checkbox-row');
  if (opacityCheckboxRow) {
    opacityCheckboxRow.style.display = isFloating ? 'flex' : 'none';
  }

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

  const isResizable = settings.resizable === true && isFloating;
  const resizeRow = root.querySelector('#ux-resize-row');
  if (resizeRow) {
    resizeRow.style.display = isFloating ? 'flex' : 'none';
  }
  const resizeToggle = root.querySelector('#ux-setting-resize');
  if (resizeToggle) {
    resizeToggle.checked = settings.resizable === true;
  }
  const rHandleLeft = root.querySelector('#ux-resize-handle-left');
  const rHandleRight = root.querySelector('#ux-resize-handle-right');
  if (rHandleLeft && rHandleRight) {
    rHandleLeft.style.display = isResizable ? 'block' : 'none';
    rHandleRight.style.display = isResizable ? 'block' : 'none';
  }

  root.style.height = ''; // Always keep height auto to avoid ugly black gaps
  if (isResizable && !root.classList.contains('ux-minimized')) {
    if (settings.float_width) root.style.width = settings.float_width + 'px';
  } else {
    if (isFloating) {
      root.style.width = '250px';
    } else {
      root.style.width = '';
    }
  }
  // ── Effort pills ──
  const lastModel = today.last_model || null;
  const supportsEffortLevel = lastModel ? modelSupportsEffortLevel(lastModel) : false;
  const supportsExtended = lastModel ? modelSupportsExtendedToggle(lastModel) : false;

  const effortSec = root.querySelector('#ux-effort-section');
  const effortModelBadge = root.querySelector('#ux-effort-model-badge');
  const eb = today.effort_breakdown || { low: 0, medium: 0, high: 0, max: 0 };

  if (effortSec) {
    effortSec.style.display = supportsExtended ? '' : 'none';
    const pillsWrap = root.querySelector('.ux-effort-pills');
    if (pillsWrap) {
      pillsWrap.style.display = supportsEffortLevel ? '' : 'none';
    }
    const epPairs = [
      ['low', '#ux-ep-low', '#ux-epc-low'],
      ['medium', '#ux-ep-med', '#ux-epc-med'],
      ['high', '#ux-ep-high', '#ux-epc-high'],
      ['max', '#ux-ep-max', '#ux-epc-max'],
    ];
    for (const [key, pillSel, countSel] of epPairs) {
      const cnt = eb[key] || 0;
      const pillEl = root.querySelector(pillSel);
      const countEl = root.querySelector(countSel);
      if (pillEl) pillEl.style.display = (supportsEffortLevel && cnt > 0) ? '' : 'none';
      if (countEl) countEl.textContent = String(cnt);
    }
  }

  // Render model pills row (all models used today)
  const modelPillsRow = root.querySelector('#ux-model-pills-row');
  if (modelPillsRow) {
    const mu = today.models_used || {};
    const modelEntries = Object.entries(mu).filter(([, c]) => c > 0);
    // Fallback: if no models_used, show last_model as single pill
    if (modelEntries.length === 0 && lastModel) {
      modelEntries.push([lastModel, 0]);
    }
    if (modelEntries.length > 0) {
      modelPillsRow.innerHTML = modelEntries
        .sort((a, b) => b[1] - a[1])
        .map(([mid]) => {
          const name = modelDisplayName(mid);
          if (!name) return '';
          const cls = modelPillClass(mid);
          return `<span class="ux-model-pill ${cls}">${name}</span>`;
        })
        .filter(Boolean)
        .join('');
      modelPillsRow.style.display = '';
    } else {
      modelPillsRow.style.display = 'none';
    }
  }
  // Keep legacy badge hidden — replaced by pill row
  if (effortModelBadge) effortModelBadge.style.display = 'none';

  const extendedRow = root.querySelector('#ux-extended-row');
  if (extendedRow) {
    if (supportsExtended) {
      extendedRow.style.display = '';
      const et = today.extended_thinking || { on: 0, off: 0 };
      const etOnVal = root.querySelector('#ux-extc-on');
      const etOffVal = root.querySelector('#ux-extc-off');
      if (etOnVal) etOnVal.textContent = String(et.on || 0);
      if (etOffVal) etOffVal.textContent = String(et.off || 0);
    } else {
      extendedRow.style.display = 'none';
    }
  }

  updatePeakClock();
  checkToastAlerts(sessionPct, weeklyPct, usageRateState, settings);
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

// ─── Toast icon SVGs ───────────────────────────────────────────────────────────

const UX_TOAST_ICONS = {
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  flame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
};

function _resolveToastIcon(title, type) {
  const t = (title || '').toLowerCase();
  if (t.includes('limit') || t.includes('locked') || t.includes('reached')) return UX_TOAST_ICONS.lock;
  if (t.includes('burn') || t.includes('burning')) return UX_TOAST_ICONS.flame;
  if (t.includes('off-peak') || t.includes('ended')) return UX_TOAST_ICONS.moon;
  if (t.includes('peak hour') || t.includes('approaching')) return UX_TOAST_ICONS.clock;
  if (t.includes('safe') || t.includes('stabilized') || t.includes('pace')) return UX_TOAST_ICONS.check;
  if (type === 'red') return UX_TOAST_ICONS.lock;
  if (type === 'green') return UX_TOAST_ICONS.check;
  return UX_TOAST_ICONS.warning;
}

function _dismissToast(toast, timer) {
  if (!toast || toast.classList.contains('ux-toast-exit')) return;
  if (timer) clearTimeout(timer);
  toast.classList.add('ux-toast-exit');
  setTimeout(() => {
    toast.remove();
    const container = document.getElementById('ux-toast-container');
    if (container && container.children.length === 0) container.remove();
  }, 300);
}

function showToast(title, body, type = 'info') {
  browser.storage.local.get('settings').then((res) => {
    const settings = res.settings || {};
    if (settings.notifications_toast === false) return;

    let container = document.getElementById('ux-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'ux-toast-container';
      document.body.appendChild(container);
    }
    const pos = settings.toast_position || 'bottom-right';
    container.className = `ux-toast-pos-${pos}`;

    // Max 3 toasts visible — evict oldest if needed
    const visible = container.querySelectorAll('.ux-toast:not(.ux-toast-exit)');
    if (visible.length >= 3) _dismissToast(visible[visible.length - 1]);

    const iconSvg = _resolveToastIcon(title, type);

    const toast = document.createElement('div');
    toast.className = `ux-toast ux-toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    toast.innerHTML = `
      <div class="ux-toast-icon" aria-hidden="true">${iconSvg}</div>
      <div class="ux-toast-body">
        <p class="ux-toast-title">${title}</p>
        <p class="ux-toast-sub">${body}</p>
      </div>
      <button class="ux-toast-close" aria-label="Dismiss notification" data-tooltip="Dismiss">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="ux-toast-timer">
        <div class="ux-toast-timer-fill"></div>
      </div>
    `;

    container.prepend(toast);

    const TOAST_DURATION = 5000;
    let toastStart = Date.now();
    let elapsedBeforeHover = 0;
    let dismissTimer = setTimeout(() => _dismissToast(toast), TOAST_DURATION);

    toast.querySelector('.ux-toast-close').addEventListener('click', () => {
      _dismissToast(toast, dismissTimer);
    });

    toast.addEventListener('mouseenter', () => {
      // Snapshot how much time has elapsed so far, then freeze everything
      elapsedBeforeHover += Date.now() - toastStart;
      clearTimeout(dismissTimer);
      dismissTimer = null;
      const fill = toast.querySelector('.ux-toast-timer-fill');
      if (fill) fill.style.animationPlayState = 'paused';
    });
    toast.addEventListener('mouseleave', () => {
      // Resume the CSS bar from its frozen frame, schedule dismissal for remaining time
      toastStart = Date.now();
      const remaining = Math.max(0, TOAST_DURATION - elapsedBeforeHover);
      const fill = toast.querySelector('.ux-toast-timer-fill');
      if (fill) fill.style.animationPlayState = 'running';
      dismissTimer = setTimeout(() => _dismissToast(toast), remaining);
    });

  }).catch((err) => {
    console.error('[UsageX] Error showing toast:', err);
  });
}

function checkToastAlerts(sessionPct, weeklyPct, usageRateState, settings) {
  // Check limit threshold alerts
  if (settings.alert_usage_threshold !== false) {
    // 100% lockout warning
    if ((sessionPct != null && sessionPct >= 100) || (weeklyPct != null && weeklyPct >= 100)) {
      if (!alertedFlags.limitReached) {
        showToast("Usage Limit Reached", "You have consumed 100% of your Claude quota. Please wait for the reset.", "red");
        alertedFlags.limitReached = true;
      }
    } else {
      alertedFlags.limitReached = false;
    }

    // Dynamic Session usage warning (Feature 10)
    const sessionThresh = Number(settings.alert_session_threshold ?? 80);
    if (sessionPct != null && sessionPct >= sessionThresh && sessionPct < 100) {
      if (!alertedFlags.session80) {
        showToast("High Session Usage", `Session usage is at ${Math.round(sessionPct)}%. Consider lowering your effort level.`, "yellow");
        alertedFlags.session80 = true;
      }
    } else if (sessionPct != null && sessionPct < sessionThresh) {
      alertedFlags.session80 = false;
    }

    // Dynamic Weekly usage warning (Feature 10)
    const weeklyThresh = Number(settings.alert_weekly_threshold ?? 80);
    if (weeklyPct != null && weeklyPct >= weeklyThresh && weeklyPct < 100) {
      if (!alertedFlags.weekly80) {
        showToast("High Weekly Usage", `Weekly usage is at ${Math.round(weeklyPct)}%. You are close to your weekly limit.`, "yellow");
        alertedFlags.weekly80 = true;
      }
    } else if (weeklyPct != null && weeklyPct < weeklyThresh) {
      alertedFlags.weekly80 = false;
    }
  }

  // Check limits reset / pace alerts
  if (settings.alert_limits_reset !== false) {
    if (usageRateState !== 'gray') {
      if (alertedFlags.usageRateState !== usageRateState) {
        if (usageRateState === 'extreme') {
          showToast("Burning Fast!", "You're consuming tokens at an extreme rate. Try lowering Claude's thinking effort.", "yellow");
        } else if (usageRateState === 'down' && alertedFlags.usageRateState != null) {
          showToast("Pace Stabilized", "Your usage rate is below budget. Good pace!", "green");
        }
        alertedFlags.usageRateState = usageRateState;
      }
    }
  }

  // Check Peak hours alerts
  if (settings.alert_peak_hours !== false) {
    const { h, m, dayOfWeek } = getPeakClockIST();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const curH = h + m / 60;
    const inPeak = !isWeekend && (curH >= 18.5 || curH < 0.5);
    const peakApproaching = !isWeekend && (curH >= 18.25 && curH < 18.5);

    if (alertedFlags.peakHoursState !== null && alertedFlags.peakHoursState !== inPeak) {
      if (inPeak) {
        showToast("Peak Hours Started", "Claude limits deplete faster during peak traffic (6:30 PM - 12:30 AM IST).", "yellow");
      } else {
        showToast("Peak Hours Ended", "Claude has exited peak hours. Good time to prompt!", "green");
      }
    }
    alertedFlags.peakHoursState = inPeak;

    if (peakApproaching) {
      if (!alertedFlags.peakHoursApproaching) {
        showToast("Peak Hours Approaching", "Peak hours will start in 15 minutes (6:30 PM IST). Limits will deplete faster.", "yellow");
        alertedFlags.peakHoursApproaching = true;
      }
    } else {
      alertedFlags.peakHoursApproaching = false;
    }
  }
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
    root.classList.toggle('ux-settings-open');
    updateUI().catch(() => { });
  });

  // Settings back → main view
  root.querySelector('#ux-settings-back-btn')?.addEventListener('click', () => {
    root.classList.remove('ux-settings-open');
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

  root.querySelector('#ux-setting-notifications-browser')?.addEventListener('change', async (e) => {
    await saveSettings({ notifications_browser: e.target.checked });
    updateUI().catch(() => { });
  });

  root.querySelector('#ux-setting-notifications-toast')?.addEventListener('change', async (e) => {
    await saveSettings({ notifications_toast: e.target.checked });
    updateUI().catch(() => { });
  });

  root.querySelectorAll('.ux-toast-pos-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const pos = e.currentTarget.dataset.value;
      await saveSettings({ toast_position: pos });
      updateUI().catch(() => { });
    });
  });

  root.querySelector('#ux-setting-alert-limits-reset')?.addEventListener('change', async (e) => {
    await saveSettings({ alert_limits_reset: e.target.checked });
  });

  root.querySelector('#ux-setting-alert-usage-threshold')?.addEventListener('change', async (e) => {
    await saveSettings({ alert_usage_threshold: e.target.checked });
  });

  root.querySelector('#ux-setting-alert-peak-hours')?.addEventListener('change', async (e) => {
    await saveSettings({ alert_peak_hours: e.target.checked });
  });

  root.querySelector('#ux-notifications-header')?.addEventListener('click', () => {
    const sec = root.querySelector('#ux-section-notifications');
    if (sec) {
      sec.classList.toggle('ux-section-collapsed');
    }
  });

  // Test Toast button — cycles through all toast variants
  (() => {
    const testToasts = [
      { title: 'High Session Usage', body: 'Session usage is at 82%. Consider lowering your effort level.', type: 'yellow' },
      { title: 'Burning Fast!', body: "You're consuming tokens at an extreme rate. Try lowering Claude's thinking effort.", type: 'yellow' },
      { title: 'Usage Limit Reached', body: 'You have consumed 100% of your Claude quota. Please wait for the reset.', type: 'red' },
      { title: 'Peak Hours Started', body: 'Claude limits deplete faster during peak traffic (6:30 PM – 12:30 AM IST).', type: 'yellow' },
      { title: 'Peak Hours Approaching', body: 'Peak hours will start in 15 minutes (6:30 PM IST). Limits will deplete faster.', type: 'yellow' },
      { title: 'Peak Hours Ended', body: 'Claude has exited peak hours. Good time to prompt!', type: 'green' },
      { title: 'Pace Stabilized', body: 'Your usage rate is below budget. Good pace!', type: 'green' },
    ];
    let testIdx = 0;
    root.querySelector('#ux-btn-test-toast')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = testToasts[testIdx % testToasts.length];
      showToast(t.title, t.body, t.type);
      testIdx++;
    });
  })();

  root.querySelector('#ux-setting-floating-opacity-enabled')?.addEventListener('change', async (e) => {
    await saveSettings({ floating_opacity_enabled: e.target.checked });
    updateUI().catch(() => { });
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

  // Custom sidebar side dropdown
  const sideBtn = root.querySelector('#ux-side-btn');
  const sideDrop = root.querySelector('#ux-side-dropdown');
  const sideWrap = root.querySelector('#ux-side-select');
  if (sideBtn && sideDrop && sideWrap) {
    sideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      root.querySelector('#ux-tz-select')?.classList.remove('ux-csel-open');
      sideWrap.classList.toggle('ux-csel-open');
    });
    sideDrop.addEventListener('click', async (e) => {
      const opt = e.target.closest('.ux-csel-option');
      if (!opt) return;
      const side = opt.dataset.value;
      await saveSettings({ sidebar_side: side });
      sideWrap.classList.remove('ux-csel-open');
      const s = await getSettings();
      if (!s.floating) {
        if (side === 'right') {
          root.classList.add('ux-side-right');
        } else {
          root.classList.remove('ux-side-right');
        }
      }
      updateUI().catch(() => { });
    });
    document.addEventListener('click', (e) => {
      if (!sideWrap.contains(e.target)) sideWrap.classList.remove('ux-csel-open');
    });
  }

  // Custom timezone dropdown
  const tzBtn = root.querySelector('#ux-tz-btn');
  const tzDrop = root.querySelector('#ux-tz-dropdown');
  const tzWrap = root.querySelector('#ux-tz-select');
  if (tzBtn && tzDrop && tzWrap) {
    tzBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      root.querySelector('#ux-side-select')?.classList.remove('ux-csel-open');
      tzWrap.classList.toggle('ux-csel-open');
    });
    tzDrop.addEventListener('click', async (e) => {
      const opt = e.target.closest('.ux-csel-option');
      if (!opt) return;
      await saveSettings({ timezone: opt.dataset.value });
      tzWrap.classList.remove('ux-csel-open');
      updateUI().catch(() => { });
    });
    document.addEventListener('click', (e) => {
      if (!tzWrap.contains(e.target)) tzWrap.classList.remove('ux-csel-open');
    });
  }

  // Float toggle — move DOM node, never destroy+recreate
  root.querySelector('#ux-setting-float')?.addEventListener('change', async (e) => {
    const enable = e.target.checked;
    await saveSettings({ floating: enable });
    if (enable) {
      // Move from sidebar into body as floating panel
      const s = await getSettings();
      const fx = s.float_x != null ? s.float_x : window.innerWidth - 266;
      const fy = s.float_y != null ? s.float_y : window.innerHeight - 200;
      root.style.left = fx + 'px';
      root.style.top = fy + 'px';
      root.classList.add('ux-floating');
      root.classList.remove('ux-side-right'); // Clean up sidebar side classes when entering float mode
      document.body.appendChild(root); // moves node — no clone
    } else {
      // Move back into sidebar
      root.classList.remove('ux-floating');
      root.style.left = '';
      root.style.top = '';
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
    updateUI().catch(() => { });
  });

  root.querySelector('#ux-btn-reset')?.addEventListener('click', async () => {
    const res = await browser.storage.local.get('settings');
    const settings = res.settings || defaultSettings();
    const ianaTz = getIANATimezone(settings.timezone);
    await browser.storage.local.set({ today: freshToday(ianaTz) });
    await UsageXDB.clearAllStats().catch(() => {});
    await updateUI();
  });

  root.querySelector('#ux-btn-clear-debug')?.addEventListener('click', async () => {
    await browser.storage.local.set({ debug_logs: [] });
    await updateUI();
  });

  root.querySelector('#ux-btn-open-help')?.addEventListener('click', async () => {
    try {
      // Signal to the popup that it should open on the Help tab
      await browser.storage.local.set({ _open_help_tab: true });

      // Attempt to open the actual extension popup via background script
      const response = await new Promise((resolve) => {
        browser.runtime.sendMessage({ action: 'OPEN_HELP_POPUP' }, (res) => {
          if (browser.runtime.lastError) {
            resolve({ success: false, error: browser.runtime.lastError.message });
          } else {
            resolve(res || { success: false });
          }
        });
      });

      if (!response || !response.success) {
        console.warn('[UsageX] Failed to open popup UI via background script. Error:', response?.error || 'unknown');
        // Open the popup page directly in a new tab as a reliable fallback
        const popupUrl = browser.runtime.getURL('popup.html') + '?tab=help';
        browser.tabs.create({ url: popupUrl });
      }
    } catch (err) {
      console.error('[UsageX] Error during open-help click:', err);
      try {
        const popupUrl = browser.runtime.getURL('popup.html') + '?tab=help';
        browser.tabs.create({ url: popupUrl });
      } catch (_) { }
    }
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
      const nx = Math.max(0, Math.min(window.innerWidth - root.offsetWidth, e.clientX - ox));
      const ny = Math.max(0, Math.min(window.innerHeight - root.offsetHeight, e.clientY - oy));
      root.style.left = nx + 'px';
      root.style.top = ny + 'px';
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

  root.querySelector('#ux-setting-resize')?.addEventListener('change', async (e) => {
    const enable = e.target.checked;
    await saveSettings({ resizable: enable });
    updateUI().catch(() => { });
  });

  const handleLeft = root.querySelector('#ux-resize-handle-left');
  const handleRight = root.querySelector('#ux-resize-handle-right');

  if (handleLeft && handleRight) {
    let resizing = false;
    let resizeSide = null; // 'left' | 'right'
    let startWidth = 0;
    let startX = 0;
    let startLeft = 0;

    const onMouseDown = (e, side) => {
      if (!root.classList.contains('ux-floating')) return;
      resizing = true;
      resizeSide = side;
      startWidth = root.offsetWidth;
      startX = e.clientX;
      startLeft = parseFloat(root.style.left) || root.getBoundingClientRect().left;

      root.style.transition = 'none';
      const handle = side === 'left' ? handleLeft : handleRight;
      handle.classList.add('ux-resizing-active');

      e.preventDefault();
      e.stopPropagation();
    };

    handleLeft.addEventListener('mousedown', (e) => onMouseDown(e, 'left'));
    handleRight.addEventListener('mousedown', (e) => onMouseDown(e, 'right'));

    const onMouseMove = (e) => {
      if (!resizing) return;
      let newWidth = startWidth;
      if (resizeSide === 'left') {
        const deltaX = e.clientX - startX;
        newWidth = Math.max(220, Math.min(500, startWidth - deltaX));
        const actualDeltaX = startWidth - newWidth;
        root.style.left = (startLeft + actualDeltaX) + 'px';
      } else {
        const deltaX = e.clientX - startX;
        newWidth = Math.max(220, Math.min(500, startWidth + deltaX));
      }
      root.style.width = newWidth + 'px';
    };

    const onMouseUp = async () => {
      if (!resizing) return;
      resizing = false;
      root.style.transition = '';
      handleLeft.classList.remove('ux-resizing-active');
      handleRight.classList.remove('ux-resizing-active');

      const w = parseInt(root.style.width, 10);
      const l = parseInt(root.style.left, 10);
      await saveSettings({ float_width: w, float_x: l });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }
}

// ─── Export helpers ────────────────────────────────────────────────────────────

async function exportData() {
  const localData = await browser.storage.local.get(['today', 'settings', 'usage_limits', 'debug_logs', 'conv_stats']);
  const dailyStats = await UsageXDB.getAllDailyStats();
  const convoStats = await UsageXDB.getAllConvoStats();
  
  // Merge conv_stats from storage.local (live) with IndexedDB (archived)
  const mergedConvStats = convoStats.reduce((acc, curr) => {
    acc[curr.convoId] = curr;
    return acc;
  }, {});
  Object.assign(mergedConvStats, localData.conv_stats || {});

  const exportPayload = {
    ...localData,
    history: dailyStats,
    conv_stats: mergedConvStats
  };
  download('usagex-export.json', JSON.stringify(exportPayload, null, 2));
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
            <path class="ux-needle" d="m12 14 4-4"/>
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
        <button class="ux-icn" id="ux-btn-minimize" aria-label="Minimize" data-tooltip="Minimize (Alt+U)">
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

    <div id="ux-effort-section" style="display:none">
      <div class="ux-effort-sec-header">
        <span class="ux-bar-label">Today\u2019s effort</span>
        <span class="ux-effort-model-badge" id="ux-effort-model-badge" style="display:none"></span>
      </div>
      <div class="ux-model-pills-row" id="ux-model-pills-row" style="display:none"></div>
      <div class="ux-effort-pills">
        <span class="ux-effort-pill ux-ep-low" id="ux-ep-low" data-tooltip="Low effort messages today">Low <strong id="ux-epc-low">0</strong></span>
        <span class="ux-effort-pill ux-ep-med" id="ux-ep-med" data-tooltip="Medium effort messages today">Med <strong id="ux-epc-med">0</strong></span>
        <span class="ux-effort-pill ux-ep-high" id="ux-ep-high" data-tooltip="High effort messages today">High <strong id="ux-epc-high">0</strong></span>
        <span class="ux-effort-pill ux-ep-max" id="ux-ep-max" data-tooltip="Max effort messages today">Max <strong id="ux-epc-max">0</strong></span>
      </div>
      <div class="ux-extended-row" id="ux-extended-row" style="display:none">
        <span class="ux-extended-label">Extended Thinking</span>
        <span class="ux-extended-badge ux-ext-on" data-tooltip="Prompts with Extended Thinking ON">ON <strong id="ux-extc-on">0</strong></span>
        <span class="ux-extended-badge ux-ext-off" data-tooltip="Prompts with Extended Thinking OFF">OFF <strong id="ux-extc-off">0</strong></span>
      </div>
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

    <div class="ux-settings-content">
      <div class="ux-settings-section">
        <div class="ux-settings-section-title">Appearance & Layout</div>
        
        <div class="ux-setting-row">
          <span class="ux-setting-label">Float panel</span>
          <label class="ux-toggle">
            <input type="checkbox" id="ux-setting-float">
            <span class="ux-toggle-track"></span>
          </label>
        </div>
        
        <div class="ux-setting-row ux-setting-row-sub" id="ux-opacity-checkbox-row" style="display: none;">
          <span class="ux-setting-label">Fade when inactive</span>
          <label class="ux-toggle">
            <input type="checkbox" id="ux-setting-floating-opacity-enabled">
            <span class="ux-toggle-track"></span>
          </label>
        </div>
        
        <div class="ux-setting-row ux-setting-row-sub" id="ux-opacity-slider-row" style="display: none;">
          <span class="ux-setting-label">Opacity level</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="range" id="ux-setting-opacity-slider" min="10" max="100" step="5" class="ux-range-slider" style="width: 80px;">
            <span id="ux-opacity-val" style="font-size: 11.5px; color: var(--ux-text-2); min-width: 28px; text-align: right;">85%</span>
          </div>
        </div>
        
        <div class="ux-setting-row ux-setting-row-sub" id="ux-resize-row" style="display: none;">
          <span class="ux-setting-label">Enable resizing</span>
          <label class="ux-toggle">
            <input type="checkbox" id="ux-setting-resize">
            <span class="ux-toggle-track"></span>
          </label>
        </div>
        
        <div class="ux-setting-row" id="ux-sidebar-side-row">
          <span class="ux-setting-label">Sidebar side</span>
          <div class="ux-csel" id="ux-side-select">
            <button class="ux-csel-btn" id="ux-side-btn" type="button">
              <span id="ux-side-label">Left</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="ux-csel-dropdown" id="ux-side-dropdown">
              <div class="ux-csel-option ux-csel-active" data-value="left">Left</div>
              <div class="ux-csel-option" data-value="right">Right</div>
            </div>
          </div>
        </div>
      </div>

      <div class="ux-settings-section">
        <div class="ux-settings-section-title">Regional Settings</div>
        <div class="ux-setting-row">
          <span class="ux-setting-label">Timezone</span>
          <div class="ux-csel" id="ux-tz-select">
            <button class="ux-csel-btn" id="ux-tz-btn" type="button">
              <span id="ux-tz-label">Auto-detect</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="ux-csel-dropdown" id="ux-tz-dropdown">
              <div class="ux-csel-option ux-csel-active" data-value="auto">Auto-detect</div>
              <div class="ux-csel-group">Americas</div>
              <div class="ux-csel-option" data-value="HST">HST (UTC−10)</div>
              <div class="ux-csel-option" data-value="AKST">AKST (UTC−9)</div>
              <div class="ux-csel-option" data-value="PST">PST (UTC−8)</div>
              <div class="ux-csel-option" data-value="MST">MST (UTC−7)</div>
              <div class="ux-csel-option" data-value="CST">CST (UTC−6)</div>
              <div class="ux-csel-option" data-value="EST">EST (UTC−5)</div>
              <div class="ux-csel-option" data-value="AST">AST (UTC−4)</div>
              <div class="ux-csel-option" data-value="BRT">BRT (UTC−3)</div>
              <div class="ux-csel-group">Europe & Africa</div>
              <div class="ux-csel-option" data-value="GMT">GMT (UTC+0)</div>
              <div class="ux-csel-option" data-value="CET">CET (UTC+1)</div>
              <div class="ux-csel-option" data-value="EET">EET (UTC+2)</div>
              <div class="ux-csel-option" data-value="MSK">MSK (UTC+3)</div>
              <div class="ux-csel-group">Middle East & Asia</div>
              <div class="ux-csel-option" data-value="GST">GST (UTC+4)</div>
              <div class="ux-csel-option" data-value="PKT">PKT (UTC+5)</div>
              <div class="ux-csel-option" data-value="IST">IST (UTC+5:30)</div>
              <div class="ux-csel-option" data-value="NPT">NPT (UTC+5:45)</div>
              <div class="ux-csel-option" data-value="BST">BST (UTC+6)</div>
              <div class="ux-csel-option" data-value="ICT">ICT (UTC+7)</div>
              <div class="ux-csel-option" data-value="CST-Asia">CST (UTC+8)</div>
              <div class="ux-csel-option" data-value="SGT">SGT (UTC+8)</div>
              <div class="ux-csel-option" data-value="JST">JST (UTC+9)</div>
              <div class="ux-csel-option" data-value="KST">KST (UTC+9)</div>
              <div class="ux-csel-group">Oceania</div>
              <div class="ux-csel-option" data-value="ACST">ACST (UTC+9:30)</div>
              <div class="ux-csel-option" data-value="AEST">AEST (UTC+10)</div>
              <div class="ux-csel-option" data-value="NZST">NZST (UTC+12)</div>
            </div>
          </div>
        </div>
      </div>

      <div class="ux-settings-section ux-collapsible-section ux-section-collapsed" id="ux-section-notifications">
        <div class="ux-section-header" id="ux-notifications-header">
          <div class="ux-settings-section-title" style="margin: 0; padding-bottom: 0;">Notifications</div>
          <button class="ux-section-toggle-btn" id="ux-notifications-toggle-btn" type="button" aria-label="Toggle notifications section">
            <svg class="ux-chevron-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>
        
        <div class="ux-section-body" id="ux-notifications-body">
          <div class="ux-setting-row" style="margin-top: 8px;">
            <span class="ux-setting-label">System Notifications</span>
            <label class="ux-toggle">
              <input type="checkbox" id="ux-setting-notifications-browser">
              <span class="ux-toggle-track"></span>
            </label>
          </div>
          
          <div class="ux-setting-row">
            <span class="ux-setting-label">In-Page Toast Alerts</span>
            <label class="ux-toggle">
              <input type="checkbox" id="ux-setting-notifications-toast">
              <span class="ux-toggle-track"></span>
            </label>
          </div>

          <div class="ux-setting-row ux-setting-row-sub" id="ux-toast-position-row" style="flex-direction: column; align-items: flex-start; gap: 6px;">
            <span class="ux-setting-label">Toast Position</span>
            <div class="ux-toast-position-grid">
              <button class="ux-toast-pos-btn" data-value="top-left" data-tooltip="Top Left" type="button"></button>
              <button class="ux-toast-pos-btn" data-value="top-right" data-tooltip="Top Right" type="button"></button>
              <button class="ux-toast-pos-btn" data-value="bottom-left" data-tooltip="Bottom Left" type="button"></button>
              <button class="ux-toast-pos-btn" data-value="bottom-right" data-tooltip="Bottom Right" type="button"></button>
            </div>
          </div>

          <div class="ux-setting-row ux-setting-row-sub" id="ux-alert-limits-row">
            <span class="ux-setting-label">Alert when limits reset</span>
            <label class="ux-toggle">
              <input type="checkbox" id="ux-setting-alert-limits-reset">
              <span class="ux-toggle-track"></span>
            </label>
          </div>

          <div class="ux-setting-row ux-setting-row-sub" id="ux-alert-threshold-row">
            <span class="ux-setting-label">Alert when usage exceeds 80%</span>
            <label class="ux-toggle">
              <input type="checkbox" id="ux-setting-alert-usage-threshold">
              <span class="ux-toggle-track"></span>
            </label>
          </div>

          <div class="ux-setting-row ux-setting-row-sub" id="ux-alert-peak-row">
            <span class="ux-setting-label">Alert during Peak Hours</span>
            <label class="ux-toggle">
              <input type="checkbox" id="ux-setting-alert-peak-hours">
              <span class="ux-toggle-track"></span>
            </label>
          </div>

          <div class="ux-setting-row" style="margin-top: 6px; border-top: 1px solid var(--ux-border-subtle); padding-top: 8px;">
            <span class="ux-setting-label" style="color: var(--ux-text-3); font-size: 10.5px;">Preview a sample notification</span>
            <button class="ux-settings-btn" id="ux-btn-test-toast" type="button" style="width: auto; padding: 4px 10px; font-size: 11px; flex-shrink: 0;">
              Test Toast
            </button>
          </div>
        </div>
      </div>

      <div class="ux-settings-section">
        <div class="ux-settings-section-title">Diagnostics & Logs</div>
        <div class="ux-setting-row">
          <span class="ux-setting-label">Debug logging</span>
          <label class="ux-toggle">
            <input type="checkbox" id="ux-setting-debug">
            <span class="ux-toggle-track"></span>
          </label>
        </div>
      </div>
    </div>

    <div class="ux-settings-actions-group">
      <div class="ux-settings-btns-row">
        <button class="ux-settings-btn" id="ux-btn-export">
          <span id="ux-export-label">Export JSON</span>
          <span id="ux-export-chip" class="ux-export-chip" aria-live="polite"></span>
        </button>
        <button class="ux-settings-btn ux-btn-with-badge" id="ux-btn-debug">
          <span>Debug logs</span>
          <span class="ux-count-badge" id="ux-debug-count">0</span>
        </button>
      </div>
      <div class="ux-settings-btns-row">
        <button class="ux-settings-btn ux-btn-destructive" id="ux-btn-reset">Reset Stats</button>
        <button class="ux-settings-btn ux-btn-destructive" id="ux-btn-clear-debug">Clear Logs</button>
      </div>
    </div>

    <div class="ux-shortcut-footer">
      Press <kbd>Alt</kbd>+<kbd>U</kbd> to toggle panel
    </div>
    <div class="ux-help-footer">
      <button class="ux-help-footer-btn" id="ux-btn-open-help" type="button">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Help &amp; Guide
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>
    </div>
  </div>
  <div id="ux-resize-handle-left" class="ux-resize-edge-handle ux-resize-edge-left" style="display: none;"></div>
  <div id="ux-resize-handle-right" class="ux-resize-edge-handle ux-resize-edge-right" style="display: none;"></div>
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
  width: 250px;
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
  width: 250px;
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
#usagex-v2-root.ux-minimized #ux-effort-section { display: none; }
#usagex-v2-root.ux-minimized .ux-header { margin-bottom: 0; }
#usagex-v2-root .ux-icon-expand { display: none !important; }
#usagex-v2-root.ux-minimized .ux-icon-minimize { display: none !important; }
#usagex-v2-root.ux-minimized .ux-icon-expand  { display: block !important; }
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
.ux-settings-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}
.ux-settings-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ux-settings-section-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ux-text-3);
  margin-bottom: 4px;
  padding-bottom: 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}
.ux-setting-row-sub {
  padding-left: 14px;
}
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
  overflow: visible;
}
.ux-header:hover .ux-title-icon {
  color: var(--ux-text-2);
}
.ux-needle {
  transform-origin: 12px 14px;
  transition: transform 0.3s ease;
}
.ux-title-icon-wrap:hover .ux-needle {
  animation: ux-needle-sweep 1.2s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
}
@keyframes ux-needle-sweep {
  0%   { transform: rotate(0deg); }
  15%  { transform: rotate(-55deg); }
  30%  { transform: rotate(-95deg); }
  50%  { transform: rotate(-70deg); }
  65%  { transform: rotate(-90deg); }
  80%  { transform: rotate(-45deg); }
  100% { transform: rotate(-50deg); }
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
#usagex-v2-root [data-tooltip]:not(.ux-toast-close),
#ux-toast-container [data-tooltip]:not(.ux-toast-close) {
  position: relative;
}
#usagex-v2-root [data-tooltip]::after,
#ux-toast-container [data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  top: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%) translateY(-3px);
  background: rgba(26, 26, 26, 0.9) !important;
  backdrop-filter: blur(8px) !important;
  -webkit-backdrop-filter: blur(8px) !important;
  color: #e0e0e0 !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  line-height: 15px !important;
  display: block !important;
  box-sizing: border-box !important;
  padding: 5px 10px !important;
  border-radius: 6px !important;
  white-space: normal !important;
  width: max-content !important;
  max-width: 280px !important;
  pointer-events: none !important;
  opacity: 0;
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 2147483647;
  border: 1px solid #333 !important;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
  font-family: var(--ux-font) !important;
  letter-spacing: 0.01em !important;
  text-align: center;
}
#usagex-v2-root [data-tooltip]:hover::after,
#ux-toast-container [data-tooltip]:hover::after {
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
/* Align toast close button tooltip to the right so it doesn't overflow screen edge */
#ux-toast-container .ux-toast-close[data-tooltip]::after {
  left: auto;
  right: 0;
  transform: translateY(-3px);
}
#ux-toast-container .ux-toast-close[data-tooltip]:hover::after {
  transform: translateY(0);
}
/* Effort Pills Tooltips: Low and Med align left, High and Max align right, all above */
#usagex-v2-root #ux-ep-low[data-tooltip]::after,
#usagex-v2-root #ux-ep-med[data-tooltip]::after {
  top: auto;
  bottom: calc(100% + 7px);
  left: 0;
  transform: translateY(3px);
}
#usagex-v2-root #ux-ep-low[data-tooltip]:hover::after,
#usagex-v2-root #ux-ep-med[data-tooltip]:hover::after {
  transform: translateY(0);
}
#usagex-v2-root #ux-ep-high[data-tooltip]::after,
#usagex-v2-root #ux-ep-max[data-tooltip]::after {
  top: auto;
  bottom: calc(100% + 7px);
  left: auto;
  right: 0;
  transform: translateY(3px);
}
#usagex-v2-root #ux-ep-high[data-tooltip]:hover::after,
#usagex-v2-root #ux-ep-max[data-tooltip]:hover::after {
  transform: translateY(0);
}
#usagex-v2-root .ux-extended-badge[data-tooltip]::after {
  top: auto;
  bottom: calc(100% + 7px);
  left: auto;
  right: 0;
  transform: translateY(3px);
}
#usagex-v2-root .ux-extended-badge[data-tooltip]:hover::after {
  transform: translateY(0);
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
.ux-bar-label { font-size: 14px; color: var(--ux-text-1); font-weight: 600; white-space: nowrap; }
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
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ux-time-line {
  display: flex;
  align-items: center;
}
.ux-time-remaining {
  color: var(--ux-text-2);
  font-weight: 600;
  font-size: 12px;
}
.ux-time-reset {
  color: var(--ux-text-2);
  font-size: 11px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.ux-reset-icon {
  flex-shrink: 0;
  opacity: 0.6;
  transition: opacity 0.2s ease;
}
.ux-bar-item:hover .ux-reset-icon {
  opacity: 0.85;
}
.ux-meta {
  font-size: 10.5px;
  color: var(--ux-text-2);
  line-height: 1.35;
  margin-top: 3px;
}
#ux-session-remaining {
  display: block;
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
.ux-settings-btn:focus-visible {
  outline: 2px solid var(--ux-accent-dim);
  outline-offset: 2px;
}
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
.ux-setting-row:last-child {
  border-bottom: none;
}
.ux-setting-label { font-size: 13px; font-weight: 500; color: var(--ux-text-2); }
.ux-toast-position-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  width: 100%;
  max-width: 140px;
  margin-top: 4px;
}
.ux-toast-pos-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--ux-border-subtle);
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  transition: all 0.2s ease;
  padding: 0;
}
.ux-toast-pos-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.15);
}
.ux-toast-pos-btn.ux-active {
  background: rgba(240, 165, 0, 0.1);
  border-color: #f0a500;
}
.ux-toast-pos-btn::before {
  content: '';
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #706860;
  transition: background 0.2s;
}
.ux-toast-pos-btn.ux-active::before {
  background: #f0a500;
}
.ux-toast-pos-btn[data-value="top-left"]::before {
  top: 6px;
  left: 6px;
}
.ux-toast-pos-btn[data-value="top-right"]::before {
  top: 6px;
  right: 6px;
}
.ux-toast-pos-btn[data-value="bottom-left"]::before {
  bottom: 6px;
  left: 6px;
}
.ux-toast-pos-btn[data-value="bottom-right"]::before {
  bottom: 6px;
  right: 6px;
}
.ux-shortcut-footer {
  margin-top: 16px;
  font-size: 11px;
  color: var(--ux-text-3);
  text-align: center;
  user-select: none;
}
.ux-shortcut-footer kbd {
  background: #282828;
  border: 1px solid #3c3c3c;
  border-bottom: 2px solid #3c3c3c;
  border-radius: 4px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
  color: var(--ux-text-2);
  display: inline-block;
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.2;
  padding: 1.5px 5px;
  margin: 0 2px;
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
/* ── Custom dropdown (Claude-style) ── */
.ux-csel { position: relative; }
.ux-csel-btn {
  display: flex; align-items: center; gap: 6px;
  background: var(--ux-surface); border: 1px solid var(--ux-border);
  border-radius: 6px; color: var(--ux-text-1); font-size: 11.5px;
  padding: 4px 9px; font-family: var(--ux-font); cursor: pointer;
  font-weight: 500; transition: border-color 0.15s, background 0.15s;
}
.ux-csel-btn:hover { border-color: var(--ux-accent-dim); background: var(--ux-hover); }
.ux-csel-btn svg {
  opacity: 0.45; flex-shrink: 0;
  transition: transform 0.2s ease, opacity 0.15s;
}
.ux-csel.ux-csel-open .ux-csel-btn svg { transform: rotate(180deg); opacity: 0.7; }
.ux-csel.ux-csel-open .ux-csel-btn { border-color: var(--ux-accent-dim); background: var(--ux-hover); }
.ux-csel-dropdown {
  position: absolute; top: calc(100% + 5px); right: 0;
  min-width: 155px; max-height: 260px; overflow-y: auto;
  background: rgba(22, 22, 22, 0.97);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
  padding: 4px; opacity: 0; visibility: hidden;
  transform: translateY(-6px) scale(0.97);
  transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s;
  z-index: 200;
  box-shadow: 0 12px 32px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.3);
}
.ux-csel.ux-csel-open .ux-csel-dropdown {
  opacity: 1; visibility: visible; transform: translateY(0) scale(1);
}
.ux-csel-option {
  padding: 5px 10px; font-size: 11.5px; color: var(--ux-text-2);
  border-radius: 6px; cursor: pointer; font-weight: 400;
  transition: background 0.1s, color 0.1s; white-space: nowrap;
}
.ux-csel-option:hover {
  background: rgba(255,255,255,0.07); color: var(--ux-text-1);
}
.ux-csel-active {
  color: var(--ux-accent) !important; font-weight: 600;
  background: rgba(204,153,102,0.08);
}
.ux-csel-active:hover { background: rgba(204,153,102,0.14); }
.ux-csel-group {
  padding: 8px 10px 4px; font-size: 9.5px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--ux-text-4); pointer-events: none; user-select: none;
}
.ux-csel-group:not(:first-child) {
  margin-top: 2px; border-top: 1px solid rgba(255,255,255,0.04); padding-top: 8px;
}
.ux-csel-dropdown::-webkit-scrollbar { width: 4px; }
.ux-csel-dropdown::-webkit-scrollbar-track { background: transparent; }
.ux-csel-dropdown::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.1); border-radius: 2px;
}
.ux-csel-dropdown::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
/* ── Debug badge ── */
.ux-btn-with-badge {
  display: inline-flex !important; align-items: center; justify-content: center; gap: 6px;
}
.ux-count-badge {
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.07); border-radius: 10px;
  font-size: 10px; font-weight: 600; padding: 1px 7px;
  min-width: 20px; color: var(--ux-text-3); line-height: 1.4;
  border: 1px solid rgba(255,255,255,0.05);
}
.ux-settings-actions-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  border-top: 1px solid var(--ux-border-subtle);
  padding-top: 12px;
}
.ux-settings-btns-row {
  display: flex;
  gap: 6px;
}
.ux-settings-btns-row .ux-settings-btn {
  flex: 1;
  width: auto;
}
.ux-settings-btn {
  width: 100%; padding: 7px 0; background: rgba(255, 255, 255, 0.05);
  border: none; border-radius: var(--ux-radius);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08), 0 1px 2px rgba(0, 0, 0, 0.15);
  font-size: 11.5px; color: var(--ux-text-2); cursor: pointer;
  font-family: var(--ux-font); font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;
  white-space: nowrap;
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
  white-space: nowrap;
}
#usagex-v2-root .ux-peak-track[data-tooltip]::after {
  top: auto;
  bottom: calc(100% + 7px);
  transform: translateX(-50%) translateY(3px);
  max-width: 280px !important;
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
.ux-resize-edge-handle {
  position: absolute;
  top: 0;
  width: 8px;
  height: 100%;
  cursor: ew-resize;
  z-index: 2147483647;
  background: transparent;
}
.ux-resize-edge-left {
  left: -4px;
}
.ux-resize-edge-right {
  right: -4px;
}
.ux-resize-edge-handle::after {
  content: "";
  position: absolute;
  top: 15%;
  bottom: 15%;
  width: 2px;
  background: var(--ux-accent);
  opacity: 0;
  transition: opacity 0.15s;
}
.ux-resize-edge-left::after {
  left: 3px;
}
.ux-resize-edge-right::after {
  right: 3px;
}
.ux-resize-edge-handle:hover::after,
.ux-resize-edge-handle.ux-resizing-active::after {
  opacity: 0.6;
}

/* Collapsible Settings Sections */
.ux-collapsible-section .ux-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.ux-collapsible-section .ux-section-header:hover .ux-settings-section-title {
  color: var(--ux-text-1);
}
.ux-collapsible-section .ux-section-toggle-btn {
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--ux-text-3);
  transition: color 0.15s;
}
.ux-collapsible-section .ux-section-toggle-btn:hover {
  color: var(--ux-text-1);
}
.ux-collapsible-section .ux-chevron-icon {
  transform: rotate(0deg);
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  color: inherit;
}
.ux-collapsible-section.ux-section-collapsed .ux-chevron-icon {
  transform: rotate(-90deg);
}
.ux-collapsible-section .ux-section-body {
  max-height: 500px;
  opacity: 1;
  overflow: visible;
  transition: max-height 0.25s ease-out, opacity 0.2s ease-in, margin-top 0.25s;
}
.ux-collapsible-section.ux-section-collapsed .ux-section-body {
  max-height: 0 !important;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  margin-top: 0 !important;
}

/* ── Toast Notifications — UsageX sidebar-matched, icon-only signal ── */
#ux-toast-container {
  position: fixed;
  bottom: 28px;
  right: 24px;
  top: auto;
  left: auto;
  z-index: 2147483647;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  pointer-events: none;
  font-family: inherit;
  max-width: 310px;
  width: 310px;
}
#ux-toast-container.ux-toast-pos-top-right {
  top: 28px;
  right: 24px;
  bottom: auto;
  left: auto;
  flex-direction: column;
}
#ux-toast-container.ux-toast-pos-bottom-right {
  bottom: 28px;
  right: 24px;
  top: auto;
  left: auto;
  flex-direction: column-reverse;
}
#ux-toast-container.ux-toast-pos-top-left {
  top: 28px;
  left: 24px;
  bottom: auto;
  right: auto;
  flex-direction: column;
}
#ux-toast-container.ux-toast-pos-bottom-left {
  bottom: 28px;
  left: 24px;
  top: auto;
  right: auto;
  flex-direction: column-reverse;
}

.ux-toast {
  pointer-events: auto;
  position: relative;
  width: 100%;
  border-radius: 9px;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 12px 13px 15px 13px;
  box-sizing: border-box;
  background: #1a1916;
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 6px 20px rgba(0,0,0,0.4);
  animation: ux-toast-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}

html.light .ux-toast,
body.light .ux-toast {
  background: #faf9f5;
  border: 0.5px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.04), 0 6px 20px rgba(0,0,0,0.08);
}

@media (prefers-color-scheme: light) {
  html:not(.dark) .ux-toast,
  body:not(.dark) .ux-toast {
    background: #faf9f5;
    border: 0.5px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.04), 0 6px 20px rgba(0,0,0,0.08);
  }
}

/* Icon-only color signal — no stripe pseudo-element */

.ux-toast-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ux-toast-acc);
}

.ux-toast-icon svg {
  width: 16px;
  height: 16px;
  display: block;
}

.ux-toast-body {
  flex: 1;
  min-width: 0;
  padding-right: 16px;
}

.ux-toast-title {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: #e8e2d9;
  margin: 0 0 2px 0;
}

.ux-toast-sub {
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  color: #706860;
  margin: 0;
}

html.light .ux-toast-title,
body.light .ux-toast-title {
  color: #141413;
}

html.light .ux-toast-sub,
body.light .ux-toast-sub {
  color: #6c6a64;
}

@media (prefers-color-scheme: light) {
  html:not(.dark) .ux-toast-title,
  body:not(.dark) .ux-toast-title { color: #141413; }
  html:not(.dark) .ux-toast-sub,
  body:not(.dark) .ux-toast-sub   { color: #6c6a64; }
}

.ux-toast-close {
  position: absolute;
  top: 9px;
  right: 9px;
  background: none;
  border: none;
  padding: 3px;
  cursor: pointer;
  color: #4a4845;
  line-height: 1;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ux-toast:hover .ux-toast-close { opacity: 1; }
.ux-toast-close:hover { color: #c8c2b8; }
html.light .ux-toast-close:hover,
body.light .ux-toast-close:hover { color: #141413; }

.ux-toast-timer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 0 0 9px 9px;
  overflow: hidden;
}

.ux-toast-timer-fill {
  height: 100%;
  width: 100%;
  background: var(--ux-toast-acc);
  opacity: 0.4;
  transform-origin: left;
  animation: ux-toast-countdown 5s linear forwards;
}

/* Type accent tokens — vivid, sidebar-matched */
.ux-toast-yellow { --ux-toast-acc: #f0a500; }
.ux-toast-red    { --ux-toast-acc: #f05a5a; }
.ux-toast-green  { --ux-toast-acc: #4ade80; }
.ux-toast-info   { --ux-toast-acc: #60a5fa; }

/* Animations — right → left entry, left → right exit */
@keyframes ux-toast-in {
  from { opacity: 0; transform: translateX(48px); }
  to   { opacity: 1; transform: translateX(0);    }
}

@keyframes ux-toast-countdown {
  from { transform: scaleX(1); }
  to   { transform: scaleX(0); }
}

.ux-toast.ux-toast-exit {
  animation: ux-toast-out 0.28s cubic-bezier(0.4, 0, 1, 1) forwards;
  pointer-events: none;
}

@keyframes ux-toast-out {
  from { opacity: 1; transform: translateX(0);     max-height: 120px; margin-bottom: 0; }
  to   { opacity: 0; transform: translateX(48px);  max-height: 0;     margin-bottom: -8px; padding-top: 0; padding-bottom: 0; }
}

#ux-toast-container.ux-toast-pos-top-left .ux-toast,
#ux-toast-container.ux-toast-pos-bottom-left .ux-toast {
  animation-name: ux-toast-in-left;
}
#ux-toast-container.ux-toast-pos-top-left .ux-toast.ux-toast-exit,
#ux-toast-container.ux-toast-pos-bottom-left .ux-toast.ux-toast-exit {
  animation-name: ux-toast-out-left;
}

@keyframes ux-toast-in-left {
  from { opacity: 0; transform: translateX(-48px); }
  to   { opacity: 1; transform: translateX(0);    }
}
@keyframes ux-toast-out-left {
  from { opacity: 1; transform: translateX(0);     max-height: 120px; margin-bottom: 0; }
  to   { opacity: 0; transform: translateX(-48px); max-height: 0;     margin-bottom: -8px; padding-top: 0; padding-bottom: 0; }
}

/* ─── Help footer ─────────────────────────────────────────── */
.ux-help-footer {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--ux-border-subtle);
  margin-top: 2px;
}
.ux-help-footer-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  background: rgba(204,153,102,0.08);
  border: 1px solid rgba(204,153,102,0.2);
  border-radius: var(--ux-radius);
  color: var(--ux-accent);
  font-size: 11.5px;
  font-weight: 600;
  font-family: var(--ux-font);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.ux-help-footer-btn:hover {
  background: rgba(204,153,102,0.16);
  border-color: rgba(204,153,102,0.38);
}

/* ─── Effort Pills ─────────────────────────────────────── */
#ux-effort-section {
  padding: 6px 10px 8px;
  border-top: 1px solid var(--ux-border-subtle);
}
.ux-effort-sec-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
}
.ux-effort-pills {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ux-effort-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 10px;
  line-height: 1.6;
  cursor: default;
  transition: opacity 0.15s, transform 0.1s;
}
.ux-effort-pill:hover { opacity: 0.85; transform: scale(1.04); }
.ux-effort-pill strong { font-size: 10.5px; font-weight: 700; }
.ux-ep-low  { background: rgba(100,116,139,0.2);  color: #94a3b8; border: 1px solid rgba(100,116,139,0.3);  }
.ux-ep-med  { background: rgba(74,222,128,0.1);   color: #4ade80; border: 1px solid rgba(74,222,128,0.22);  }
.ux-ep-high { background: rgba(204,153,102,0.12); color: #cc9966; border: 1px solid rgba(204,153,102,0.25); }
.ux-ep-max  { background: rgba(239,68,68,0.1);    color: #f87171; border: 1px solid rgba(239,68,68,0.22);  }
/* ─── Model Pills ───────────────────────────────────────────── */
.ux-model-pills-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 7px;
}
.ux-model-pill {
  display: inline-flex;
  align-items: center;
  font-size: 9px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid transparent;
}
.ux-model-pill-sonnet {
  background: rgba(204, 153, 102, 0.13);
  color: #cc9966;
  border-color: rgba(204, 153, 102, 0.28);
}
.ux-model-pill-opus {
  background: rgba(167, 139, 250, 0.13);
  color: #a78bfa;
  border-color: rgba(167, 139, 250, 0.28);
}
.ux-model-pill-haiku {
  background: rgba(52, 211, 153, 0.12);
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.25);
}
.ux-model-pill-other {
  background: rgba(148, 163, 184, 0.1);
  color: #94a3b8;
  border-color: rgba(148, 163, 184, 0.2);
}

.ux-effort-model-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 9px;
  background: rgba(204,153,102,0.1);
  color: rgba(204,153,102,0.8);
  border: 1px solid rgba(204,153,102,0.2);
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.ux-extended-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--ux-border-subtle);
}
.ux-extended-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--ux-text-3);
  margin-right: auto;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.ux-extended-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 9.5px;
  font-weight: 500;
  padding: 1.5px 5px;
  border-radius: 4px;
  border: 1px solid transparent;
}
.ux-extended-badge strong {
  font-weight: 700;
}
.ux-ext-on {
  background: rgba(16, 185, 129, 0.1);
  color: var(--ux-green-bright);
  border-color: rgba(16, 185, 129, 0.2);
}
.ux-ext-off {
  background: rgba(100, 116, 139, 0.1);
  color: var(--ux-text-3);
  border-color: rgba(100, 116, 139, 0.2);
}
  `;
}

// ─── Active Usage limits fetching ──────────────────────────────────────────────

async function fetchUsageLimitsActive() {
  try {
    let orgId = document.cookie.split('; ').find(row => row.startsWith('lastActiveOrg='))?.split('=')[1] || null;
    let orgName = null;

    if (!orgId) {
      const orgsRes = await fetch(window.location.origin + '/api/organizations');
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
      orgName = orgs[0].name || null;
    }

    if (!orgId) {
      await debugLog('active_fetch_failed', { reason: 'no_orgId' });
      return;
    }

    // Use the org UUID as the account identifier — proven to work, unlike /api/me (404)
    await handleUserInfo(orgId);

    // Fetch /api/account to get the real user name + email.
    // Claude's API uses /api/account (not /api/me which returns 404).
    // Field names confirmed from Claude's response: email_address, full_name, display_name, uuid.
    try {
      const accountRes = await fetch(window.location.origin + '/api/account');
      if (accountRes.ok) {
        const accountJson = await accountRes.json();
        if (accountJson) {
          // /api/account returns the user object directly
          const userName = accountJson.full_name || accountJson.display_name || accountJson.name || '';
          const userEmail = accountJson.email_address || accountJson.email || '';
          
          let userPlan = '';
          const memberships = Array.isArray(accountJson.memberships) ? accountJson.memberships : [];
          const activeMember = memberships.find(m => {
            const caps = m?.organization?.capabilities || [];
            return caps.includes("chat") || caps.includes("claude_pro") || caps.includes("claude_max");
          }) || memberships.find(m => !(m?.organization?.capabilities || []).includes("api")) || memberships[0];
          
          if (activeMember?.organization) {
            const tier = String(activeMember.organization.rate_limit_tier || '').toLowerCase();
            const caps = activeMember.organization.capabilities || [];
            if (tier.includes('max_20x')) userPlan = 'Max x20';
            else if (tier.includes('max_5x') || tier.includes('max5')) userPlan = 'Max x5';
            else if (tier.includes('pro')) userPlan = 'Pro';
            else if (tier.includes('free')) userPlan = 'Free';
            else if (caps.includes('claude_max')) userPlan = 'Max';
            else if (caps.includes('claude_pro')) userPlan = 'Pro';
          }

          if (userEmail || userName || userPlan) {
            const res = await browser.storage.local.get(['user_email', 'user_name', 'user_plan']);
            const updates = {};
            if (userEmail && res.user_email !== userEmail) updates.user_email = userEmail;
            if (userName && res.user_name !== userName) updates.user_name = userName;
            if (userPlan && res.user_plan !== userPlan) updates.user_plan = userPlan;
            if (orgId) {
              if (userEmail) updates[`user_email_${orgId}`] = userEmail;
              if (userName) updates[`user_name_${orgId}`] = userName;
              if (userPlan) updates[`user_plan_${orgId}`] = userPlan;
            }
            if (Object.keys(updates).length > 0) {
              await browser.storage.local.set(updates);
            }
          }
        }
      }
    } catch (_) { /* /api/account is optional — don't fail the main flow */ }

    const usageRes = await fetch(window.location.origin + `/api/organizations/${orgId}/usage`);
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

  // fetchUsageLimitsActive handles both account detection and usage limits
  await fetchUsageLimitsActive().catch(() => { });

  // Ask inject.js to replay cached user info (if /api/me was already intercepted)
  // or fall back to DOM scraping. Small delay lets the inject script fully load first.
  setTimeout(() => {
    window.postMessage({ type: '__ux_request_user_info' }, '*');
  }, 800);

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
