// kEye — Service Worker (multi-domain)

const AUTH_HEADER_PATTERNS = [
  'authorization',
  'cookie',
  'x-auth-token',
  'x-csrf-token',
  'x-api-key',
];

const AUTH_HEADER_FUZZY = ['token', 'auth', 'session'];

// --- Tracking / analytics domain blocklist ---
// Entire origins are skipped — no headers captured from these domains
const TRACKING_DOMAINS = [
  // Google
  'google-analytics.com', 'googletagmanager.com', 'googleadservices.com',
  'googlesyndication.com', 'doubleclick.net', 'googletagservices.com',
  'google.com/pagead', 'analytics.google.com',
  // Facebook / Meta
  'facebook.net', 'facebook.com/tr', 'connect.facebook.net',
  'graph.facebook.com',
  // Microsoft
  'clarity.ms', 'bat.bing.com', 'c.bing.com',
  // Hotjar
  'hotjar.com', 'hotjar.io',
  // Analytics / tracking
  'segment.io', 'segment.com', 'cdn.segment.com',
  'mixpanel.com', 'amplitude.com', 'heapanalytics.com',
  'fullstory.com', 'logrocket.com', 'smartlook.com',
  // Ads
  'criteo.com', 'criteo.net', 'adroll.com', 'outbrain.com',
  'taboola.com', 'doubleclick.net', 'adsrvr.org',
  // Social tracking
  'pinterest.com/ct', 'snap.licdn.com', 'ads.linkedin.com',
  'analytics.tiktok.com', 't.co',
  // Other
  'hubspot.com', 'hs-analytics.net', 'hsforms.com',
  'intercom.io', 'intercomcdn.com',
  'sentry.io', 'browser-intake-datadoghq.com',
  'newrelic.com', 'nr-data.net',
  'cookiebot.com', 'onetrust.com', 'cookielaw.org',
];

function isTrackingDomain(domain) {
  return TRACKING_DOMAINS.some(td => domain === td || domain.endsWith('.' + td));
}

// Cookie names that are purely tracking/analytics — filter from Cookie header
const TRACKING_COOKIE_PATTERNS = [
  '_ga', '_gid', '_gat', '_gcl', '__utm', '_dc_gtm',  // Google Analytics / Ads / GTM
  '_fbp', '_fbc',                                       // Facebook
  '_hjSession', '_hjSessionUser', '_hj', '_hjAbsolute', // Hotjar
  '_clck', '_clsk',                                     // Clarity
  '_uetsid', '_uetvid',                                 // Bing Ads
  'hubspot', '__hs', '__hstc', '__hssc', '__hssrc',     // HubSpot
  '_pin_unauth',                                        // Pinterest
  'mp_', 'mixpanel',                                    // Mixpanel
  '_tt_', 'ttclid',                                     // TikTok
  'ajs_', 'amplitude',                                  // Segment / Amplitude
  '__stripe_mid', '__stripe_sid',                       // Stripe analytics
  'AMCV_', 'AMCVS_', 's_',                             // Adobe
  '_scid', 'sc_',                                       // Snapchat
  '_rdt_uuid',                                          // Reddit
  'intercom-',                                          // Intercom
];

function isTrackingCookie(name) {
  const lower = name.toLowerCase();
  return TRACKING_COOKIE_PATTERNS.some(p => lower.startsWith(p.toLowerCase()));
}

// Filter Cookie header to only auth-relevant cookies
function filterCookieValue(cookieString) {
  if (!cookieString) return null;
  const filtered = cookieString.split(';')
    .map(c => c.trim())
    .filter(c => {
      const name = c.split('=')[0].trim();
      return !isTrackingCookie(name);
    });
  return filtered.length > 0 ? filtered.join('; ') : null;
}

const ALARM_PREFIX = 'clear:';
const CLIPBOARD_ALARM = 'clipboard-clear';

// --- Settings ---
let settings = { autoClearMinutes: 5, clipboardClearMinutes: 0.5 };

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get({ autoClearMinutes: 5, clipboardClearMinutes: 0.5 });
    settings = stored;
  } catch {}
}
loadSettings();

