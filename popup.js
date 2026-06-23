'use strict';

if (typeof browser === 'undefined') var browser = chrome;

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  if (!modelId) return 'px-model-pill-other';
  const id = modelId.toLowerCase();
  if (id.includes('sonnet')) return 'px-model-pill-sonnet';
  if (id.includes('opus')) return 'px-model-pill-opus';
  if (id.includes('haiku')) return 'px-model-pill-haiku';
  return 'px-model-pill-other';
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
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istMs = utcMs + 5.5 * 3600000;
  const ist = new Date(istMs);
  const curH = ist.getHours() + ist.getMinutes() / 60;
  const day = ist.getDay(); // 0 = Sun
  const isWeekend = day === 0 || day === 6;
  const inPeak = !isWeekend && (curH >= 18.5 || curH < 0.5);
  return { inPeak, isWeekend };
}

function formatResetDisplay(timestamp) {
  if (!timestamp) return '';
  const diff = new Date(timestamp).getTime() - Date.now();
  if (diff <= 0) return 'Resetting now…';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h remaining`;
  if (h === 0) return `${m}m remaining`;
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
  if (rate > 21) return 'up';
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
  const tabs = document.querySelectorAll('.px-tab');
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
  // today is live — shared via chrome.storage.local between content.js and popup.js
  const res = await browser.storage.local.get(['today', 'usage_limits', 'debug_logs', 'settings', 'user_name', 'user_email', 'user_plan']);
  const settings = res.settings || {};
  const ianaTz = (() => {
    try {
      if (!settings.timezone || settings.timezone === 'auto') return Intl.DateTimeFormat().resolvedOptions().timeZone;
      const TZ_MAP = { 'HST':'Pacific/Honolulu','AKST':'America/Anchorage','PST':'America/Los_Angeles','MST':'America/Denver','CST':'America/Chicago','EST':'America/New_York','AST':'America/Halifax','BRT':'America/Sao_Paulo','GMT':'Etc/GMT','CET':'Europe/Paris','EET':'Europe/Athens','MSK':'Europe/Moscow','GST':'Asia/Dubai','PKT':'Asia/Karachi','IST':'Asia/Kolkata','NPT':'Asia/Kathmandu','BST':'Asia/Dhaka','ICT':'Asia/Bangkok','CST-Asia':'Asia/Shanghai','SGT':'Asia/Singapore','JST':'Asia/Tokyo','KST':'Asia/Seoul','ACST':'Australia/Darwin','AEST':'Australia/Sydney','NZST':'Pacific/Auckland' };
      return TZ_MAP[settings.timezone] || Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch(e) { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  })();
  const todayDate = todayStr(ianaTz);
  const today = res.today || freshToday(ianaTz);
  const limits = res.usage_limits || {};

  // ── Account Card ──
  const userName = res.user_name || '';
  const userEmail = res.user_email || '';
  const userPlan = res.user_plan || '';
  const accountCard = el('px-account-card');
  const accountAvatar = el('px-account-avatar');
  const accountName = el('px-account-name');
  const accountEmail = el('px-account-email');
  const accountPlan = el('px-account-plan');
  if (accountCard) {
    if (userName || userEmail) {
      accountCard.style.display = 'flex';
      const initial = (userName || userEmail).trim()[0] || '?';
      if (accountAvatar) accountAvatar.textContent = initial.toUpperCase();
      if (accountName) accountName.textContent = userName || '—';
      if (accountEmail) accountEmail.textContent = userEmail || '—';
      if (accountPlan) {
        if (userPlan) {
          accountPlan.textContent = userPlan;
          accountPlan.className = 'px-plan-pill';
          const pLower = userPlan.toLowerCase();
          if (pLower.includes('pro')) {
            accountPlan.classList.add('px-plan-pill-pro');
          } else if (pLower.includes('max')) {
            accountPlan.classList.add('px-plan-pill-max');
          } else {
            accountPlan.classList.add('px-plan-pill-free');
          }
          accountPlan.style.display = 'inline-flex';
        } else {
          accountPlan.style.display = 'none';
        }
      }
    } else {
      accountCard.style.display = 'none';
    }
  }

  // history is archived — stored in IndexedDB (extension origin, accessible by popup)
  const allHistory = await UsageXDB.getAllDailyStats();
  const pastDays = allHistory.filter(d => d.date !== todayDate);

  // ── Status banner + live dot ──
  const { inPeak, isWeekend } = getPeakStatus();

  let onClaude = false;
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && tabs[0].url) {
      if (tabs[0].url.includes('claude.ai')) onClaude = true;
    }
  } catch (_) { }

  const bannerEl = el('px-status-banner');
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

  // ── Feature 7: Peak hours hint ──
  const peakHint = el('px-peak-hint');
  if (peakHint) {
    if (isWeekend) {
      peakHint.style.display = 'none';
    } else if (inPeak) {
      peakHint.style.display = '';
      peakHint.className = 'px-peak-hint px-peak-warn';
      peakHint.innerHTML =
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '<span>Peak hours active — limits deplete faster until 12:30 AM IST</span>';
    } else {
      peakHint.style.display = '';
      peakHint.className = 'px-peak-hint px-peak-ok';
      peakHint.innerHTML =
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        '<span>Off-peak — great time for heavy prompts</span>';
    }
  }

  // ── Usage bars ──
  const sessionPct = limits.session_pct;
  const weeklyPct = limits.weekly_pct;

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
      up: 'Above normal >21%/h',
      neutral: 'On track ~20%/h',
      down: 'Below normal <19%/h — good!',
      gray: 'Calculating…',
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

  // ── Feature 9: Pinned mini-stats strip ──
  const qsSession = el('px-qs-session');
  const qsWeekly = el('px-qs-weekly');
  const qsMsgs = el('px-qs-msgs');
  if (qsSession) {
    qsSession.textContent = fmtPct(sessionPct);
    qsSession.style.color = getThresholdColor(sessionPct) || 'var(--px-text-2)';
  }
  if (qsWeekly) {
    qsWeekly.textContent = fmtPct(weeklyPct);
    qsWeekly.style.color = getThresholdColor(weeklyPct) || 'var(--px-text-2)';
  }
  if (qsMsgs) {
    qsMsgs.textContent = today.msgs != null ? String(today.msgs) : '0';
  }

  // ── Features 5 & 6: Today section — effort breakdown + daily meta ──
  const eb = today.effort_breakdown || { low: 0, medium: 0, high: 0, max: 0 };
  const ebTotal = (eb.low || 0) + (eb.medium || 0) + (eb.high || 0) + (eb.max || 0);
  const maxCount = Math.max(eb.low || 0, eb.medium || 0, eb.high || 0, eb.max || 0, 1);

  const effortPairs = [
    ['low', 'px-ef-low', 'px-ec-low'],
    ['medium', 'px-ef-med', 'px-ec-med'],
    ['high', 'px-ef-high', 'px-ec-high'],
    ['max', 'px-ef-max', 'px-ec-max'],
  ];
  for (const [key, fillId, countId] of effortPairs) {
    const cnt = eb[key] || 0;
    const fill = el(fillId);
    const count = el(countId);
    if (fill) fill.style.width = Math.round((cnt / maxCount) * 100) + '%';
    if (count) count.textContent = String(cnt);
  }

  // Model Pills Row (all models used today) & Context note
  const lastModel = today.last_model || null;
  const supportsEffortLevel = modelSupportsEffortLevel(lastModel);
  const supportsExtended = modelSupportsExtendedToggle(lastModel);
  const modelPillsRow = el('px-today-model-pills');
  const effortContext = el('px-effort-context');
  const effortContextText = el('px-effort-context-text');
  const effortList = el('px-effort-list');

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
          return `<span class="px-model-pill ${cls}">${name}</span>`;
        })
        .filter(Boolean)
        .join('');
      modelPillsRow.style.display = 'flex';
    } else {
      modelPillsRow.style.display = 'none';
    }
  }

  if (effortList) {
    effortList.style.display = supportsEffortLevel ? '' : 'none';
  }

  if (effortContext && effortContextText) {
    if (lastModel && !supportsEffortLevel) {
      effortContextText.textContent = "Effort levels not applicable for this model";
      effortContextText.style.fontStyle = "italic";
      effortContext.style.display = '';
    } else if (lastModel && supportsEffortLevel) {
      effortContextText.textContent = "Effort breakdown reflects thinking tokens used";
      effortContextText.style.fontStyle = "normal";
      effortContext.style.display = '';
    } else {
      effortContext.style.display = 'none';
    }
  }

  const extendedRow = el('px-extended-row');
  if (extendedRow) {
    if (lastModel && supportsExtended) {
      extendedRow.style.display = '';
      const et = today.extended_thinking || { on: 0, off: 0 };
      const etOn = el('px-extc-on');
      const etOff = el('px-extc-off');
      if (etOn) etOn.textContent = String(et.on || 0);
      if (etOff) etOff.textContent = String(et.off || 0);
    } else {
      extendedRow.style.display = 'none';
    }
  }

  // Feature 6: stat cards
  const msgs = today.msgs || 0;
  const tokensEst = today.tokens_est || 0;
  const avgTok = msgs > 0 ? Math.round(tokensEst / msgs) : null;
  const timeStr = formatDuration(today.time_s);

  const statMsgs = el('px-stat-msgs');
  const statTime = el('px-stat-time');
  const statTokens = el('px-stat-tokens');
  const statAvg = el('px-stat-avg');

  if (statMsgs) statMsgs.textContent = String(msgs);
  if (statTime) statTime.textContent = timeStr || '0m';
  if (statTokens) statTokens.textContent = `~${formatTokens(tokensEst)}`;
  if (statAvg) statAvg.textContent = avgTok !== null ? `~${formatTokens(avgTok)}` : '—';

  // Hide Today section only when there are zero messages AND no limits data yet
  const todaySec = el('px-today-section');
  if (todaySec) {
    todaySec.style.display = (msgs === 0 && ebTotal === 0) ? 'none' : '';
  }

  // ── Feature 1: Sparkline ──
  renderSparkline(pastDays, today);

  // ── Feature 10: sync threshold sliders from settings ──
  const sessSlider = el('px-thresh-session');
  const weekSlider = el('px-thresh-weekly');
  const sessVal = el('px-thresh-session-val');
  const weekVal = el('px-thresh-weekly-val');
  if (sessSlider && settings.alert_session_threshold != null) {
    sessSlider.value = settings.alert_session_threshold;
    if (sessVal) sessVal.textContent = settings.alert_session_threshold + '%';
  }
  if (weekSlider && settings.alert_weekly_threshold != null) {
    weekSlider.value = settings.alert_weekly_threshold;
    if (weekVal) weekVal.textContent = settings.alert_weekly_threshold + '%';
  }
}

// ─── Sparkline (Feature 1) ───────────────────────────────────────────────────

function renderSparkline(history, today) {
  const chartEl = el('px-chart');
  const labelsEl = el('px-chart-labels');
  const section = el('px-chart-section');
  if (!chartEl) return;

  // Build last 7 data points: history days + today
  const allDays = [...history.slice(-6), today].filter(Boolean);
  if (allDays.length < 1) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';

  const vals = allDays.map(d => d.tokens_est || 0);
  const maxV = Math.max(...vals, 1);
  const W = 220, H = 60, padX = 8, padY = 8;
  const n = vals.length;

  const pts = vals.map((v, i) => {
    const x = n > 1 ? padX + (i / (n - 1)) * (W - padX * 2) : W / 2;
    const y = H - padY - ((v / maxV) * (H - padY * 2));
    return [x, y];
  });

  const maxY = padY;
  const minY = H - padY;

  // Calculate 7-day average for scale line
  const totalTokens = vals.reduce((a, b) => a + b, 0);
  const avgTokens = Math.round(totalTokens / n);
  const avgY = H - padY - ((avgTokens / maxV) * (H - padY * 2));

  // Build smooth cubic bezier path
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C ${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }

  // Area fill path
  const areaD = d + ` L ${pts[pts.length - 1][0]},${H} L ${pts[0][0]},${H} Z`;

  chartEl.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" style="overflow: visible;">
      <defs>
        <linearGradient id="px-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#cc9966" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#cc9966" stop-opacity="0"/>
        </linearGradient>
      </defs>
      
      <!-- Grid boundaries -->
      <line x1="${padX}" y1="${maxY}" x2="${W - padX}" y2="${maxY}" stroke="rgba(255, 255, 255, 0.05)" stroke-width="0.8" />
      <line x1="${padX}" y1="${minY}" x2="${W - padX}" y2="${minY}" stroke="rgba(255, 255, 255, 0.05)" stroke-width="0.8" />
      
      <!-- Scale labels -->
      <text x="${padX}" y="${maxY + 7}" fill="var(--px-text-3)" font-size="7" font-weight="600" opacity="0.6">Max: ~${formatTokens(maxV)}</text>
      <text x="${padX}" y="${minY - 2}" fill="var(--px-text-3)" font-size="7" font-weight="600" opacity="0.6">0</text>
      
      <!-- Average reference line -->
      <line x1="${padX}" y1="${avgY}" x2="${W - padX}" y2="${avgY}" stroke="rgba(204, 153, 102, 0.2)" stroke-width="0.8" stroke-dasharray="3,3" />
      <text x="${W - padX - 4}" y="${avgY - 3}" fill="rgba(204, 153, 102, 0.5)" font-size="7" font-weight="600" text-anchor="end">Avg: ~${formatTokens(avgTokens)}</text>
      
      <!-- Hover guide line -->
      <line class="px-spark-hover-line" x1="-10" y1="${maxY}" x2="-10" y2="${minY}" stroke="rgba(204, 153, 102, 0.4)" stroke-width="1" stroke-dasharray="2,2" style="display: none;" />
      
      <!-- Chart area and path -->
      <path d="${areaD}" fill="url(#px-spark-grad)"/>
      <path d="${d}" fill="none" stroke="#cc9966" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      
      <!-- Spark points -->
      ${pts.map(([x, y], i) => `
        <circle class="px-spark-point" cx="${x}" cy="${y}" r="3" fill="#cc9966" data-index="${i}">
          <title>${allDays[i].date || ''}: ~${formatTokens(vals[i])} tokens</title>
        </circle>
      `).join('')}
    </svg>`;

  // Day labels: Mon/Tue/…
  if (labelsEl) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    labelsEl.innerHTML = allDays.map(d => {
      if (!d.date) return '<span></span>';
      const day = new Date(d.date + 'T12:00:00').getDay();
      return `<span>${days[day]}</span>`;
    }).join('');
    if (n === 1) {
      labelsEl.style.justifyContent = 'center';
    } else {
      labelsEl.style.justifyContent = 'space-between';
    }
  }

  // Interactive hover label
  const hoverValEl = el('px-chart-hover-val');
  if (hoverValEl) {
    hoverValEl.textContent = `Avg: ~${formatTokens(avgTokens)}`;
  }

  const svgEl = chartEl.querySelector('svg');
  if (svgEl && hoverValEl) {
    const circles = svgEl.querySelectorAll('circle.px-spark-point');
    const hoverLine = svgEl.querySelector('.px-spark-hover-line');

    const handleHover = (clientX) => {
      const rect = svgEl.getBoundingClientRect();
      const mouseX = ((clientX - rect.left) / rect.width) * W;

      // Find closest point by X coordinate
      let minDiff = Infinity;
      let closestIdx = 0;
      pts.forEach(([px, py], i) => {
        const diff = Math.abs(px - mouseX);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      });

      // Update vertical hover line position
      if (hoverLine) {
        hoverLine.setAttribute('x1', pts[closestIdx][0]);
        hoverLine.setAttribute('x2', pts[closestIdx][0]);
        hoverLine.style.display = 'block';
      }

      // Update circle radii and styles
      circles.forEach((circle, idx) => {
        if (idx === closestIdx) {
          circle.setAttribute('r', '4.5');
          circle.setAttribute('fill', '#e6b87a');
        } else {
          circle.setAttribute('r', '2.5');
          circle.setAttribute('fill', '#cc9966');
        }
      });

      // Update interactive label
      const d = allDays[closestIdx];
      const dateStr = d.date ? new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Today';
      hoverValEl.innerHTML = `<span class="px-chart-hover-date">${dateStr}:</span> <strong class="px-chart-hover-count">~${formatTokens(vals[closestIdx])}</strong>`;
    };

    const resetHover = () => {
      if (hoverLine) {
        hoverLine.style.display = 'none';
      }
      circles.forEach(circle => {
        circle.setAttribute('r', '3');
        circle.setAttribute('fill', '#cc9966');
      });
      hoverValEl.textContent = `Avg: ~${formatTokens(avgTokens)}`;
    };

    svgEl.addEventListener('mousemove', (e) => {
      handleHover(e.clientX);
    });

    svgEl.addEventListener('mouseleave', () => {
      resetHover();
    });

    // Touch events for mobile compatibility
    svgEl.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) {
        handleHover(e.touches[0].clientX);
      }
    }, { passive: true });

    svgEl.addEventListener('touchend', () => {
      resetHover();
    });
  }
}

