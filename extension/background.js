chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "fixonce-selection", title: "Find FixOnce solution", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "fixonce-selection" && info.selectionText) {
    chrome.storage.local.set({ selectedProblem: info.selectionText });
  }
});

function getApiBase() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ apiBaseUrl: "http://localhost:8000" }, (data) => {
      resolve(String(data.apiBaseUrl || "http://localhost:8000").replace(/\/$/, ""));
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CHECK_MEMORY") {
    (async () => {
      try {
        const base = await getApiBase();
        const response = await fetch(`${base}/api/search-memory`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problem: String(message.problem || "").trim() }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.detail || "FixOnce lookup failed.");
        sendResponse({ ok: true, result: body });
      } catch (error) {
        sendResponse({ ok: false, error: "FixOnce is unavailable right now." });
      }
    })();
    return true;
  }
  if (message?.type === "SET_PENDING") {
    chrome.storage.local.set({
      pendingProblem: String(message.problem || ""),
      pendingSource: String(message.source || "ChatGPT or Claude"),
    });
    sendResponse({ ok: true });
  }
  if (message?.type === "AUTO_CAPTURE_SOLUTION") {
    (async () => {
      try {
        const base = await getApiBase();
        const response = await fetch(`${base}/api/knowledge/auto-save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            problem: String(message.problem || "").trim(),
            solution: String(message.solution || "").trim(),
            capture_key: String(message.captureKey || "").trim(),
            source: String(message.source || "Automatically captured from ChatGPT or Claude"),
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.detail || "Automatic save failed.");
        if (body.result_type === "new") await chrome.storage.local.set({ pendingAutoCapture: body });
        sendResponse({ ok: true, result: body });
      } catch (error) {
        sendResponse({ ok: false, error: "Automatic saving is unavailable right now." });
      }
    })();
    return true;
  }
  if (message?.type === "GENERATE_ALTERNATIVE") {
    (async () => {
      try {
        const base = await getApiBase();
        const response = await fetch(`${base}/api/knowledge/${Number(message.knowledgeId)}/alternative`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problem: String(message.problem || ""), note: String(message.note || "") }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.detail || "Alternative fix failed.");
        await chrome.storage.local.set({ pendingAlternativeResult: body });
        sendResponse({ ok: true, result: body });
      } catch (error) {
        sendResponse({ ok: false, error: "The alternative fix could not be generated." });
      }
    })();
    return true;
  }
});

