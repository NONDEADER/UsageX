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

function defaultSettings() { return { debug_logging: false, sidebar_side: 'left', timezone: 'auto', floating: false, float_x: null, float_y: null, floating_opacity_enabled: true, floating_opacity: 0.85 }; }

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

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'usagex-midnight') {
    handleMidnightReset();
  }
});
