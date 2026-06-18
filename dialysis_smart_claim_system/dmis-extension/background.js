// DMIS Auto Fill - Background Service Worker
// Handles external messages from HD Registry and routes to content scripts

const DMIS_URL_PATTERN = /ucapps4\.nhso\.go\.th\/disease2.*mainDisease/;
const EXTENSION_ID = chrome.runtime.id;

// Store pending data to fill
let pendingData = null;
let fillStatus = { total: 0, current: 0, completed: 0, errors: [] };

// Listen for external messages from HD Registry web page
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ success: true, version: '1.0.0' });
    return true;
  }

  if (request.action === 'fillDMIS') {
    const data = request.data;
    if (!data || !Array.isArray(data) || data.length === 0) {
      sendResponse({ success: false, error: 'No data provided' });
      return true;
    }

    pendingData = data;
    fillStatus = { total: data.length, current: 0, completed: 0, errors: [] };

    // Find or open DMIS tab
    findOrOpenDMISTab()
      .then(tab => {
        // Inject content script and send data
        return injectAndFill(tab.id, data);
      })
      .then(result => {
        sendResponse({ success: true, result });
      })
      .catch(err => {
        console.error('DMIS Auto Fill error:', err);
        sendResponse({ success: false, error: err.message });
      });

    return true; // Keep message channel open for async
  }

  if (request.action === 'getStatus') {
    sendResponse({ success: true, status: fillStatus });
    return true;
  }

  return false;
});

// Listen for internal messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateStatus') {
    fillStatus = { ...fillStatus, ...request.status };
    // Broadcast to popup if open
    chrome.runtime.sendMessage({ action: 'statusChanged', status: fillStatus }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'getNextPatient') {
    if (pendingData && fillStatus.current < pendingData.length) {
      const patient = pendingData[fillStatus.current];
      fillStatus.current++;
      sendResponse({ success: true, patient, index: fillStatus.current, total: fillStatus.total });
    } else {
      sendResponse({ success: false, error: 'No more patients' });
    }
    return true;
  }

  if (request.action === 'markCompleted') {
    fillStatus.completed++;
    chrome.runtime.sendMessage({ action: 'statusChanged', status: fillStatus }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'markError') {
    fillStatus.errors.push(request.error);
    chrome.runtime.sendMessage({ action: 'statusChanged', status: fillStatus }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  return false;
});

async function findOrOpenDMISTab() {
  const tabs = await chrome.tabs.query({ url: 'https://ucapps4.nhso.go.th/disease2*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0];
  }

  // Also check for the IEability extension wrapper
  const allTabs = await chrome.tabs.query({});
  const dmisTab = allTabs.find(t => t.url && DMIS_URL_PATTERN.test(t.url));
  if (dmisTab) {
    await chrome.tabs.update(dmisTab.id, { active: true });
    await chrome.windows.update(dmisTab.windowId, { focused: true });
    return dmisTab;
  }

  // Open DMIS login page
  const newTab = await chrome.tabs.create({
    url: 'https://iam.nhso.go.th/realms/nhso/protocol/openid-connect/auth?client_id=ucapps4&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fucapps4.nhso.go.th%2Fdisease2ckd%2FossOpen',
    active: true
  });
  return newTab;
}

async function injectAndFill(tabId, data) {
  // Wait a bit for page to be ready
  await new Promise(r => setTimeout(r, 1500));

  try {
    // Inject content script
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });

    // Send data to content script
    await chrome.tabs.sendMessage(tabId, {
      action: 'startFilling',
      data: data
    });

    return { message: `Started filling ${data.length} patient(s)`, tabId };
  } catch (err) {
    // If content script is already injected, just send message
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: 'startFilling',
        data: data
      });
      return { message: `Started filling ${data.length} patient(s)`, tabId };
    } catch (err2) {
      throw new Error('Failed to inject or communicate with content script: ' + err2.message);
    }
  }
}

// Handle tab updates to detect DMIS page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && DMIS_URL_PATTERN.test(tab.url)) {
    // DMIS page loaded, could auto-inject if needed
    if (pendingData && fillStatus.current < fillStatus.total) {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      }).catch(() => {});
    }
  }
});
