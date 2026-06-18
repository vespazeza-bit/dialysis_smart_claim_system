// Inject extension ID into the host page via a DOM attribute so the
// main app can discover and communicate with this extension.
document.documentElement.setAttribute('data-dmis-ext-id', chrome.runtime.id);
