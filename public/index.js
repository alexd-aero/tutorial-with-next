// Landing-page logic: warm up the Scramjet SW, then send URLs to /go/<b64url>.

const statusEl = document.getElementById("status");
const form = document.getElementById("f");
const input = document.getElementById("u");

// base64url encode (UTF-8 safe)
function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function normalize(raw) {
  let u = raw.trim();
  if (!u) return "";
  if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
  return u;
}

// Warm up the service worker so the first /go navigation is instant.
(async () => {
  try {
    if (typeof initBootstrap === "function") {
      await initBootstrap();
      statusEl.textContent = "Ready.";
    }
  } catch (e) {
    statusEl.textContent = "Transport not ready: " + (e && e.message ? e.message : e);
  }
})();

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normalize(input.value);
  if (!url) return;
  location.href = "/go/" + b64url(url);
});