// --- State: multi-domain ---
// captures[tabDomain] = { headersByOrigin: { "api.example.com": { Authorization: "..." } }, tabId, capturedAt, active }
let captures = Object.create(null);
let connectedPorts = [];

// --- Helpers ---
function isAuthHeader(name) {
  const lower = name.toLowerCase();
  if (AUTH_HEADER_PATTERNS.includes(lower)) return true;
  return AUTH_HEADER_FUZZY.some(p => lower.includes(p));
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Known multi-part TLDs where root domain is 3rd level
const MULTI_PART_TLDS = [
  'co.uk','org.uk','co.jp','co.kr','co.nz','co.in','co.il','co.za',
  'com.au','com.br','com.mx','com.ar','com.tr','com.cn','com.tw','com.hk',
  'net.au','org.au','ac.uk','gov.uk',
];

function getRootDomain(domain) {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.includes(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}


function broadcast(message) {
  for (const port of connectedPorts) {
    try { port.postMessage(message); } catch {}
  }
}

function getSnapshot() {
  const snap = Object.create(null);
  for (const tabDomain of Object.keys(captures)) {
    const c = captures[tabDomain];
    const origins = Object.create(null);
    for (const [origin, headers] of Object.entries(c.headersByOrigin)) {
      origins[origin] = { ...headers };
    }
    snap[tabDomain] = {
      headersByOrigin: origins,
      tabId: c.tabId,
      capturedAt: c.capturedAt,
      active: c.active,
    };
  }
  return snap;
}

let broadcastTimer = null;
function broadcastState() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast({ type: 'STATE_UPDATE', captures: getSnapshot() });
  }, 300);
}

// Immediate broadcast (for user-triggered actions like start/stop/clear)
function broadcastStateNow() {
  if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
  broadcast({ type: 'STATE_UPDATE', captures: getSnapshot() });
}

function clearDomain(domain) {
  delete captures[domain];
  if (autoStopTimers[domain]) { clearTimeout(autoStopTimers[domain]); delete autoStopTimers[domain]; }
  chrome.alarms.clear(ALARM_PREFIX + domain);
  broadcastStateNow();
}

function clearAll() {
  for (const domain of Object.keys(captures)) {
    chrome.alarms.clear(ALARM_PREFIX + domain);
    if (autoStopTimers[domain]) { clearTimeout(autoStopTimers[domain]); delete autoStopTimers[domain]; }
  }
  captures = Object.create(null);
  removeListeners();
  broadcastStateNow();
}

// --- Auto-stop after strong auth headers ---
const STRONG_AUTH_HEADERS = ['authorization', 'x-auth-token', 'x-csrf-token', 'x-api-key'];
let autoStopTimers = Object.create(null);
const AUTO_STOP_DELAY = 10000; // 10s after last new header — allow full page load

function scheduleAutoStop(domain) {
  if (autoStopTimers[domain]) clearTimeout(autoStopTimers[domain]);
  autoStopTimers[domain] = setTimeout(() => {
    delete autoStopTimers[domain];
    if (captures[domain] && captures[domain].active) {
      captures[domain].active = false;
      updateListeners();
      broadcastStateNow();
    }
  }, AUTO_STOP_DELAY);
}

function hasStrongAuth(headersByOrigin) {
  for (const headers of Object.values(headersByOrigin)) {
    if (Object.keys(headers).some(k => STRONG_AUTH_HEADERS.includes(k.toLowerCase()))) return true;
  }
  return false;
}

// --- webRequest listeners ---
// All auth headers captured and grouped by actual request domain (origin)

function onSendHeaders(details) {
  const reqDomain = extractDomain(details.url);
  if (!reqDomain || isTrackingDomain(reqDomain)) return;

  let changed = false;
  for (const tabDomain of Object.keys(captures)) {
    const c = captures[tabDomain];
    if (!c.active || details.tabId !== c.tabId) continue;

    for (const header of (details.requestHeaders || [])) {
      if (isAuthHeader(header.name)) {
        let value = header.value;
        // Filter tracking cookies from Cookie header
        if (header.name.toLowerCase() === 'cookie') {
          value = filterCookieValue(value);
          if (!value) continue;
        }
        if (!c.headersByOrigin[reqDomain]) c.headersByOrigin[reqDomain] = Object.create(null);
        if (c.headersByOrigin[reqDomain][header.name] !== value) {
          c.headersByOrigin[reqDomain][header.name] = value;
          changed = true;
        }
      }
    }
    if (changed && hasStrongAuth(c.headersByOrigin)) {
      scheduleAutoStop(tabDomain);
    }
  }
  if (changed) broadcastState();
}

