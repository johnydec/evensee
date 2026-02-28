// Offscreen document — clipboard operations only
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CLEAR_CLIPBOARD') {
    navigator.clipboard.writeText('').catch(() => {});
  }
});
