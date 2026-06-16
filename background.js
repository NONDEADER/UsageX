'use strict';

if (typeof browser === "undefined") {
  var browser = chrome;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function freshToday() {
  return {
    date:    todayStr(),
    msgs:    0,
    convos:  0,
    time_s:  0,
    tokens_est: 0,
    effort_breakdown: { low: 0, medium: 0, high: 0, max: 0 },
    processed_msg_uuids: [],
    recent_sent_prompts: [],
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
    notifications_browser: false,
    notifications_toast: true,
    alert_limits_reset: true,
    alert_usage_threshold: true,
    alert_peak_hours: true,
    toast_position: 'bottom-right'
  };
}

function scheduleMidnightAlarm() {
  const now       = new Date();
  const midnight  = new Date(now);
  midnight.setHours(24, 0, 10, 0);
  const delayMs   = midnight.getTime() - now.getTime();
  const delayMins = delayMs / 60_000;
  browser.alarms.create('usagex-midnight', { delayInMinutes: delayMins });
}

async function handleMidnightReset() {
  const res = await browser.storage.local.get(['today', 'history', 'settings']);
  const today   = res.today   || freshToday();
  const history = res.history || [];

  if (today.date && today.date !== todayStr()) {
    history.push(today);
    if (history.length > 30) history.splice(0, history.length - 30);
  }

  const newToday = freshToday();

  await browser.storage.local.set({
    today:   newToday,
    history: history,
  });

  scheduleMidnightAlarm();
}

browser.runtime.onInstalled.addListener(async () => {
  const res = await browser.storage.local.get(['today', 'settings']);
  if (!res.today)    await browser.storage.local.set({ today:    freshToday() });
  if (!res.settings) await browser.storage.local.set({ settings: defaultSettings() });
  scheduleMidnightAlarm();
});

browser.runtime.onStartup.addListener(() => {
  scheduleMidnightAlarm();
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'usagex-midnight') {
    handleMidnightReset();
    return;
  }

  const res = await browser.storage.local.get(['settings', 'usage_limits']);
  const settings = res.settings || defaultSettings();

  if (settings.notifications_browser !== true) return;
  if (settings.alert_limits_reset === false) return;

  try {
    const hasPerm = await browser.permissions.contains({ permissions: ['notifications'] });
    if (!hasPerm) return;
  } catch (_) {
    return;
  }

  let title = '';
  let message = '';

  if (alarm.name === 'session-reset') {
    title = 'Claude Session Limit Reset';
    message = 'Your 5-hour Claude session limit has reset! You have a fresh quota.';
  } else if (alarm.name === 'session-reset-approaching') {
    title = 'Claude Session Reset Approaching';
    message = 'Your Claude session limit will reset in 15 minutes.';
  } else if (alarm.name === 'weekly-reset') {
    title = 'Claude Weekly Limit Reset';
    message = 'Your weekly Claude token quota has been fully restored.';
  } else if (alarm.name === 'weekly-reset-approaching') {
    title = 'Claude Weekly Reset Approaching';
    message = 'Your weekly Claude limit will reset in 15 minutes.';
  }

  if (title && message) {
    browser.notifications.create(alarm.name, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon48.png'),
      title: title,
      message: message,
      priority: 2
    });
  }
});

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  // 1. Clean up alarms if browser notifications are disabled
  if (changes.settings) {
    const oldSettings = changes.settings.oldValue || {};
    const newSettings = changes.settings.newValue || {};
    if (oldSettings.notifications_browser === true && newSettings.notifications_browser === false) {
      browser.alarms.clear('session-reset');
      browser.alarms.clear('session-reset-approaching');
      browser.alarms.clear('weekly-reset');
      browser.alarms.clear('weekly-reset-approaching');
    }
  }

  // 2. Schedule alarms on limit changes
  if (changes.usage_limits) {
    const limits = changes.usage_limits.newValue;
    if (!limits) return;

    const res = await browser.storage.local.get('settings');
    const settings = res.settings || defaultSettings();

    if (settings.notifications_browser !== true) return;

    const now = Date.now();

    // Session Reset alarms
    if (limits.session_resets_at) {
      const resetTime = new Date(limits.session_resets_at).getTime();
      if (Number.isFinite(resetTime) && resetTime > now) {
        browser.alarms.create('session-reset', { when: resetTime });

        const approachingTime = resetTime - 15 * 60 * 1000;
        if (approachingTime > now) {
          browser.alarms.create('session-reset-approaching', { when: approachingTime });
        } else {
          browser.alarms.clear('session-reset-approaching');
        }
      }
    }

    // Weekly Reset alarms
    if (limits.weekly_resets_at) {
      const resetTime = new Date(limits.weekly_resets_at).getTime();
      if (Number.isFinite(resetTime) && resetTime > now) {
        browser.alarms.create('weekly-reset', { when: resetTime });

        const approachingTime = resetTime - 15 * 60 * 1000;
        if (approachingTime > now) {
          browser.alarms.create('weekly-reset-approaching', { when: approachingTime });
        } else {
          browser.alarms.clear('weekly-reset-approaching');
        }
      }
    }
  }
});

// ─── Open popup from sidebar Help button ──────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'OPEN_HELP_POPUP') {
    const actionApi = typeof browser !== 'undefined' && browser.action ? browser.action : (typeof chrome !== 'undefined' ? chrome.action : null);
    
    if (actionApi && typeof actionApi.openPopup === 'function') {
      const windowId = sender.tab ? sender.tab.windowId : undefined;
      const openPromise = windowId !== undefined ? actionApi.openPopup({ windowId }) : actionApi.openPopup();
      
      if (openPromise && typeof openPromise.then === 'function') {
        openPromise
          .then(() => {
            sendResponse({ success: true });
          })
          .catch((err) => {
            console.error('[UsageX] openPopup failed:', err);
            sendResponse({ success: false, error: err.message || String(err) });
          });
      } else {
        try {
          actionApi.openPopup({ windowId }, () => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              console.error('[UsageX] openPopup lastError:', lastError);
              sendResponse({ success: false, error: lastError.message });
            } else {
              sendResponse({ success: true });
            }
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message || String(err) });
        }
      }
      return true; // Keep message channel open for async response
    } else {
      sendResponse({ success: false, error: 'action.openPopup not supported on this browser version' });
    }
  }
});
