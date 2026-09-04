const defaultApi = (window.FIXONCE_DEFAULT_API || "http://localhost:8000").replace(/\/$/, "");
const input = document.querySelector("#api-url"); const status = document.querySelector("#status");
chrome.storage.sync.get({ apiBaseUrl: defaultApi }, (data) => { input.value = data.apiBaseUrl; });
document.querySelector("#save").addEventListener("click", () => {
  const value = input.value.trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(value)) { status.textContent = "Enter a URL beginning with http:// or https://"; return; }
  chrome.storage.sync.set({ apiBaseUrl: value }, () => { status.textContent = "Saved. The popup will use this connection."; });
});

