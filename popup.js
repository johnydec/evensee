// Auth Header Capture — Popup (multi-domain, site-centric UI)

// --- DOM refs ---
const domainEl = document.getElementById('domain');
const tabHintEl = document.getElementById('tabHint');
const errorEl = document.getElementById('error');
const currentSiteEl = document.getElementById('currentSite');
const toggleBtn = document.getElementById('toggleBtn');
const toggleIcon = document.getElementById('toggleIcon');
const toggleLabel = document.getElementById('toggleLabel');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const emptyEl = document.getElementById('empty');
const siteListEl = document.getElementById('siteList');
const footerEl = document.getElementById('footer');
const copyAllBtn = document.getElementById('copyAllBtn');
const clearBtn = document.getElementById('clearBtn');
const copyNoticeEl = document.getElementById('copyNotice');

// --- SVG constants (static, trusted) ---
const PLAY_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>';
const STOP_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

// --- Settings DOM refs ---
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const clearOptionsEl = document.getElementById('clearOptions');
const clipboardOptionsEl = document.getElementById('clipboardOptions');
const privacyClearLabel = document.getElementById('privacyClearLabel');

// --- State ---
let port = null;
let currentTabId = null;
let currentDomain = null;
let captures = {};
let expandedDomains = new Set();
let expandedOrigins = new Set();  // tracks which cards show all headers
let timerInterval = null;
let settings = { autoClearMinutes: 5, clipboardClearMinutes: 0.5 };
let prevHeaderCounts = {};  // track header counts per domain for animation
let refreshHintTimer = null;

// --- Protected site detection ---
// Only sites where header replay genuinely fails due to
// IP binding, TLS fingerprinting, or device fingerprinting.
const PROTECTED_SITES = [
  // Meta — datr cookie device-bound, IP+TLS fingerprint checks
  { domains: ['facebook.com', 'fb.com', 'messenger.com', 'instagram.com'], reason: 'Sessions are bound to device fingerprint and IP address' },
  // Google — SID/SSID/HSID cookies IP-bound, aggressive bot detection
  { domains: ['google.com', 'youtube.com', 'gmail.com', 'googleapis.com'], reason: 'Sessions are bound to IP and browser fingerprint' },
  // Microsoft — similar session binding
  { domains: ['live.com', 'outlook.com', 'microsoft.com', 'bing.com'], reason: 'Sessions are bound to device and IP address' },
  // Apple
  { domains: ['apple.com', 'icloud.com'], reason: 'Sessions require device trust and 2FA verification' },
];

function getProtectionInfo(domain) {
  if (!domain) return null;
  for (const entry of PROTECTED_SITES) {
    for (const d of entry.domains) {
      if (domain === d || domain.endsWith('.' + d)) {
        return entry.reason;
      }
    }
  }
  return null;
}

// --- Domain colors ---
const DOMAIN_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

function domainColor(domain) {
  let hash = 0;
  for (const ch of domain) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return DOMAIN_COLORS[Math.abs(hash) % DOMAIN_COLORS.length];
}

function domainInitials(domain) {
  // rohlik.cz -> RO, github.com -> GI
  const name = domain.split('.')[0];
  return name.slice(0, 2).toUpperCase();
}

