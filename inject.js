(function() {
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      
      // Get the request method and body safely
      let reqMethod = '';
      let reqBody = '';
      if (args[1]) {
        reqMethod = args[1].method;
        reqBody = args[1].body;
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        reqMethod = args[0].method;
      }
      
      // Intercept message completion requests
      if (reqMethod && reqMethod.toUpperCase() === 'POST' && (url.includes('/completion') || url.includes('/messages'))) {
        window.postMessage({ type: '__ux_fetch_msg', body: reqBody }, '*');
      }
      
      // Intercept usage limits/stats from Claude's organization API calls
      const checkUrl = url.includes('/api/organizations');
      if (checkUrl) {
        const clone = res.clone();
        clone.text().then(function(text) {
          try {
            const json = JSON.parse(text);
            if (typeof json !== 'object' || json === null) return;
            if (json.five_hour || json.seven_day) {
              window.postMessage({ type: '__ux_usage_data', data: {
                session_pct: json.five_hour ? (json.five_hour.utilization ?? null) : null,
                session_resets_at: json.five_hour ? (json.five_hour.resets_at || null) : null,
                weekly_pct: json.seven_day ? (json.seven_day.utilization ?? null) : null,
                weekly_resets_at: json.seven_day ? (json.seven_day.resets_at || null) : null,
              } }, '*');
            }
            if (url.includes('/completion') || url.includes('/sync/') || url.includes('/chat_conversations')) {
              const found = [];
              for (const k in json) {
                if (/limit|usage|rate|remaining|reset|hour|pct|util/i.test(k)) {
                  found.push(k + ':' + JSON.stringify(json[k]).slice(0, 100));
                }
                if (json[k] && typeof json[k] === 'object' && (json[k].resets_at || json[k].utilization || json[k].remaining)) {
                  found.push(k + ':{resets_at,utilization}');
                }
              }
              const topKeys = Object.keys(json).join(', ');
              if (found.length) console.log('[UsageX]', url.split('/').pop(), '→ keys:', topKeys, '| usage:', found.join(' | '));
            }
          } catch(_) {}
        }).catch(function() {});
      }
    } catch(_) {}
    return res;
  };
})();