// ─── History Panel (Features 12 & 14) ────────────────────────────────────────

async function initHistory() {
  // today is live from storage.local; past days come from IndexedDB
  const resLocal = await browser.storage.local.get(['today', 'conv_stats', 'settings']);
  const settings = resLocal.settings || {};
  const ianaTz = (() => {
    try {
      if (!settings.timezone || settings.timezone === 'auto') return Intl.DateTimeFormat().resolvedOptions().timeZone;
      const TZ_MAP = { 'HST':'Pacific/Honolulu','AKST':'America/Anchorage','PST':'America/Los_Angeles','MST':'America/Denver','CST':'America/Chicago','EST':'America/New_York','AST':'America/Halifax','BRT':'America/Sao_Paulo','GMT':'Etc/GMT','CET':'Europe/Paris','EET':'Europe/Athens','MSK':'Europe/Moscow','GST':'Asia/Dubai','PKT':'Asia/Karachi','IST':'Asia/Kolkata','NPT':'Asia/Kathmandu','BST':'Asia/Dhaka','ICT':'Asia/Bangkok','CST-Asia':'Asia/Shanghai','SGT':'Asia/Singapore','JST':'Asia/Tokyo','KST':'Asia/Seoul','ACST':'Australia/Darwin','AEST':'Australia/Sydney','NZST':'Pacific/Auckland' };
      return TZ_MAP[settings.timezone] || Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch(e) { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  })();
  const todayDate = todayStr(ianaTz);
  const today = resLocal.today || freshToday(ianaTz);
  const allHistory = await UsageXDB.getAllDailyStats();
  const topConvos = await UsageXDB.getTopConversations(5);

  const pastDays = allHistory.filter(d => d.date !== todayDate);
  const allDays = [...pastDays, today].filter(Boolean);

  const cutoffDate = (() => {
    try {
      const tz = ianaTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const d = new Date();
      d.setDate(d.getDate() - 29);
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const parts = formatter.formatToParts(d);
      const year = parts.find(p => p.type === 'year').value;
      const month = parts.find(p => p.type === 'month').value;
      const day = parts.find(p => p.type === 'day').value;
      return `${year}-${month}-${day}`;
    } catch (e) {
      const d = new Date();
      d.setDate(d.getDate() - 29);
      return d.toISOString().slice(0, 10);
    }
  })();
  const last30Days = allDays.filter(d => d.date && d.date >= cutoffDate);

  // Compute total tokens for the header
  const totalTok = last30Days.reduce((sum, d) => sum + (d.tokens_est || 0), 0);
  const totalEl = el('px-heatmap-total-est');
  if (totalEl) {
    if (totalTok > 0) {
      totalEl.innerHTML = `<strong>~${formatTokens(totalTok)}</strong> tokens`;
    } else {
      totalEl.textContent = '';
    }
  }

  // Calculate 30-day stats
  const activeDays = last30Days.filter(d => (d.tokens_est || 0) > 0).length;
  const avgTokens = Math.round(totalTok / 30);
  const maxTokens = Math.max(...last30Days.map(d => d.tokens_est || 0), 0);

  const avgEl = el('px-hm-stat-avg');
  if (avgEl) avgEl.textContent = `~${formatTokens(avgTokens)}`;

  const activeEl = el('px-hm-stat-active');
  if (activeEl) activeEl.textContent = `${activeDays} / 30 days`;

  const maxEl = el('px-hm-stat-max');
  if (maxEl) maxEl.textContent = maxTokens > 0 ? `~${formatTokens(maxTokens)}` : '—';

  renderHeatmap(last30Days);
  renderTopConversations(topConvos);
  const activeDaysList = allDays.filter(d => (d.msgs || 0) > 0 || (d.tokens_est || 0) > 0);
  renderDailyLog([...activeDaysList].reverse());
}

function renderHeatmap(days) {
  const el_ = el('px-heatmap');
  if (!el_) return;

  // Build a lookup: date string → tokens_est
  const lookup = {};
  days.forEach(d => { if (d.date) lookup[d.date] = d.tokens_est || 0; });

  const maxTok = Math.max(...Object.values(lookup), 1);

  // Determine the grid start: go back 30 days (29 days ago), then rewind to
  // the start of that week (Sunday = 0).
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  // Start from 30 days ago, aligned to a Sunday
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 29);
  // Rewind to Sunday of that week
  const dayOfWeek = startDate.getDay(); // 0 = Sun
  startDate.setDate(startDate.getDate() - dayOfWeek);

  const cells = [];
  const cursor = new Date(startDate);

  while (cursor <= today) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const isFuture = cursor > today;
    const tok = lookup[dateStr] || 0;
    const ratio = tok / maxTok;

    let level = 0;
    if (!isFuture && tok > 0) {
      if (ratio > 0.75) level = 4;
      else if (ratio > 0.5) level = 3;
      else if (ratio > 0.25) level = 2;
      else level = 1;
    }

    let label = '';
    if (!isFuture) {
      const dateLabel = cursor.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      label = tok > 0
        ? `${dateLabel}: ~${formatTokens(tok)} tokens`
        : `${dateLabel}: no usage`;
    }

    const futureClass = isFuture ? ' px-hm-future' : '';
    const tooltipAttr = label ? ` data-tooltip="${label}"` : '';
    cells.push(`<span class="px-hm-cell px-hm-${level}${futureClass}"${tooltipAttr}></span>`);

    cursor.setDate(cursor.getDate() + 1);
  }

  el_.innerHTML = cells.join('');
}