// --- Init ---
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const blocked = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://', 'devtools://', 'file://'];
  if (!tab || !tab.url || blocked.some(s => tab.url.startsWith(s))) {
    showError('Cannot capture on this page');
    currentSiteEl.classList.add('hidden');
    return;
  }

  currentTabId = tab.id;
  currentDomain = extractDomain(tab.url);
  domainEl.textContent = currentDomain;

  // Check protected site
  const protection = getProtectionInfo(currentDomain);
  if (protection) {
    const noticeEl = document.getElementById('protectedNotice');
    document.getElementById('protectedReason').textContent = protection;
    noticeEl.classList.remove('hidden');
  }

  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => { port = null; });
  port.postMessage({ type: 'GET_STATE' });

  toggleBtn.addEventListener('click', toggleCapture);
  copyAllBtn.addEventListener('click', copyAll);
  clearBtn.addEventListener('click', () => { if (port) port.postMessage({ type: 'CLEAR_ALL' }); });

  // Settings
  await loadSettings();
  settingsBtn.addEventListener('click', toggleSettings);
  initSettingsOptions();

  // Support link + coffee particles
  const supportBtn = document.getElementById('supportBtn');
  supportBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://buymeacoffee.com/evensee' });
  });
  let coffeeInterval = null;
  supportBtn.addEventListener('mouseenter', () => {
    spawnCoffeeParticle(supportBtn);
    coffeeInterval = setInterval(() => spawnCoffeeParticle(supportBtn), 180);
  });
  supportBtn.addEventListener('mouseleave', () => {
    if (coffeeInterval) { clearInterval(coffeeInterval); coffeeInterval = null; }
  });
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function spawnCoffeeParticle(btn) {
  const rect = btn.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = 'coffee-particle';
  el.textContent = '☕';
  const x = rect.left + Math.random() * rect.width;
  const rot = (Math.random() - 0.5) * 40;
  el.style.left = x + 'px';
  el.style.top = (rect.top - 2) + 'px';
  el.style.setProperty('--rot', rot + 'deg');
  el.style.fontSize = (12 + Math.random() * 6) + 'px';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// --- Messages ---
function handleMessage(msg) {
  if (msg.type === 'STATE_UPDATE') {
    captures = msg.captures || {};
    render();
  }
  if (msg.type === 'CLEAR_CLIPBOARD') {
    navigator.clipboard.writeText('').catch(() => {});
  }
}

// --- Toggle ---
function toggleCapture() {
  if (!port || !currentDomain) return;
  const c = captures[currentDomain];
  if (c && c.active) {
    port.postMessage({ type: 'STOP_CAPTURE', domain: currentDomain });
  } else {
    port.postMessage({ type: 'START_CAPTURE', tabId: currentTabId, domain: currentDomain });
    // Show reload notice, then reload page to trigger fresh auth requests
    const notice = document.getElementById('reloadNotice');
    notice.classList.remove('hidden');
    if (currentTabId) {
      setTimeout(() => chrome.tabs.reload(currentTabId), 600);
    }
  }
}

// --- Render ---
function render() {
  const currentCapture = captures[currentDomain];
  const isActive = currentCapture && currentCapture.active;
  const domains = Object.keys(captures);
  const hasData = domains.length > 0;

  // Toggle button state
  if (isActive) {
    toggleLabel.textContent = 'Stop';
    toggleIcon.replaceChildren();
    toggleIcon.insertAdjacentHTML('afterbegin', STOP_SVG);
    toggleBtn.classList.add('active');
    statusEl.classList.remove('hidden');
    startTimer(currentCapture.capturedAt);
  } else {
    toggleLabel.textContent = 'Capture';
    toggleIcon.replaceChildren();
    toggleIcon.insertAdjacentHTML('afterbegin', PLAY_SVG);
    toggleBtn.classList.remove('active');
    statusEl.classList.add('hidden');
    stopTimer();
  }

  // Tab hint
  if (currentCapture) {
    const count = countHeaders(currentCapture);
    const origins = countOrigins(currentCapture);
    if (count > 0) {
      tabHintEl.textContent = count + ' header' + (count !== 1 ? 's' : '') + ' · ' + origins + ' origin' + (origins !== 1 ? 's' : '');
    } else if (currentCapture.active) {
      tabHintEl.textContent = 'Listening\u2026';
    } else {
      tabHintEl.textContent = 'Current tab';
    }
  } else {
    tabHintEl.textContent = 'Current tab';
  }

  // Check if any domain has actual headers
  const totalHeaders = Object.values(captures).reduce((sum, c) => sum + countHeaders(c), 0);

  // Empty / list
  emptyEl.classList.toggle('hidden', hasData);
  siteListEl.classList.toggle('hidden', !hasData);
  footerEl.classList.toggle('hidden', !hasData);
  clearBtn.disabled = !hasData;

  // Copy All disabled until we have actual headers
  copyAllBtn.disabled = totalHeaders === 0;

  // Build site cards + detect newly captured headers (newest first)
  const newCounts = {};
  siteListEl.replaceChildren();
  domains.sort((a, b) => {
    const ta = captures[a].capturedAt || '';
    const tb = captures[b].capturedAt || '';
    return tb.localeCompare(ta);
  });
  for (const domain of domains) {
    const count = countHeaders(captures[domain]);
    newCounts[domain] = count;
    const prevCount = prevHeaderCounts[domain] || 0;
    const justCaptured = prevCount === 0 && count > 0;

    // Auto-expand when headers first arrive
    if (justCaptured) {
      expandedDomains.add(domain);
    }

    const card = createSiteCard(domain, captures[domain]);
    if (justCaptured) {
      card.classList.add('just-captured');
      // Show success overlay
      showCaptureSuccess(domain, count);
    }
    siteListEl.appendChild(card);
  }
  prevHeaderCounts = newCounts;

  // Refresh hint — show after 6s of active capture with 0 headers
  updateRefreshHint(currentCapture);
}

function updateRefreshHint(currentCapture) {
  const hintEl = document.getElementById('refreshHint');
  if (!currentCapture || !currentCapture.active) {
    if (hintEl) hintEl.remove();
    clearRefreshHintTimer();
    return;
  }

  const count = countHeaders(currentCapture);
  if (count > 0) {
    if (hintEl) hintEl.remove();
    clearRefreshHintTimer();
    return;
  }

  // Already showing or timer already set
  if (hintEl || refreshHintTimer) return;

  const elapsed = Date.now() - new Date(currentCapture.capturedAt).getTime();
  const delay = Math.max(0, 15000 - elapsed);

  refreshHintTimer = setTimeout(() => {
    refreshHintTimer = null;
    // Re-check state — headers might have arrived
    const cc = captures[currentDomain];
    if (!cc || !cc.active || countHeaders(cc) > 0) return;
    if (document.getElementById('refreshHint')) return;

    const hint = document.createElement('div');
    hint.id = 'refreshHint';
    hint.className = 'refresh-hint';

    const text = document.createTextNode('No headers yet \u2014 ');
    const btn = document.createElement('button');
    btn.textContent = 'Refresh page';
    btn.addEventListener('click', () => {
      if (currentTabId) chrome.tabs.reload(currentTabId);
      hint.remove();
    });
    const tail = document.createTextNode(' to trigger new requests');

    hint.appendChild(text);
    hint.appendChild(btn);
    hint.appendChild(tail);
    statusEl.after(hint);
  }, delay);
}

function clearRefreshHintTimer() {
  if (refreshHintTimer) { clearTimeout(refreshHintTimer); refreshHintTimer = null; }
}

function createSiteCard(domain, capture) {
  const count = countHeaders(capture);
  const origins = countOrigins(capture);
  const expanded = expandedDomains.has(domain);
  const color = domainColor(domain);

  const card = document.createElement('div');
  card.className = 'site-card';

  // Header row
  const header = document.createElement('div');
  header.className = 'site-card-header';
  header.addEventListener('click', () => {
    if (expanded) expandedDomains.delete(domain);
    else expandedDomains.add(domain);
    render();
  });

  const left = document.createElement('div');
  left.className = 'site-card-left';

  const favicon = document.createElement('div');
  favicon.className = 'site-favicon';
  favicon.style.background = color + '18';
  favicon.style.color = color;
  favicon.textContent = domainInitials(domain);

  // Ready — add small green check badge in top-right corner
  if (count > 0 && !capture.active) {
    const badge = document.createElement('span');
    badge.className = 'favicon-badge';
    badge.insertAdjacentHTML('afterbegin', '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>');
    favicon.appendChild(badge);
  }

  const meta = document.createElement('div');
  meta.className = 'site-card-meta';

  const domName = document.createElement('div');
  domName.className = 'site-card-domain';
  domName.textContent = domain;

  const sub = document.createElement('div');
  sub.className = 'site-card-sub';
  const time = new Date(capture.capturedAt);
  const ago = formatAgo(time);
  const waiting = capture.active && count === 0;
  if (waiting) {
    sub.textContent = 'Waiting for headers\u2026';
  } else if (capture.active) {
    sub.textContent = count + ' header' + (count !== 1 ? 's' : '') + ' \u00B7 ' + origins + ' origin' + (origins !== 1 ? 's' : '') + ' \u00B7 capturing\u2026';
  } else {
    sub.textContent = count + ' header' + (count !== 1 ? 's' : '') + ' \u00B7 ' + origins + ' origin' + (origins !== 1 ? 's' : '') + ' \u00B7 ' + ago;
  }

  meta.appendChild(domName);
  meta.appendChild(sub);
  left.appendChild(favicon);
  left.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'site-card-actions';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-icon-sm';
  if (count === 0) {
    copyBtn.disabled = true;
    copyBtn.classList.add('waiting');
    copyBtn.title = 'Waiting for headers\u2026';
    copyBtn.insertAdjacentHTML('afterbegin', '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>');
  } else {
    copyBtn.classList.add('btn-copy');
    copyBtn.title = 'Copy ' + domain;
    copyBtn.insertAdjacentHTML('afterbegin', '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>');
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copySite(domain, copyBtn);
    });
  }

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'btn-icon-sm';
  delBtn.title = 'Remove';
  delBtn.insertAdjacentHTML('afterbegin', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (port) port.postMessage({ type: 'CLEAR_DOMAIN', domain });
  });

  actions.appendChild(copyBtn);
  actions.appendChild(delBtn);

  header.appendChild(left);
  header.appendChild(actions);
  card.appendChild(header);

  // Expanded body — grouped by origin domain
  if (expanded && count > 0) {
    const body = document.createElement('div');
    body.className = 'site-card-body';

    const isFullyExpanded = expandedOrigins.has(domain);
    const MAX_VISIBLE = 3;
    let rowCount = 0;
    let totalRows = 0;

    // First pass: count total rows
    for (const headers of Object.values(capture.headersByOrigin || {})) {
      totalRows += Object.keys(headers).length;
    }

    // Second pass: render (limited if not fully expanded)
    for (const [origin, headers] of Object.entries(capture.headersByOrigin || {})) {
      const headerKeys = Object.keys(headers);
      if (headerKeys.length === 0) continue;

      // Only show origin label if we still have budget or fully expanded
      if (!isFullyExpanded && rowCount >= MAX_VISIBLE) break;

      const originLabel = document.createElement('div');
      originLabel.className = 'origin-label';
      originLabel.textContent = origin;
      body.appendChild(originLabel);

      for (const key of headerKeys) {
        if (!isFullyExpanded && rowCount >= MAX_VISIBLE) break;

        const isResp = key.startsWith('response:');
        const displayName = isResp ? key.replace('response:', '') : key;

        const row = document.createElement('div');
        row.className = 'header-row';

        const name = document.createElement('span');
        name.className = 'header-row-name' + (isResp ? ' resp' : '');
        name.textContent = displayName;

        const val = document.createElement('span');
        val.className = 'header-row-value';
        val.textContent = maskValue(headers[key]);

        row.appendChild(name);
        row.appendChild(val);
        body.appendChild(row);
        rowCount++;
      }
    }

    // "Show more" button if there are hidden rows
    if (!isFullyExpanded && totalRows > MAX_VISIBLE) {
      const hidden = totalRows - MAX_VISIBLE;
      const showMore = document.createElement('button');
      showMore.className = 'show-more-btn';
      showMore.insertAdjacentHTML('afterbegin', '<span>Show ' + hidden + ' more</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>');
      showMore.addEventListener('click', (e) => {
        e.stopPropagation();
        expandedOrigins.add(domain);
        render();
      });
      body.appendChild(showMore);
    }

    card.appendChild(body);
  }

  return card;
}

