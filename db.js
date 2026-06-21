'use strict';

const UsageXDB = (() => {
  function openDB() {
    return new Promise((resolve, reject) => {
      const storage = typeof browser !== "undefined" ? browser.storage : chrome.storage;
      if (storage && storage.local) {
        storage.local.get(["active_account_id", "first_account_id"], (res) => {
          const activeId = res && res.active_account_id;
          const firstId = res && res.first_account_id;
          const suffix = (activeId && activeId !== firstId) ? "_" + activeId : "";
          const dbName = "UsageXDatabase" + suffix;
          const request = indexedDB.open(dbName, 1);
          
          request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains("daily_stats")) {
              db.createObjectStore("daily_stats", { keyPath: "date" });
            }
            if (!db.objectStoreNames.contains("convo_stats")) {
              const convoStore = db.createObjectStore("convo_stats", { keyPath: "convoId" });
              convoStore.createIndex("tokens_est", "tokens_est", { unique: false });
            }
          };
          
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } else {
        const request = indexedDB.open("UsageXDatabase", 1);
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains("daily_stats")) {
            db.createObjectStore("daily_stats", { keyPath: "date" });
          }
          if (!db.objectStoreNames.contains("convo_stats")) {
            const convoStore = db.createObjectStore("convo_stats", { keyPath: "convoId" });
            convoStore.createIndex("tokens_est", "tokens_est", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }
    });
  }

  function createFreshStats(date) {
    return {
      date: date,
      msgs: 0,
      convos: 0,
      time_s: 0,
      tokens_est: 0,
      effort_breakdown: { low: 0, medium: 0, high: 0, max: 0 },
      extended_thinking: { on: 0, off: 0 },
      last_model: null,
      processed_msg_uuids: [],
      recent_sent_prompts: []
    };
  }

  async function getDailyStats(date) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("daily_stats", "readonly");
      const store = tx.objectStore("daily_stats");
      const request = store.get(date);
      request.onsuccess = () => {
        resolve(request.result || createFreshStats(date));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function saveDailyStats(date, stats) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("daily_stats", "readwrite");
      const store = tx.objectStore("daily_stats");
      const request = store.put({ ...stats, date });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllDailyStats() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("daily_stats", "readonly");
      const store = tx.objectStore("daily_stats");
      const request = store.getAll();
      request.onsuccess = () => {
        const results = request.result || [];
        results.sort((a, b) => a.date.localeCompare(b.date));
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function getConvoStats(convoId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("convo_stats", "readonly");
      const store = tx.objectStore("convo_stats");
      const request = store.get(convoId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveConvoStats(convoId, stats) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("convo_stats", "readwrite");
      const store = tx.objectStore("convo_stats");
      const request = store.put({ ...stats, convoId });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function getTopConversations(limit = 5) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("convo_stats", "readonly");
      const store = tx.objectStore("convo_stats");
      const index = store.index("tokens_est");
      const results = [];
      const request = index.openCursor(null, "prev");
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllConvoStats() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("convo_stats", "readonly");
      const store = tx.objectStore("convo_stats");
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async function clearAllStats() {
    const db = await openDB();
    const tx = db.transaction(["daily_stats", "convo_stats"], "readwrite");
    tx.objectStore("daily_stats").clear();
    tx.objectStore("convo_stats").clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function migrateFromStorage() {
    const storage = typeof browser !== "undefined" ? browser.storage : chrome.storage;
    if (!storage || !storage.local) return;
    
    const flags = await storage.local.get("stats_migrated");
    if (flags.stats_migrated) return;

    const data = await storage.local.get(["today", "history", "conv_stats"]);
    const db = await openDB();

    // Migrate today & history
    const txDaily = db.transaction("daily_stats", "readwrite");
    const storeDaily = txDaily.objectStore("daily_stats");
    
    if (data.today && data.today.date) {
      storeDaily.put(data.today);
    }
    
    if (Array.isArray(data.history)) {
      for (const day of data.history) {
        if (day && day.date) {
          storeDaily.put(day);
        }
      }
    }

    await new Promise((resolve) => {
      txDaily.oncomplete = () => resolve();
      txDaily.onerror = () => resolve();
    });

    // Migrate conv_stats
    if (data.conv_stats && typeof data.conv_stats === "object") {
      const txConvo = db.transaction("convo_stats", "readwrite");
      const storeConvo = txConvo.objectStore("convo_stats");
      
      for (const [convoId, stats] of Object.entries(data.conv_stats)) {
        if (stats && convoId) {
          storeConvo.put({ ...stats, convoId });
        }
      }
      
      await new Promise((resolve) => {
        txConvo.oncomplete = () => resolve();
        txConvo.onerror = () => resolve();
      });
    }

    await storage.local.set({ stats_migrated: true });
    // Only remove 'history' (now archived in IndexedDB).
    // 'today' and 'conv_stats' stay in storage.local — they are the live
    // shared data source between content.js and popup.js (same extension context).
    await storage.local.remove(["history"]);
  }

  return {
    getDailyStats,
    saveDailyStats,
    getAllDailyStats,
    getConvoStats,
    saveConvoStats,
    getTopConversations,
    getAllConvoStats,
    clearAllStats,
    migrateFromStorage
  };
})();

if (typeof self !== "undefined") {
  self.UsageXDB = UsageXDB;
}
