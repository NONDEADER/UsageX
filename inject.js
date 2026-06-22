(function() {
  let cachedUserInfo = null;

  // ── DOM scraping fallback ──
  // Reads the name/email from Claude's bottom-left account card.
  // This is used when the /api/me or /api/account intercept hasn't fired yet.
  function scrapeUserInfoFromDOM() {
    try {
      let email = '';
      let name = '';
      let plan = '';

      // 1. Try to find the user profile/menu element to extract the name
      const userMenuBtn = document.querySelector('[data-testid="user-menu-button"]') || 
                          document.querySelector('[class*="UserMenu"]') || 
                          document.querySelector('[class*="user-menu"]') ||
                          document.querySelector('[class*="profile"]');
      if (userMenuBtn) {
        // Use innerText to get clean newline-separated lines representing the layout
        const text = userMenuBtn.innerText || userMenuBtn.textContent || '';
        if (text) {
          const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          if (lines.length > 0) {
            let possibleName = '';
            let possiblePlan = '';
            
            // If first line is a single character, it's the avatar letter (e.g. "M")
            let nameIndex = 0;
            if (lines[0].length === 1 && lines.length > 1) {
              nameIndex = 1;
            }
            
            if (lines[nameIndex]) {
              possibleName = lines[nameIndex];
            }
            
            // Find plan keyword on subsequent lines
            for (let i = nameIndex + 1; i < lines.length; i++) {
              const line = lines[i].toLowerCase();
              if (line.includes('plan') || line.includes('pro') || line.includes('free') || line.includes('upgrade') || line.includes('member')) {
                possiblePlan = lines[i];
                break;
              }
            }
            
            if (possibleName && possibleName.length < 50) {
              name = possibleName;
            }
            if (possiblePlan) {
              plan = possiblePlan.replace(/plan/i, '').trim();
              plan = plan.charAt(0).toUpperCase() + plan.slice(1);
            }
          }
        }
      }

      // 2. Walk leaf text nodes to look for an email pattern as well
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (emailRegex.test(text)) {
          email = text;
          // If name wasn't found from button, search nearby parent/sibling elements
          if (!name) {
            let el = node.parentElement;
            for (let i = 0; i < 5; i++) {
              if (!el) break;
              const siblings = Array.from(el.parentElement?.childNodes || []);
              for (const sib of siblings) {
                const sibText = sib.textContent?.trim() || '';
                if (sibText && sibText !== email && !emailRegex.test(sibText) && sibText.length > 1 && sibText.length < 60) {
                  name = sibText;
                  break;
                }
              }
              if (name) break;
              el = el.parentElement;
            }
          }
          break;
        }
      }

      if (name || email || plan) {
        return { name, email, plan };
      }
    } catch (_) {}
    return null;
  }

  function broadcastUserInfo(info) {
    if (!info) return;
    cachedUserInfo = info;
    window.postMessage({ type: '__ux_user_info', uuid: info.uuid || info.email || '', email: info.email, name: info.name || '', plan: info.plan || '' }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data.type === '__ux_request_user_info') {
      if (cachedUserInfo) {
        window.postMessage({ type: '__ux_user_info', ...cachedUserInfo }, '*');
      } else {
        // Try DOM scraping as a fallback
        const domInfo = scrapeUserInfoFromDOM();
        if (domInfo && (domInfo.name || domInfo.email)) {
          broadcastUserInfo(domInfo);
        }
      }
    }
  });

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
      
      // Intercept usage limits/stats from Claude's organization/me/account API calls
      const checkUrl = url.includes('/api/organizations') || url.includes('/api/me') || url.includes('/api/account') || url.includes('/chat_conversations');
      if (checkUrl) {
        const clone = res.clone();
        clone.text().then(function(text) {
          try {
            const json = JSON.parse(text);
            if (typeof json !== 'object' || json === null) return;

            // Intercept current user info from /api/me
            if (url.includes('/api/me') && json.uuid) {
              let name = '';
              if (json.first_name || json.last_name) {
                name = ((json.first_name || '') + ' ' + (json.last_name || '')).trim();
              } else if (json.name) {
                name = json.name;
              } else if (json.profile && json.profile.name) {
                name = json.profile.name;
              }
              cachedUserInfo = { uuid: json.uuid, email: json.email_address || json.email || '', name };
              window.postMessage({ type: '__ux_user_info', ...cachedUserInfo }, '*');
            }

            // Intercept current user info from /api/account (primary Claude endpoint)
            // Fields: email_address, full_name, display_name, uuid
            if (url.includes('/api/account') && (json.uuid || json.email_address)) {
              const name = json.full_name || json.display_name || json.name || '';
              const email = json.email_address || json.email || '';
              const uuid = json.uuid || email;
              
              let plan = '';
              const memberships = Array.isArray(json.memberships) ? json.memberships : [];
              const activeMember = memberships.find(m => {
                const caps = m?.organization?.capabilities || [];
                return caps.includes("chat") || caps.includes("claude_pro") || caps.includes("claude_max");
              }) || memberships.find(m => !(m?.organization?.capabilities || []).includes("api")) || memberships[0];
              
              if (activeMember?.organization) {
                const tier = String(activeMember.organization.rate_limit_tier || '').toLowerCase();
                const caps = activeMember.organization.capabilities || [];
                if (tier.includes('max_20x')) plan = 'Max x20';
                else if (tier.includes('max_5x') || tier.includes('max5')) plan = 'Max x5';
                else if (tier.includes('pro')) plan = 'Pro';
                else if (tier.includes('free')) plan = 'Free';
                else if (caps.includes('claude_max')) plan = 'Max';
                else if (caps.includes('claude_pro')) plan = 'Pro';
              }

              if (uuid || email) {
                cachedUserInfo = { uuid, email, name, plan };
                window.postMessage({ type: '__ux_user_info', ...cachedUserInfo }, '*');
              }
            }
            
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
