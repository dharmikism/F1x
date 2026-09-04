const state = { knowledge: [], stats: null, current: null };
const $ = (selector) => document.querySelector(selector);
const formatApiError = (detail, fallback) => {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      const location = Array.isArray(item?.loc) ? item.loc.filter((part) => part !== "body").join(".") : "";
      const message = item?.msg || "Invalid value";
      return location ? `${location}: ${message}` : message;
    }).filter(Boolean);
    if (messages.length) return messages.join(" ");
  }
  if (detail && typeof detail === "object") return detail.message || detail.error || fallback;
  return fallback;
};
const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatApiError(body.detail, "The FixOnce service is unavailable."));
  return body;
};
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
const toast = (message, error = false) => { const item = document.createElement("div"); item.className = `toast${error ? " error" : ""}`; item.textContent = message; $("#toast-region").appendChild(item); setTimeout(() => item.remove(), 3500); };
const solutionText = (text) => escapeHtml(text).replace(/\n/g, "<br>");

function updateMetrics(stats) {
  state.stats = stats;
  $("#metric-solved").textContent = stats.problems_solved.toLocaleString();
  $("#metric-fixes").textContent = stats.verified_fixes.toLocaleString();
  $("#metric-reused").textContent = stats.reuse_events.toLocaleString();
  $("#metric-avoided").textContent = stats.ai_generations_avoided.toLocaleString();
  $("#signal-fixes").textContent = stats.verified_fixes.toLocaleString();
  $("#hit-rate").textContent = `${stats.hit_rate}%`;
  $("#cache-latency").textContent = `${stats.avg_cache_latency_ms || "—"} ms`;
  $("#ai-latency").textContent = `${stats.avg_fresh_ai_latency_ms || "—"} ms`;
  const cacheWidth = Math.min(100, Math.max(5, (stats.avg_cache_latency_ms || 40) / Math.max(stats.avg_fresh_ai_latency_ms || 300, 1) * 100));
  $("#cache-bar").style.width = `${cacheWidth}%`; $("#ai-bar").style.width = "100%";
}

function renderKnowledge(items = state.knowledge) {
  const query = $("#knowledge-search").value.toLowerCase().trim();
  const filtered = items.filter(item => `${item.problem} ${item.category} ${item.solution}`.toLowerCase().includes(query));
  if (!filtered.length) { $("#knowledge-list").innerHTML = `<div class="loading-line">No shared fixes match that search.</div>`; return; }
  $("#knowledge-list").innerHTML = filtered.slice(0, 7).map(item => `
    <div class="knowledge-row">
      <div class="knowledge-problem"><span class="knowledge-icon">${item.category === "developer tools" ? "⌘" : item.category === "hackathon" ? "✦" : "✓"}</span><div><strong title="${escapeHtml(item.problem)}">${escapeHtml(item.problem)}</strong><span>${escapeHtml(item.category)} · updated ${new Date(item.updated_at).toLocaleDateString(undefined, {month:"short", day:"numeric"})}</span><span title="${escapeHtml(item.solution)}">${escapeHtml(item.solution.replace(/\n/g, " ").slice(0, 76))}${item.solution.length > 76 ? "…" : ""}</span></div></div>
      <div class="knowledge-cell"><strong>${item.verification_count}</strong> verifications</div><div class="knowledge-cell"><strong>${item.usage_count}</strong> reuses</div><div class="knowledge-arrow">↗</div>
    </div>`).join("");
}

function renderKnown(result) {
  const item = result.knowledge;
  $("#result-region").innerHTML = `<div class="result-card">
    <div class="result-main"><div class="result-status"><span class="status-check">✓</span> KNOWN FIX FOUND</div><h3 class="result-title">Previously solved by your community</h3><p class="result-problem">${escapeHtml(result.problem)}</p><div class="solution-box">${solutionText(item.solution)}</div><div class="result-meta"><span class="meta-pill lime">✓ Verified solution</span><span class="meta-pill">${item.verification_count} verifications</span><span class="meta-pill">${item.usage_count} successful reuses</span></div><div class="result-actions"><button class="secondary-button" data-feedback="true" data-id="${item.id}">✓ This fixed my problem</button><button class="ghost-button" data-alternative="true" data-id="${item.id}">I need another fix</button></div></div>
    <aside class="result-aside"><h3>Semantic match detected</h3><p>Different wording, same underlying problem. Your community already did the work.</p><div class="aside-fact"><span>Match confidence</span><strong>${item.confidence_percent}%</strong></div><div class="aside-fact"><span>Response time</span><strong>${result.latency_ms} ms</strong></div><div class="aside-fact"><span>New AI generation</span><strong style="color:var(--lime)">Not required</strong></div><div class="aside-fact"><span>Reused</span><strong style="color:var(--lime)">YES</strong></div></aside></div>`;
}

