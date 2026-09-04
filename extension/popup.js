const $ = (selector) => document.querySelector(selector);
const defaultApi = (window.FIXONCE_DEFAULT_API || "http://localhost:8000").replace(/\/$/, "");
const getApiBase = () => new Promise((resolve) => chrome.storage.sync.get({ apiBaseUrl: defaultApi }, (data) => resolve(String(data.apiBaseUrl || defaultApi).replace(/\/$/, ""))));
const api = async (path, options = {}) => {
  const response = await fetch(`${await getApiBase()}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "FixOnce is unavailable.");
  return body;
};
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[character]));
let current = null;

function showSearch() { $("#save-view").hidden = true; $("#search-view").hidden = false; $("#popup-result").hidden = true; }
function showSave() { $("#search-view").hidden = true; $("#popup-result").hidden = true; $("#save-view").hidden = false; }

function showResult(result) {
  current = result; $("#search-view").hidden = true; $("#save-view").hidden = true; const region = $("#popup-result"); region.hidden = false;
  if (result.result_type === "known") {
    const item = result.knowledge;
    region.innerHTML = `<div class="popup-status">✓ KNOWN FIX FOUND</div><h2 class="popup-result-title">Previously solved by your community</h2><p class="popup-problem">${esc(result.problem)}</p><div class="popup-solution">${esc(item.solution)}</div><div class="popup-facts"><span class="popup-fact">✓ ${item.verification_count} verifications</span><span class="popup-fact">${result.latency_ms} ms</span><span class="popup-fact">AI not required</span></div><div class="popup-actions"><button class="popup-primary" data-helpful="true" data-id="${item.id}">✓ This fixed it</button><button class="popup-ghost" data-alternative="true" data-id="${item.id}">I need another fix</button></div><button class="back-button" data-back="true">← New problem</button>`;
  } else {
    const title = result.result_type === "blocked" ? "Kept out of community memory" : result.alternative ? "Alternative fix" : "Suggested fix";
    const status = result.result_type === "blocked" ? "! PRIVATE / TIME-SENSITIVE" : result.alternative ? "↻ ALTERNATIVE FIX" : "+ NEW PROBLEM";
    region.innerHTML = `<div class="popup-status" style="color:${result.result_type === "blocked" ? "var(--warm)" : "var(--purple)"}">${status}</div><h2 class="popup-result-title">${title}</h2><p class="popup-problem">${esc(result.problem)}</p><div class="popup-solution">${esc(result.suggestion)}</div><div class="popup-facts"><span class="popup-fact purple">${esc(result.provider)}</span><span class="popup-fact purple">${result.latency_ms || "—"} ms total</span></div>${result.result_type === "blocked" ? `<div class="popup-verify" style="border-color:#604c36;background:#30261f"><strong>Privacy guardrail</strong><span>${esc(result.safety.reason || "This request is not reusable.")}</span></div>` : `<div class="popup-verify" id="popup-verify"><strong>Did this solve the problem?</strong><span>Verify it before sharing. Sharing is always optional.</span><div class="popup-share"><button data-verify="true" data-id="${result.draft_id}">✓ Yes, it worked</button><button class="popup-ghost" data-verify="false" data-id="${result.draft_id}">No</button></div></div>`}<button class="back-button" data-back="true">← New problem</button>`;
  }
}

function showVerification(id) {
  $("#popup-verify").innerHTML = `<strong>✓ Solution verified</strong><span>Share it so the next person can skip the rediscovery step.</span><div class="popup-share"><button data-share="true" data-id="${id}">Share with community</button><button class="popup-ghost" data-share="false">Keep private</button></div>`;
}

function showAlternativePrompt(id) {
  $("#popup-result").insertAdjacentHTML("afterbegin", `<div class="popup-verify" id="popup-alternative"><strong>Build another path</strong><span>Tell Featherless what failed on this device.</span><textarea id="alternative-note" rows="2" placeholder="Example: DNS still timed out after reconnecting."></textarea><div class="popup-share"><button data-generate-alternative="true" data-id="${id}">Generate alternative fix</button><button class="popup-ghost" data-cancel-alternative="true">Cancel</button></div></div>`);
}

$("#popup-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const problem = $("#popup-problem").value.trim(); if (!problem) return;
  const button = $("#popup-submit"); button.disabled = true; button.textContent = "Searching community memory…";
  try { showResult(await api("/api/find-fix", { method: "POST", body: JSON.stringify({ problem }) })); }
  catch (error) { $("#search-view").hidden = true; $("#popup-result").hidden = false; $("#popup-result").innerHTML = `<div class="popup-error">${esc(error.message)}</div><button class="back-button" data-back="true">← Try again</button>`; }
  finally { button.disabled = false; button.innerHTML = '⌕ &nbsp; Find known fix <strong>↗</strong>'; }
});

$("#save-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const problem = $("#save-problem").value.trim(); const solution = $("#save-solution").value.trim(); if (!problem || !solution) return;
  const button = $("#save-submit"); button.disabled = true; button.textContent = "Saving private draft…";
  try { showResult(await api("/api/knowledge/save", { method: "POST", body: JSON.stringify({ problem, solution, source: "User saved from ChatGPT or Claude" }) })); }
  catch (error) { $("#save-view").insertAdjacentHTML("afterbegin", `<div class="popup-error">${esc(error.message)}</div>`); }
  finally { button.disabled = false; button.innerHTML = 'Save as private draft <strong>↗</strong>'; }
});

$("#popup-result").addEventListener("click", async (event) => {
  const button = event.target.closest("button"); if (!button) return;
  try {
    if (button.dataset.back) { showSearch(); return; }
    if (button.dataset.helpful) { await api(`/api/knowledge/${button.dataset.id}/feedback`, { method: "POST", body: JSON.stringify({ helpful: button.dataset.helpful === "true" }) }); button.textContent = "✓ Saved"; button.disabled = true; return; }
    if (button.dataset.alternative) { showAlternativePrompt(button.dataset.id); button.disabled = true; return; }
    if (button.dataset.cancelAlternative) { button.closest("#popup-alternative")?.remove(); return; }
    if (button.dataset.generateAlternative) { const note = $("#alternative-note")?.value.trim() || "The previous fix did not solve the problem on this device."; button.disabled = true; button.textContent = "Generating…"; const result = await api(`/api/knowledge/${button.dataset.id}/alternative`, { method: "POST", body: JSON.stringify({ problem: current?.problem || "", note }) }); showResult(result); return; }
    if (button.dataset.verify) { const solved = button.dataset.verify === "true"; await api(`/api/knowledge/${button.dataset.id}/verify`, { method: "POST", body: JSON.stringify({ solved }) }); if (solved) showVerification(button.dataset.id); else { button.textContent = "Kept private"; button.disabled = true; } return; }
    if (button.dataset.share) { if (button.dataset.share === "true") { await api(`/api/knowledge/${button.dataset.id}/share`, { method: "POST" }); $("#popup-verify").innerHTML = '<div class="verified-note">✓ Added to Community Memory</div>'; } else { button.textContent = "Kept private"; button.disabled = true; } }
  } catch (error) { const message = document.createElement("div"); message.className = "popup-error"; message.textContent = error.message; $("#popup-result").prepend(message); }
});

$("#save-answer-link").addEventListener("click", () => showSave()); $("#save-back").addEventListener("click", () => showSearch());
chrome.storage?.local?.get(["pendingProblem", "pendingSource", "pendingAlternativeResult"], (data) => { if (data?.pendingAlternativeResult) { showResult(data.pendingAlternativeResult); chrome.storage.local.remove("pendingAlternativeResult"); } else if (data?.pendingProblem) { $("#save-problem").value = data.pendingProblem; showSave(); chrome.storage.local.remove(["pendingProblem", "pendingSource"]); } });