function renderTopConversations(entries) {
  const listEl = el('px-convo-list');
  const section = el('px-convos-section');
  if (!listEl) return;

  if (!entries || entries.length === 0) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';

  const topTokens = entries[0].tokens_est || 1;
  listEl.innerHTML = entries.map((c, i) => {
    const name = c.name || `Conversation ${i + 1}`;
    const barW = Math.round(((c.tokens_est || 0) / topTokens) * 100);
    const ts = c.last_active ? new Date(c.last_active).toLocaleDateString() : '';
    return `
      <div class="px-convo-row">
        <div class="px-convo-header">
          <span class="px-convo-name" title="${name}">${name}</span>
          <span class="px-convo-date">${ts}</span>
        </div>
        <div class="px-convo-bar-wrap">
          <div class="px-convo-bar" style="width:${barW}%"></div>
        </div>
        <div class="px-convo-meta">${c.msgs || 0} msgs · ~${formatTokens(c.tokens_est || 0)} tokens</div>
      </div>`;
  }).join('');
}

function renderDailyLog(historyDesc) {
  const listEl = el('px-history-list');
  if (!listEl) return;
  if (!historyDesc.length) {
    listEl.innerHTML = '<div class="px-history-empty">No history yet. Use Claude to build history.</div>';
    return;
  }
  listEl.innerHTML = historyDesc.map(d => {
    const mu = d.models_used || {};
    const lastModel = d.last_model || null;
    let modelEntries = Object.entries(mu).filter(([, c]) => c > 0);
    if (modelEntries.length === 0 && lastModel) {
      modelEntries.push([lastModel, 0]);
    }

    let pillsHtml = '';
    if (modelEntries.length > 0) {
      pillsHtml = modelEntries
        .sort((a, b) => b[1] - a[1])
        .map(([mid]) => {
          const name = modelDisplayName(mid);
          if (!name) return '';
          const cls = modelPillClass(mid);
          return `<span class="px-model-pill ${cls}">${name}</span>`;
        })
        .filter(Boolean)
        .join('');
    }

    const eb = d.effort_breakdown || { low: 0, medium: 0, high: 0, max: 0 };
    const et = d.extended_thinking || { on: 0, off: 0 };
    const hasEffort = (eb.low || 0) + (eb.medium || 0) + (eb.high || 0) + (eb.max || 0) > 0;
    const hasThinking = (et.on || 0) + (et.off || 0) > 0;

    let metricsHtml = '';
    if (hasEffort || hasThinking) {
      let subparts = [];
      if (hasEffort) {
        subparts.push(`Effort: Low ${eb.low || 0} &middot; Med ${eb.medium || 0} &middot; High ${eb.high || 0} &middot; Max ${eb.max || 0}`);
      }
      if (hasThinking) {
        subparts.push(`Thinking: ON ${et.on || 0} &middot; OFF ${et.off || 0}`);
      }
      metricsHtml = `<div class="px-history-detail-metrics">${subparts.join(' &nbsp;&middot;&nbsp; ')}</div>`;
    }

    const hasDetails = pillsHtml || metricsHtml;

    return `
      <div class="px-history-row ${hasDetails ? 'px-history-expandable' : ''}">
        <div class="px-history-summary">
          <span class="px-history-date">${d.date || '—'}</span>
          <span class="px-history-stats">${d.msgs || 0} msgs · ~${formatTokens(d.tokens_est || 0)} tok · ${formatDuration(d.time_s)}</span>
        </div>
        ${hasDetails ? `
        <div class="px-history-details">
          ${pillsHtml ? `<div class="px-model-pills-row">${pillsHtml}</div>` : ''}
          ${metricsHtml}
        </div>` : ''}
      </div>`;
  }).join('');
}