function renderAlternativePrompt(id) {
  const box = document.createElement("div"); box.className = "share-box alternative-box";
  box.innerHTML = `<h4>Build another path</h4><p>Tell Featherless what failed on this device. It will generate a different structured playbook while keeping the original fix available.</p><textarea class="alternative-note" rows="2" placeholder="Example: The VPN was connected, but internal DNS still timed out."></textarea><div class="share-actions"><button class="secondary-button" data-generate-alternative="true" data-id="${id}">Generate alternative fix</button><button class="ghost-button" data-cancel-alternative="true">Cancel</button></div>`;
  $("#result-region .result-main").appendChild(box);
}

function renderNew(result, blocked = false, alternative = false) {
  const title = blocked ? "Kept out of community memory" : alternative ? "A second path for this problem" : "We couldn't find a known fix";
  const status = blocked ? "PRIVATE / TIME-SENSITIVE" : alternative ? "ALTERNATIVE FIX" : "NEW PROBLEM";
  $("#result-region").innerHTML = `<div class="result-card new-result ${blocked ? "blocked-card" : ""}">
    <div class="result-main"><div class="result-status"><span class="status-check" style="background:${blocked ? "var(--warm)" : "var(--purple)"};color:#201d2d">${blocked ? "!" : alternative ? "↻" : "+"}</span> ${status}</div><h3 class="result-title">${title}</h3><p class="result-problem">${escapeHtml(result.problem)}</p><div class="solution-box">${solutionText(result.suggestion)}</div><div class="result-meta"><span class="meta-pill">${escapeHtml(result.provider)}</span><span class="meta-pill">${result.latency_ms || "—"} ms total</span></div>${blocked ? `<div class="share-box" style="background:#33271e;border-color:#604c36"><h4>Privacy guardrail</h4><p>${escapeHtml(result.safety.reason || "This result is not eligible for reuse.")}</p></div>` : `<div class="share-box" id="verify-box"><h4>Did this solve the problem?</h4><p>Test the suggested fix first. Only verified solutions can be shared, and sharing is always optional.</p><div class="share-actions"><button class="secondary-button" data-verify="true" data-id="${result.draft_id}">✓ Yes, it worked</button><button class="ghost-button" data-verify="false" data-id="${result.draft_id}">No, keep private</button></div></div>`}</div>
    <aside class="result-aside"><h3>${blocked ? "Reuse bypassed" : alternative ? "Recovery path" : "Suggested fix"}</h3><p>${blocked ? "FixOnce avoids reusing or publishing personal and time-sensitive requests." : alternative ? "The first fix received negative feedback, so Featherless generated a separate path for this community problem." : "A fresh suggestion is generated only after community memory comes up empty."}</p><div class="aside-fact"><span>Search time</span><strong>${result.search_latency_ms || "—"} ms</strong></div><div class="aside-fact"><span>AI time</span><strong>${result.ai_latency_ms || "—"} ms</strong></div><div class="aside-fact"><span>Saved by default</span><strong>NO</strong></div></aside></div>`;
}

function renderVerified(id) { const box = $("#verify-box"); if (!box) return; box.className = "share-box verified-card"; box.innerHTML = `<h4>✓ Solution verified</h4><p>This fix worked for you. Share it so the next person can skip the rediscovery step.</p><div class="share-actions"><button class="secondary-button" data-share="true" data-id="${id}">Share with community</button><button class="ghost-button" data-share="false" data-id="${id}">Keep private</button></div>`; }

async function handleLookup(event) {
  event.preventDefault(); const input = $("#problem-input"); const problem = input.value.trim(); if (!problem) { toast("Describe the problem first.", true); input.focus(); return; }
  const button = $("#find-button"); button.disabled = true; button.innerHTML = `<span class="button-icon">◌</span> Searching community memory…`; $("#result-region").innerHTML = `<div class="result-card new-result"><div class="result-main"><div class="result-status"><span class="status-check" style="background:var(--purple);color:#201d2d">⌕</span> SEARCHING COMMUNITY MEMORY</div><h3 class="result-title">Checking solved problems for a semantic match…</h3><p class="result-problem">The words can change. The underlying problem is what matters.</p></div></div>`;
  try { const result = await api("/api/find-fix", { method:"POST", body:JSON.stringify({problem}) }); state.current = result; result.result_type === "known" ? renderKnown(result) : renderNew(result, result.result_type === "blocked", Boolean(result.alternative)); await refresh(); }
  catch (error) { $("#result-region").innerHTML = `<div class="result-card blocked-card"><div class="result-main"><div class="result-status">SERVICE UNAVAILABLE</div><h3 class="result-title">The lookup could not be completed.</h3><p class="result-problem">${escapeHtml(error.message)}</p></div></div>`; toast(error.message, true); }
  finally { button.disabled = false; button.innerHTML = `<span class="button-icon">⌕</span> Find known fix <span class="button-arrow">↗</span>`; }
}

