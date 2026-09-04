(function () {
  if (window.top !== window.self) return;

  const state = { lookupTimer: null, memory: null, memoryQuery: "", overlay: null, toast: null, bypassNext: false, lastSendButton: null };
  const source = location.hostname.includes("claude") ? "Claude" : "ChatGPT";
  const normalize = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

  function isPromptElement(element) {
    if (!element || !(element instanceof HTMLElement)) return false;
    if (element.matches("textarea")) return true;
    return element.isContentEditable || Boolean(element.closest("[contenteditable='true']"));
  }

  function promptElement(eventTarget) {
    if (isPromptElement(eventTarget)) return eventTarget.closest("[contenteditable='true']") || eventTarget;
    const active = document.activeElement;
    if (isPromptElement(active)) return active.closest("[contenteditable='true']") || active;
    return document.querySelector("textarea, [contenteditable='true']");
  }

  function readPrompt(element = promptElement()) {
    if (!element) return "";
    return String("value" in element ? element.value : element.innerText || element.textContent || "").trim();
  }

  function sendMessage(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
  }

  function closeOverlay() {
    if (state.overlay) state.overlay.remove();
    state.overlay = null;
  }

  function makeHost() {
    const host = document.createElement("div"); host.className = "fixonce-overlay-host"; document.documentElement.appendChild(host); return host;
  }

  function showToast(message, title = "FIXONCE") {
    if (state.toast) state.toast.remove();
    const host = makeHost(); state.toast = host; const toast = document.createElement("div"); toast.className = "fixonce-toast"; toast.innerHTML = `<b>${title}</b>${message}`; host.appendChild(toast);
    setTimeout(() => { if (state.toast === host) { host.remove(); state.toast = null; } }, 5000);
  }

  function showKnown(result) {
    closeOverlay();
    const host = makeHost(); state.overlay = host;
    const item = result.knowledge;
    host.innerHTML = `<section class="fixonce-panel"><div class="fixonce-panel-head"><span>✓ KNOWN FIX FOUND</span><button class="fixonce-close" data-fixonce-close aria-label="Close">×</button></div><h2>Before you send this to ${source}</h2><p>Someone in your community already solved this underlying problem.</p><div class="fixonce-solution">${escapeHtml(item.solution)}</div><div class="fixonce-meta"><span>✓ ${item.verification_count} verifications</span><span>${result.search_latency_ms} ms lookup</span><span>AI not required</span></div><div class="fixonce-actions"><button class="fixonce-primary" data-fixonce-close>Use known fix</button><button class="fixonce-secondary" data-fixonce-continue>Continue to ${source}</button></div><div class="fixonce-foot">Your prompt stays in ${source} unless you choose to send it.</div></section>`;
    host.addEventListener("click", (event) => {
      if (event.target.closest("[data-fixonce-close]")) closeOverlay();
      if (event.target.closest("[data-fixonce-continue]")) { state.bypassNext = true; closeOverlay(); const button = state.lastSendButton || findSendButton(); if (button) button.click(); else showToast("Close this notice and press Send once to continue.", "CONTINUE NORMALLY"); }
    });
  }

  function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[character])); }

  function findSendButton() {
    const candidates = [...document.querySelectorAll("button")];
    return candidates.find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.dataset.testid || ""}`.toLowerCase();
      return /send|submit/.test(label) && !button.disabled;
    }) || null;
  }

  async function lookup(problem) {
    const response = await sendMessage({ type: "CHECK_MEMORY", problem });
    if (!response?.ok) return;
    if (normalize(readPrompt()) !== normalize(problem)) return;
    state.memory = response.result; state.memoryQuery = problem;
    if (response.result.result_type === "known") showKnown(response.result);
  }

  function scheduleLookup(problem) {
    closeOverlay();
    state.memory = null; state.memoryQuery = "";
    if (state.lookupTimer) clearTimeout(state.lookupTimer);
    if (problem.length < 12) return;
    state.lookupTimer = setTimeout(() => lookup(problem), 450);
  }

  function rememberPending(problem) {
    sendMessage({ type: "SET_PENDING", problem, source });
    showToast("No known fix found — your request will continue normally. After the answer, open FixOnce and choose Save an AI answer.", "NEW PROBLEM");
  }

  function handleSubmit(event, element) {
    const problem = readPrompt(element); if (!problem) return;
    if (state.bypassNext) { state.bypassNext = false; return; }
    const sameQuery = state.memory && normalize(state.memoryQuery) === normalize(problem);
    state.lastSendButton = event.type === "click" ? event.target.closest("button") : findSendButton();
    if (sameQuery && state.memory.result_type === "known") {
      event.preventDefault(); event.stopImmediatePropagation(); showKnown(state.memory); return;
    }
    rememberPending(problem);
  }

  document.addEventListener("input", (event) => { if (isPromptElement(event.target)) scheduleLookup(readPrompt(event.target)); }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && isPromptElement(event.target)) handleSubmit(event, event.target); }, true);
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("button"); if (!button) return;
    const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.dataset.testid || ""}`.toLowerCase();
    if (/send|submit/.test(label)) handleSubmit(event, promptElement());
  }, true);
  document.addEventListener("submit", (event) => { const element = promptElement(); if (element) handleSubmit(event, element); }, true);
})();