// ─── Tools ───────────────────────────────────────────────────────────────────

async function exportData() {
  const localData = await browser.storage.local.get(['today', 'settings', 'usage_limits', 'debug_logs', 'conv_stats']);
  const dailyStats = await UsageXDB.getAllDailyStats();
  const convoStats = await UsageXDB.getAllConvoStats();
  
  // Merge conv_stats: IndexedDB is archived, storage.local has live conversations
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
  
  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `usagex-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function openDebugViewer() {
  const url = browser.runtime.getURL('debug-viewer.html');
  browser.tabs.create({ url });
}

async function resetTodayStats() {
  const res = await browser.storage.local.get('settings');
  const settings = res.settings || {};
  const ianaTz = (() => {
    try {
      if (!settings.timezone || settings.timezone === 'auto') return Intl.DateTimeFormat().resolvedOptions().timeZone;
      const TZ_MAP = { 'HST':'Pacific/Honolulu','AKST':'America/Anchorage','PST':'America/Los_Angeles','MST':'America/Denver','CST':'America/Chicago','EST':'America/New_York','AST':'America/Halifax','BRT':'America/Sao_Paulo','GMT':'Etc/GMT','CET':'Europe/Paris','EET':'Europe/Athens','MSK':'Europe/Moscow','GST':'Asia/Dubai','PKT':'Asia/Karachi','IST':'Asia/Kolkata','NPT':'Asia/Kathmandu','BST':'Asia/Dhaka','ICT':'Asia/Bangkok','CST-Asia':'Asia/Shanghai','SGT':'Asia/Singapore','JST':'Asia/Tokyo','KST':'Asia/Seoul','ACST':'Australia/Darwin','AEST':'Australia/Sydney','NZST':'Pacific/Auckland' };
      return TZ_MAP[settings.timezone] || Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch(e) { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  })();
  await browser.storage.local.set({ today: freshToday(ianaTz) });
  await UsageXDB.saveDailyStats(todayStr(ianaTz), freshToday(ianaTz)).catch(() => {});
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

  // ── Feature 10: Alert Threshold Sliders ──
  const sessSlider = el('px-thresh-session');
  const weekSlider = el('px-thresh-weekly');

  async function saveThresholds() {
    const res = await browser.storage.local.get('settings');
    const s = res.settings || {};
    const sessV = Number(sessSlider?.value ?? 80);
    const weekV = Number(weekSlider?.value ?? 80);
    await browser.storage.local.set({ settings: { ...s, alert_session_threshold: sessV, alert_weekly_threshold: weekV } });
  }

  sessSlider?.addEventListener('input', () => {
    const v = el('px-thresh-session-val');
    if (v) v.textContent = sessSlider.value + '%';
  });
  sessSlider?.addEventListener('change', saveThresholds);

  weekSlider?.addEventListener('input', () => {
    const v = el('px-thresh-weekly-val');
    if (v) v.textContent = weekSlider.value + '%';
  });
  weekSlider?.addEventListener('change', saveThresholds);
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

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.today || changes.usage_limits || changes.active_account_id || changes.user_name || changes.user_email || changes.user_plan) {
      refreshDashboard().catch(() => {});
      const histTab = el('tab-history');
      if (histTab && histTab.classList.contains('px-tab-active')) {
        initHistory().catch(() => {});
      }
    }
  });

  // Setup secure click handler for history log details (avoids inline onclick CSP block)
  const listEl = el('px-history-list');
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.px-history-expandable');
      if (row) {
        row.classList.toggle('expanded');
      }
    });
  }

  // Load History tab data on click to ensure stats are always fresh
  const histTab = el('tab-history');
  if (histTab) {
    histTab.addEventListener('click', () => {
      initHistory().catch(() => { });
    });
  }

  // Auto-switch to a specific tab if requested via URL param or storage flag
  const urlParam = new URLSearchParams(location.search).get('tab');
  let targetTab = urlParam || null;

  if (!targetTab) {
    // Check storage flag set by the sidebar "Help & Guide" button
    const flagRes = await browser.storage.local.get('_open_help_tab');
    if (flagRes._open_help_tab) {
      targetTab = 'help';
      await browser.storage.local.remove('_open_help_tab');
    }
  }

  if (targetTab) {
    const btn = document.getElementById(`tab-${targetTab}`);
    if (btn) btn.click();
  }
}

document.addEventListener('DOMContentLoaded', init);