// --- Helpers ---
function countHeaders(capture) {
  let total = 0;
  for (const headers of Object.values(capture.headersByOrigin || {})) {
    total += Object.keys(headers).length;
  }
  return total;
}

function countOrigins(capture) {
  return Object.keys(capture.headersByOrigin || {}).length;
}

function maskValue(value) {
  if (!value || value.length <= 12) return '\u2022'.repeat(8);
  return value.slice(0, 4) + '\u2022\u2022\u2022\u2022' + value.slice(-4);
}

function formatAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  return Math.floor(sec / 3600) + 'h ago';
}

// --- Timer ---
function startTimer(capturedAt) {
  stopTimer();
  const start = new Date(capturedAt).getTime();
  const update = () => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timerEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };
  update();
  timerInterval = setInterval(update, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  timerEl.textContent = '';
}

// --- Clipboard ---
function cleanOriginHeaders(headers) {
  const clean = {};
  for (const [key, value] of Object.entries(headers)) {
    const cleanKey = key.startsWith('response:') ? key.replace('response:', '') : key;
    if (!clean[cleanKey]) clean[cleanKey] = value;
  }
  return clean;
}

function buildPayload(tabDomain, capture) {
  const origins = {};
  for (const [origin, headers] of Object.entries(capture.headersByOrigin || {})) {
    const cleaned = cleanOriginHeaders(headers);
    if (Object.keys(cleaned).length > 0) origins[origin] = cleaned;
  }
  return {
    tab: tabDomain,
    capturedAt: capture.capturedAt,
    origins,
  };
}

