const normalizeApiBase = (value) => {
  const trimmed = String(value || "").trim().replace(/\/$/, "");
  try {
    const parsed = new URL(trimmed);
    const privateNetwork = /^(localhost|127(?:\.\d+){3}|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])\.\d+|::1)$/i.test(parsed.hostname);
    if (parsed.protocol === "http:" && !privateNetwork) parsed.protocol = "https:";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
};
const defaultApi = normalizeApiBase(window.FIXONCE_DEFAULT_API || "http://localhost:8000");
const input = document.querySelector("#api-url"); const status = document.querySelector("#status");
chrome.storage.sync.get({ apiBaseUrl: defaultApi }, (data) => { input.value = normalizeApiBase(data.apiBaseUrl || defaultApi); });
document.querySelector("#save").addEventListener("click", () => {
  const value = normalizeApiBase(input.value);
  if (!/^https?:\/\//i.test(value)) { status.textContent = "Enter a URL beginning with http:// or https://"; return; }
  chrome.storage.sync.set({ apiBaseUrl: value }, () => { input.value = value; status.textContent = "Saved. The popup will use this connection."; });
});