function onHeadersReceived(details) {
  const reqDomain = extractDomain(details.url);
  if (!reqDomain || isTrackingDomain(reqDomain)) return;

  let changed = false;
  for (const tabDomain of Object.keys(captures)) {
    const c = captures[tabDomain];
    if (!c.active || details.tabId !== c.tabId) continue;

    for (const header of (details.responseHeaders || [])) {
      if (isAuthHeader(header.name)) {
        let value = header.value;
        if (header.name.toLowerCase() === 'set-cookie') {
          const cookieName = (value || '').split('=')[0].trim();
          if (isTrackingCookie(cookieName)) continue;
        }
        if (!c.headersByOrigin[reqDomain]) c.headersByOrigin[reqDomain] = Object.create(null);
        const key = 'response:' + header.name;
        if (c.headersByOrigin[reqDomain][key] !== value) {
          c.headersByOrigin[reqDomain][key] = value;
          changed = true;
        }
      }
    }
    if (changed && hasStrongAuth(c.headersByOrigin)) {
      scheduleAutoStop(tabDomain);
    }
  }
  if (changed) broadcastState();
}

let listenersActive = false;

function addListeners() {
  if (listenersActive) return;
  listenersActive = true;
  chrome.webRequest.onSendHeaders.addListener(
    onSendHeaders, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']
  );
  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceived, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']
  );
}

function removeListeners() {
  if (!listenersActive) return;
  listenersActive = false;
  chrome.webRequest.onSendHeaders.removeListener(onSendHeaders);
  chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
}

function updateListeners() {
  const hasActive = Object.values(captures).some(c => c.active);
  if (hasActive) addListeners();
  else removeListeners();
}

// --- Alarms ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    const domain = alarm.name.slice(ALARM_PREFIX.length);
    clearDomain(domain);
  }
  if (alarm.name === CLIPBOARD_ALARM) {
    clearClipboardViaOffscreen();
  }
});

async function clearClipboardViaOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Clear clipboard after auth header copy',
    });
  } catch {}
  chrome.runtime.sendMessage({ type: 'CLEAR_CLIPBOARD' });
  setTimeout(async () => {
    try { await chrome.offscreen.closeDocument(); } catch {}
  }, 1000);
}

// --- Port messaging ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  connectedPorts.push(port);
  port.onDisconnect.addListener(() => {
    connectedPorts = connectedPorts.filter(p => p !== port);
  });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'START_CAPTURE': {
        const domain = msg.domain;
        captures[domain] = {
          headersByOrigin: Object.create(null),
          tabId: msg.tabId,
          capturedAt: new Date().toISOString(),
          active: true,
        };
        updateListeners();
        if (settings.autoClearMinutes > 0) {
          chrome.alarms.create(ALARM_PREFIX + domain, { delayInMinutes: settings.autoClearMinutes });
        }
        broadcastStateNow();
        break;
      }

      case 'STOP_CAPTURE': {
        if (captures[msg.domain]) {
          captures[msg.domain].active = false;
        }
        if (autoStopTimers[msg.domain]) { clearTimeout(autoStopTimers[msg.domain]); delete autoStopTimers[msg.domain]; }
        updateListeners();
        broadcastStateNow();
        break;
      }

      case 'GET_STATE': {
        port.postMessage({ type: 'STATE_UPDATE', captures: getSnapshot() });
        break;
      }

      case 'CLEAR_DOMAIN': {
        clearDomain(msg.domain);
        break;
      }

      case 'CLEAR_ALL': {
        clearAll();
        break;
      }

      case 'SCHEDULE_CLIPBOARD_CLEAR': {
        if (settings.clipboardClearMinutes > 0) {
          chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: settings.clipboardClearMinutes });
        }
        break;
      }

      case 'SETTINGS_UPDATE': {
        settings = msg.settings || settings;
        break;
      }
    }
  });
});