async function copySite(domain, btn) {
  const c = captures[domain];
  if (!c || countHeaders(c) === 0) return;

  const payload = buildPayload(domain, c);
  await writeClipboard(JSON.stringify(payload, null, 2));
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 1500);
  showCopyOverlay(domain);
}

async function copyAll() {
  const sessions = [];
  for (const [domain, c] of Object.entries(captures)) {
    if (countHeaders(c) === 0) continue;
    sessions.push(buildPayload(domain, c));
  }
  if (sessions.length === 0) return;

  const payload = sessions.length === 1 ? sessions[0] : sessions;
  await writeClipboard(JSON.stringify(payload, null, 2));
  showCopyOverlay(sessions.length === 1 ? sessions[0].tab : sessions.length + ' sites');
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  if (port) port.postMessage({ type: 'SCHEDULE_CLIPBOARD_CLEAR' });
}

function showCaptureSuccess(domain, count) {
  const existing = document.querySelector('.copy-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'copy-overlay capture-success';
  overlay.insertAdjacentHTML('afterbegin', '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>');

  const text = document.createElement('span');
  text.textContent = count + ' header' + (count !== 1 ? 's' : '') + ' captured';
  overlay.appendChild(text);

  document.body.appendChild(overlay);
  overlay.addEventListener('animationend', () => overlay.remove());
}

function showCopyOverlay(label) {
  // Remove existing overlay
  const existing = document.querySelector('.copy-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'copy-overlay';
  overlay.insertAdjacentHTML('afterbegin', '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>');

  const text = document.createElement('span');
  text.textContent = 'Copied ' + label;
  overlay.appendChild(text);

  document.body.appendChild(overlay);
  overlay.addEventListener('animationend', () => overlay.remove());
}

// --- Settings ---
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get({ autoClearMinutes: 5, clipboardClearMinutes: 0.5 });
    settings = stored;
  } catch {}
  updatePrivacyLabel();
}