async function handleResultClick(event) {
  const target = event.target.closest("button"); if (!target) return; const id = target.dataset.id;
  try {
    if (target.dataset.feedback) { await api(`/api/knowledge/${id}/feedback`, {method:"POST", body:JSON.stringify({helpful:target.dataset.feedback === "true"})}); toast("Thanks — the community signal is stronger."); target.disabled = true; }
    if (target.dataset.alternative) { renderAlternativePrompt(id); target.disabled = true; }
    if (target.dataset.cancelAlternative) { target.closest(".alternative-box")?.remove(); }
    if (target.dataset.generateAlternative) { const note = target.closest(".alternative-box")?.querySelector(".alternative-note")?.value.trim() || "The previous fix did not solve the problem on this device."; target.disabled = true; target.textContent = "Generating another fix…"; const result = await api(`/api/knowledge/${id}/alternative`, {method:"POST", body:JSON.stringify({problem:state.current?.problem || "", note})}); state.current = result; renderNew(result, false, true); await refresh(); }
    if (target.dataset.verify) { const solved = target.dataset.verify === "true"; await api(`/api/knowledge/${id}/verify`, {method:"POST", body:JSON.stringify({solved})}); solved ? renderVerified(id) : toast("Kept private. It was not added as a verified fix."); if (!solved) target.disabled = true; }
    if (target.dataset.share === "true") { await api(`/api/knowledge/${id}/share`, {method:"POST"}); toast("Added to Community Memory ✓"); target.closest(".share-box").innerHTML = `<h4>✓ Added to Community Memory</h4><p>Other members can now find this verified solution, even with different wording.</p>`; await refresh(); }
    if (target.dataset.share === "false") { toast("Kept private. Your solution stays yours."); target.disabled = true; }
  } catch (error) { toast(error.message, true); }
}

async function deleteAllSolutions() {
  const confirmation = window.prompt('This permanently deletes every saved solution. Type "DELETE ALL" to continue.');
  if (confirmation !== "DELETE ALL") { toast("Deletion cancelled."); return; }
  const button = $("#delete-all-button");
  button.disabled = true;
  button.textContent = "Deleting...";
  try {
    const result = await api("/api/knowledge", { method:"DELETE", body:JSON.stringify({confirmation}) });
    $("#result-region").innerHTML = "";
    toast(String(result.deleted_count) + " saved solution(s) deleted.");
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Delete all solutions";
  }
}
async function refresh() { const [stats, memory] = await Promise.all([api("/api/stats"), api("/api/knowledge")]); updateMetrics(stats); state.knowledge = memory.items; renderKnowledge(); }
$("#delete-all-button").addEventListener("click", deleteAllSolutions);
async function runSimulation() { const modal = $("#simulation-modal"); modal.hidden = false; $("#simulation-content").innerHTML = `<div class="loading-line">Running the fixed paraphrase set through semantic search…</div>`; try { const result = await api("/api/demo/run", {method:"POST"}); $("#simulation-content").innerHTML = `<div class="sim-banner"><span>${result.label} · ${result.total_questions} questions</span><strong>${result.reuse_rate}% reuse rate</strong></div><div class="sim-columns"><div class="sim-box"><span>WITHOUT FIXONCE</span><strong>${result.without_fixonce.ai_generations}</strong><p>fresh AI generations</p></div><div class="sim-box accent"><span>WITH FIXONCE</span><strong>${result.with_fixonce.ai_generations}</strong><p>fresh generations · ${result.with_fixonce.community_resolutions} community resolutions</p></div></div><div class="sim-foot"><span>AI generations avoided <strong>${result.with_fixonce.ai_generations_avoided}</strong></span><span>Avg semantic search <strong>${result.avg_semantic_search_ms} ms</strong></span><span>Run time <strong>${result.elapsed_ms} ms</strong></span></div>`; } catch (error) { $("#simulation-content").innerHTML = `<div class="loading-line">${escapeHtml(error.message)}</div>`; } }

document.addEventListener("DOMContentLoaded", async () => {
  $("#lookup-form").addEventListener("submit", handleLookup); $("#result-region").addEventListener("click", handleResultClick); $("#run-demo-button").addEventListener("click", runSimulation); $("#close-modal").addEventListener("click", () => $("#simulation-modal").hidden = true); $("#simulation-modal").addEventListener("click", (event) => { if (event.target.id === "simulation-modal") event.currentTarget.hidden = true; });
  $("#problem-input").addEventListener("input", (event) => $("#char-count").textContent = `${event.target.value.length} / 1000`); $("#knowledge-search").addEventListener("input", () => renderKnowledge());
  document.querySelectorAll(".example-chip").forEach(chip => chip.addEventListener("click", () => { $("#problem-input").value = chip.dataset.example; $("#char-count").textContent = `${chip.dataset.example.length} / 1000`; $("#problem-input").focus(); }));
  $("#reset-button").addEventListener("click", async () => { try { await api("/api/demo/reset", {method:"POST"}); $("#result-region").innerHTML = ""; toast("Demo memory reset."); await refresh(); } catch(error){toast(error.message,true);} });
  document.querySelectorAll("[data-nav]").forEach(link => link.addEventListener("click", () => { document.querySelectorAll(".nav-link").forEach(item => item.classList.remove("active")); link.classList.add("active"); }));
  try { await refresh(); } catch(error) { toast("Start the FixOnce API to connect this dashboard.", true); }
});
