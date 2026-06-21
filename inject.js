(function() {
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      
      // Get the request method safely
      let reqMethod = '';
      if (args[1]) {
        reqMethod = args[1].method;
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        reqMethod = args[0].method;
      }
      reqMethod = (reqMethod || 'GET').toUpperCase();
      
      // Intercept message completion requests
      if (reqMethod === 'POST' && (url.includes('/completion') || url.includes('/messages'))) {
        (async () => {
          let reqBody = '';
          try {
            if (args[1] && args[1].body) {
              const b = args[1].body;
              if (typeof b === 'string') {
                reqBody = b;
              } else if (b instanceof Blob) {
                reqBody = await b.text();
              } else if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) {
                reqBody = new TextDecoder().decode(b);
              } else if (typeof b.text === 'function') {
                reqBody = await b.text();
              }
            } else if (args[0] && typeof args[0] === 'object' && typeof args[0].clone === 'function') {
              const clone = args[0].clone();
              reqBody = await clone.text();
            }
          } catch (_) {}

          // Extract convoId from URL for per-conversation tracking (Feature 14)
          const convoIdMatch = url.match(/\/chat_conversations\/([a-f0-9-]{36})/i);
          const convoId = convoIdMatch ? convoIdMatch[1] : null;
          
          if (reqBody) {
            window.postMessage({ type: '__ux_fetch_msg', body: reqBody, convoId }, '*');
          }
        })().catch(() => {});
      }
      
      // Intercept usage limits/stats from Claude's organization API calls
      const checkUrl = url.includes('/api/organizations');
      if (checkUrl) {
        const clone = res.clone();
        clone.text().then(function(text) {
          try {
            const json = JSON.parse(text);
            if (typeof json !== 'object' || json === null) return;
            
            // Intercept conversation history (GET /chat_conversations/{uuid})
            if (url.includes('/chat_conversations/') && Array.isArray(json.chat_messages)) {
              // Extract convoId and optional name from URL + response
              const convoIdMatch = url.match(/\/chat_conversations\/([a-f0-9-]{36})/i);
              const convoId = convoIdMatch ? convoIdMatch[1] : null;
              const convoName = typeof json.name === 'string' ? json.name : null;
              const modelId = json.model?.id || json.model || json.model_id || null;
              const thinkingMode = json.settings?.thinking_mode || json.effective_thinking_mode || null;
              window.postMessage({ type: '__ux_convo_history', data: json.chat_messages, convoId, convoName, modelId, thinkingMode }, '*');
            }

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
