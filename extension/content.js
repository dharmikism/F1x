(function () {
  if (window.top !== window.self) return;

  const state = { lookupTimer: null, memory: null, memoryQuery: "", overlay: null, toast: null, bypassNext: false, replayEvents: 0, submitCheckInFlight: false, lastSendButton: null, autoCaptureEnabled: false, autoObserver: null, captureTimer: null, captureProblem: "", captureKey: "", lastAssistantReply: "", captureNoticeShown: false, captureInFlight: false, captureQueued: false };
  const source = location.hostname.includes("claude") ? "Claude" : "ChatGPT";
  const normalize = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

  function isPromptElement(element) {
    if (!element || !(element instanceof HTMLElement)) return false;
    if (element.closest(".fixonce-overlay-host")) return false;
    if (element.matches("textarea")) return true;
    return element.isContentEditable || Boolean(element.closest("[contenteditable='true']"));
  }
  function promptElement(eventTarget) {
    if (isPromptElement(eventTarget)) return eventTarget.closest("[contenteditable='true']") || eventTarget;
    const active = document.activeElement;
    if (isPromptElement(active)) return active.closest("[contenteditable='true']") || active;
    return [...document.querySelectorAll("textarea, [contenteditable='true']")].find((candidate) => isPromptElement(candidate)) || null;
  }
  function readPrompt(element = promptElement()) { if (!element) return ""; return String("value" in element ? element.value : element.innerText || element.textContent || "").trim(); }
  function sendMessage(message) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        if (typeof chrome === "undefined" || !chrome.runtime?.id) { finish({ ok: false, error: "The extension was reloaded. Refresh this tab." }); return; }
        const pending = chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          finish(runtimeError ? { ok: false, error: runtimeError.message } : (response || { ok: false, error: "No response from FixOnce." }));
        });
        pending?.catch((error) => finish({ ok: false, error: error?.message || "The extension context is unavailable." }));
      } catch (error) {
        finish({ ok: false, error: error?.message || "The extension context is unavailable." });
      }
    });
  }
  function closeOverlay() { if (state.overlay) state.overlay.remove(); state.overlay = null; }
  function makeHost() { const host = document.createElement("div"); host.className = "fixonce-overlay-host"; document.documentElement.appendChild(host); return host; }
  function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[character])); }
  async function copyText(value) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(value || ""));
        return true;
      }
    } catch (error) {
      // Fall through to the legacy copy path when the page denies clipboard access.
    }
    const area = document.createElement("textarea");
    area.value = String(value || ""); area.setAttribute("readonly", "");
    area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.focus(); area.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
    area.remove();
    return copied;
  }
  function addCopyButton(host, solution) {
    const solutionBox = host.querySelector(".fixonce-solution");
    if (!solutionBox) return;
    const button = document.createElement("button");
    button.type = "button"; button.className = "fixonce-copy"; button.textContent = "Copy solution";
    button.addEventListener("click", async () => {
      button.disabled = true; button.textContent = "Copying…";
      const copied = await copyText(solution);
      button.disabled = false; button.textContent = copied ? "Copied solution" : "Select the text manually";
      if (copied) setTimeout(() => { if (button.isConnected) button.textContent = "Copy solution"; }, 1800);
    });
    solutionBox.after(button);
  }

  function assistantReplyText() {
    const selectors = [
      "[data-message-author-role='assistant']",
      "[data-testid='conversation-turn-assistant']",
      "[data-testid='assistant-message']",
      "[data-testid*='assistant']",
      "[data-is-streaming]",
      "[class*='assistant-message']",
      ".assistant-turn",
      ".font-claude-message",
    ];
    const candidates = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter((node) => !node.closest(".fixonce-overlay-host") && node.innerText?.trim());
    const nodes = candidates
      .filter((node) => !candidates.some((other) => other !== node && other.contains(node)))
      .sort((first, second) => first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const latest = nodes[nodes.length - 1];
    return latest?.innerText?.trim() || "";
  }

  function captureConversationKey() {
    const route = location.pathname.match(/\/(?:c|chat|conversation)\/([^/]+)/i)?.[1] || location.pathname || "/";
    const value = `${source}|${location.hostname}|${route}`;
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `fixonce:${source.toLowerCase()}:${hash >>> 0}`;
  }

  function rememberCaptureProblem(problem) {
    state.captureProblem = problem;
    state.captureKey = captureConversationKey();
    state.lastAssistantReply = assistantReplyText();
    state.captureNoticeShown = false;
  }

  function scheduleAutoCapture() {
    if (!state.autoCaptureEnabled || !state.captureProblem) return;
    if (state.captureTimer) clearTimeout(state.captureTimer);
    state.captureTimer = setTimeout(async () => {
      state.captureTimer = null;
      const reply = assistantReplyText();
      if (reply.length < 10 || reply === state.lastAssistantReply) return;
      state.lastAssistantReply = reply;
      state.captureKey = captureConversationKey();
      if (state.captureInFlight) {
        state.captureQueued = true;
        return;
      }
      state.captureInFlight = true;
      try {
        const response = await sendMessage({ type: "AUTO_CAPTURE_SOLUTION", problem: state.captureProblem, solution: reply, captureKey: state.captureKey, source });
        if (response?.ok && response.result?.result_type === "new" && !state.captureNoticeShown) {
          state.captureNoticeShown = true;
          showToast("Latest AI reply saved as a private draft. Open FixOnce to verify it before sharing.", "AUTO-SAVED DRAFT");
        }
      } finally {
        state.captureInFlight = false;
        if (state.captureQueued && state.autoCaptureEnabled) {
          state.captureQueued = false;
          scheduleAutoCapture();
        }
      }
    }, 1200);
  }

  function setAutoCaptureEnabled(enabled) {
    state.autoCaptureEnabled = Boolean(enabled);
    if (state.autoCaptureEnabled) {
      if (!state.autoObserver && document.body) {
        state.autoObserver = new MutationObserver(scheduleAutoCapture);
        state.autoObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
      scheduleAutoCapture();
    } else {
      state.autoObserver?.disconnect();
      state.autoObserver = null;
      if (state.captureTimer) clearTimeout(state.captureTimer);
      state.captureTimer = null;
      state.captureQueued = false;
    }
  }

  function loadAutoCaptureSetting() {
    try {
      chrome.storage.sync.get({ autoCaptureEnabled: true }, (settings) => setAutoCaptureEnabled(settings.autoCaptureEnabled));
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes.autoCaptureEnabled) setAutoCaptureEnabled(changes.autoCaptureEnabled.newValue);
      });
    } catch (error) {
      setAutoCaptureEnabled(false);
    }
  }

  function showToast(message, title = "FIXONCE") {
    if (state.toast) state.toast.remove();
    const host = makeHost(); state.toast = host;
    const toast = document.createElement("div"); toast.className = "fixonce-toast"; toast.innerHTML = `<b>${title}</b>${message}`; host.appendChild(toast);
    setTimeout(() => { if (state.toast === host) { host.remove(); state.toast = null; } }, 5000);
  }

  function showAlternative(result) {
    if (!state.overlay) return;
    state.overlay.innerHTML = `<section class="fixonce-panel fixonce-new"><div class="fixonce-panel-head"><span>↻ ALTERNATIVE FIX</span><button class="fixonce-close" data-fixonce-close aria-label="Close">×</button></div><h2>A second path for this problem</h2><p>Featherless generated a separate playbook after the first fix did not work.</p><div class="fixonce-solution">${escapeHtml(result.suggestion)}</div><div class="fixonce-meta"><span>${escapeHtml(result.provider)}</span><span>${result.latency_ms || "—"} ms</span></div><div class="fixonce-actions"><button class="fixonce-primary" data-fixonce-close>Use this fix</button></div><div class="fixonce-foot">Open the FixOnce popup after testing to verify and optionally share this draft.</div></section>`;
    addCopyButton(state.overlay, result.suggestion);
  }

  function showAlternativeForm(result) {
    if (!state.overlay) return;
    state.overlay.innerHTML = `<section class="fixonce-panel fixonce-new"><div class="fixonce-panel-head"><span>ALTERNATIVE FIX</span><button class="fixonce-close" data-fixonce-close aria-label="Close">×</button></div><h2>What failed on this device?</h2><p>Featherless will use this note to generate a different structured playbook.</p><textarea class="fixonce-note" rows="3" placeholder="Example: DNS still timed out after reconnecting."></textarea><div class="fixonce-actions"><button class="fixonce-primary" data-fixonce-generate>Generate another fix</button><button class="fixonce-secondary" data-fixonce-close>Cancel</button></div></section>`;
    state.overlay.querySelector(".fixonce-note")?.focus();
  }

  function showKnown(result) {
    closeOverlay(); const host = makeHost(); state.overlay = host; const item = result.knowledge;
    host.innerHTML = `<section class="fixonce-panel"><div class="fixonce-panel-head"><span>✓ KNOWN FIX FOUND</span><button class="fixonce-close" data-fixonce-close aria-label="Close">×</button></div><h2>Before you send this to ${source}</h2><p>Someone in your community already solved this underlying problem.</p><div class="fixonce-solution">${escapeHtml(item.solution)}</div><div class="fixonce-meta"><span>✓ ${item.verification_count} verifications</span><span>${result.search_latency_ms} ms lookup</span><span>AI not required</span></div><div class="fixonce-actions"><button class="fixonce-primary" data-fixonce-close>Use known fix</button><button class="fixonce-secondary" data-fixonce-alternative>I need another fix</button><button class="fixonce-secondary" data-fixonce-continue>Continue to ${source}</button></div><div class="fixonce-foot">Your prompt stays in ${source} unless you choose to send it.</div></section>`;
    addCopyButton(host, item.solution);
    const alternativeButton = host.querySelector("[data-fixonce-alternative]");
    if (alternativeButton) alternativeButton.textContent = "Ask Featherless for another fix";
    const useButton = host.querySelector(".fixonce-primary");
    if (useButton) { useButton.removeAttribute("data-fixonce-close"); useButton.dataset.fixonceUse = "true"; useButton.textContent = "Copy & use known fix"; }
    host.addEventListener("click", async (event) => {
      if (event.target.closest("[data-fixonce-use]")) {
        const copied = await copyText(item.solution);
        if (copied) closeOverlay();
        showToast(copied ? "The known solution was copied to your clipboard." : "Use the Copy solution button or select the text manually.", copied ? "SOLUTION COPIED" : "COPY UNAVAILABLE");
        return;
      }
      if (event.target.closest("[data-fixonce-close]")) closeOverlay();
      if (event.target.closest("[data-fixonce-continue]")) { state.bypassNext = true; closeOverlay(); const button = state.lastSendButton || findSendButton(); if (button) button.click(); else showToast("Close this notice and press Send once to continue.", "CONTINUE NORMALLY"); }
      if (event.target.closest("[data-fixonce-alternative]")) showAlternativeForm(result);
      if (event.target.closest("[data-fixonce-generate]")) {
        const button = event.target.closest("[data-fixonce-generate]"); const note = host.querySelector(".fixonce-note")?.value.trim() || "The previous fix did not solve the problem on this device.";
        button.disabled = true; button.textContent = "Generating another fix…";
        const response = await sendMessage({ type: "GENERATE_ALTERNATIVE", knowledgeId: item.id, problem: result.problem, note });
        if (response?.ok) showAlternative(response.result); else { button.disabled = false; button.textContent = "Try again"; showToast(response?.error || "The alternative fix could not be generated.", "FIXONCE ERROR"); }
      }
    });
  }

  function findSendButton() {
    const candidates = [...document.querySelectorAll("button")];
    return candidates.find((button) => { const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.dataset.testid || ""}`.toLowerCase(); return /send|submit/.test(label) && !button.disabled; }) || null;
  }

  async function lookup(problem) {
    const response = await sendMessage({ type: "CHECK_MEMORY", problem });
    if (!response?.ok || normalize(readPrompt()) !== normalize(problem)) return;
    state.memory = response.result; state.memoryQuery = problem;
    if (response.result.result_type === "known") showKnown(response.result);
  }
  function scheduleLookup(problem) {
    if (state.overlay?.querySelector(".fixonce-note") && state.overlay.contains(document.activeElement)) return;
    closeOverlay(); state.memory = null; state.memoryQuery = "";
    if (state.lookupTimer) clearTimeout(state.lookupTimer);
    if (problem.length < 12) return;
    state.lookupTimer = setTimeout(() => lookup(problem), 450);
  }
  function rememberPending(problem) { sendMessage({ type: "SET_PENDING", problem, source }); showToast("No known fix found — your request will continue normally. After the answer, open FixOnce and choose Save an AI answer.", "NEW PROBLEM"); }
  function replayOriginalSend(event) {
    state.replayEvents = event.type === "submit" ? 1 : 2;
    if (event.type === "submit" && typeof event.target?.requestSubmit === "function") {
      event.target.requestSubmit();
      return;
    }
    const button = state.lastSendButton || findSendButton();
    if (button) {
      button.click();
      return;
    }
    state.replayEvents = 0;
    showToast("Close this notice and press Send once to continue.", "CONTINUE NORMALLY");
  }
  async function checkBeforeSubmit(event, element, problem) {
    state.submitCheckInFlight = true;
    const response = await sendMessage({ type: "CHECK_MEMORY", problem });
    state.submitCheckInFlight = false;
    if (normalize(readPrompt(element)) !== normalize(problem)) return;
    if (response?.ok) {
      state.memory = response.result;
      state.memoryQuery = problem;
      if (response.result.result_type === "known") {
        showKnown(response.result);
        return;
      }
    }
    rememberPending(problem);
    replayOriginalSend(event);
  }
  function handleSubmit(event, element) {
    if (state.replayEvents > 0) { state.replayEvents -= 1; return; }
    const problem = readPrompt(element); if (!problem) return;
    if (state.submitCheckInFlight) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    rememberCaptureProblem(problem); if (state.bypassNext) { state.bypassNext = false; return; }
    state.lastSendButton = event.type === "click" ? event.target.closest("button") : findSendButton();
    if (problem.length >= 12) {
      event.preventDefault(); event.stopImmediatePropagation(); checkBeforeSubmit(event, element, problem);
      return;
    }
    rememberPending(problem);
  }

  document.addEventListener("input", (event) => { if (event.target?.closest?.(".fixonce-overlay-host")) return; if (isPromptElement(event.target)) scheduleLookup(readPrompt(event.target)); }, true);
  document.addEventListener("keydown", (event) => { if (event.target?.closest?.(".fixonce-overlay-host")) return; if (event.key === "Enter" && !event.shiftKey && isPromptElement(event.target)) handleSubmit(event, event.target); }, true);
  document.addEventListener("click", (event) => { const button = event.target.closest?.("button"); if (!button) return; const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.dataset.testid || ""}`.toLowerCase(); if (/send|submit/.test(label)) handleSubmit(event, promptElement()); }, true);
  document.addEventListener("submit", (event) => { if (event.target?.closest?.(".fixonce-overlay-host")) return; const element = promptElement(); if (element) handleSubmit(event, element); }, true);
  loadAutoCaptureSetting();
})();