async function saveSettings() {
  try {
    await chrome.storage.local.set(settings);
  } catch {}
  if (port) port.postMessage({ type: 'SETTINGS_UPDATE', settings });
  updatePrivacyLabel();
}

function updatePrivacyLabel() {
  if (settings.autoClearMinutes === 0) {
    privacyClearLabel.textContent = 'Manual clear';
  } else {
    privacyClearLabel.textContent = 'Auto-clear ' + settings.autoClearMinutes + 'm';
  }
}

function toggleSettings() {
  const isOpen = !settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden');
  settingsBtn.classList.toggle('active', !isOpen);
}

function initSettingsOptions() {
  // Auto-clear options
  for (const btn of clearOptionsEl.querySelectorAll('.settings-opt')) {
    const val = Number(btn.dataset.value);
    if (val === settings.autoClearMinutes) btn.classList.add('active');
    btn.addEventListener('click', () => {
      for (const b of clearOptionsEl.querySelectorAll('.settings-opt')) b.classList.remove('active');
      btn.classList.add('active');
      settings.autoClearMinutes = val;
      saveSettings();
    });
  }

  // Clipboard clear options
  for (const btn of clipboardOptionsEl.querySelectorAll('.settings-opt')) {
    const val = Number(btn.dataset.value);
    if (val === settings.clipboardClearMinutes) btn.classList.add('active');
    btn.addEventListener('click', () => {
      for (const b of clipboardOptionsEl.querySelectorAll('.settings-opt')) b.classList.remove('active');
      btn.classList.add('active');
      settings.clipboardClearMinutes = val;
      saveSettings();
    });
  }
}

// --- Start ---
init();
