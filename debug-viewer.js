(function () {
  if (typeof browser === "undefined") {
    var browser = chrome;
  }

  const logContainer = document.getElementById("logContainer");
  const logCount = document.getElementById("logCount");
  const refreshBtn = document.getElementById("refreshBtn");
  const exportBtn = document.getElementById("exportBtn");
  const clearBtn = document.getElementById("clearBtn");

  let currentLogs = [];

  function getStorage() {
    return typeof browser !== "undefined" && browser.storage ? browser.storage : null;
  }

  function formatTime(timestamp) {
    if (!timestamp) return "--:--:--";
    const d = new Date(timestamp);
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    const s = d.getSeconds().toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function renderLogs(logs) {
    logContainer.innerHTML = "";
    currentLogs = logs || [];

    if (!currentLogs.length) {
      logContainer.innerHTML = `
        <div class="dv-empty">
          <svg class="dv-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <div class="dv-empty-title">No logs yet</div>
          <div class="dv-empty-desc">Enable debug logging in Settings to start tracking.</div>
        </div>
      `;
      logCount.textContent = "0 logs";
      return;
    }

    logCount.textContent = `${currentLogs.length} logs`;

    const fragment = document.createDocumentFragment();

    for (const log of currentLogs) {
      const entry = document.createElement("div");
      entry.className = "dv-log-entry";

      const timeEl = document.createElement("span");
      timeEl.className = "dv-log-time";
      timeEl.textContent = formatTime(log.timestamp || log.ts);

      const scopeEl = document.createElement("span");
      scopeEl.className = "dv-log-scope";
      scopeEl.textContent = log.scope || log.event || "log";

      const msgEl = document.createElement("span");
      msgEl.className = "dv-log-message";
      let msg = log.message;
      if (!msg && log.data) {
        msg = typeof log.data === "object" ? JSON.stringify(log.data) : String(log.data);
      }
      msgEl.textContent = msg || "";

      entry.appendChild(timeEl);
      entry.appendChild(scopeEl);
      entry.appendChild(msgEl);
      fragment.appendChild(entry);
    }

    logContainer.appendChild(fragment);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function exportLogs() {
    if (!currentLogs.length) return;
    const blob = new Blob([JSON.stringify(currentLogs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `usagex-debug-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function refreshLogs() {
    const storage = getStorage();
    if (storage) {
      storage.local.get("debug_logs").then((result) => {
        renderLogs(result.debug_logs || []);
      }).catch(() => {
        renderLogs([]);
      });
    }
  }

  function clearLogs() {
    const storage = getStorage();
    if (storage) {
      storage.local.set({ debug_logs: [] }).then(() => {
        renderLogs([]);
      }).catch(() => {
        renderLogs([]);
      });
    }
  }

  refreshBtn.addEventListener("click", refreshLogs);
  exportBtn.addEventListener("click", exportLogs);
  clearBtn.addEventListener("click", clearLogs);

  // Initial load from storage
  refreshLogs();

  // Auto-refresh every 5 seconds
  setInterval(refreshLogs, 5000);
})();
