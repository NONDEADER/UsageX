'use strict';

if (typeof browser === 'undefined') var browser = chrome;

document.getElementById('auth-btn').addEventListener('click', async () => {
  const origins = [
    "https://script.google.com/*",
    "https://script.googleusercontent.com/*"
  ];
  
  const statusEl = document.getElementById('status');
  statusEl.textContent = "Requesting permissions...";
  statusEl.style.color = "";

  try {
    const granted = await browser.permissions.request({ origins });
    if (granted) {
      statusEl.textContent = "✓ Permission granted! You can now close this tab.";
      statusEl.style.color = "#4ade80";
      setTimeout(() => {
        window.close();
      }, 1500);
    } else {
      statusEl.textContent = "✗ Permission denied.";
      statusEl.style.color = "#ef4444";
    }
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.style.color = "#ef4444";
  }
});
