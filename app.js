// =====================================================================
// หารบิล — app.js
// Static SPA: stores bill-splitting projects as JSON files in a GitHub
// repo via the GitHub REST API (client-side, using a user-supplied PAT).
// =====================================================================

(() => {
  "use strict";

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------
  const GH_API = "https://api.github.com";
  const PROJECTS_DIR = "projects";
  const INDEX_PATH = `${PROJECTS_DIR}/_index.json`;
  const PEOPLE_POOL_PATH = "people/_saved.json";
  const SETTINGS_KEY = "billsplit_gh_settings";
  const FIREBASE_SETTINGS_KEY = "billsplit_firebase_settings";
  const GEMINI_MODEL_KEY = "billsplit_gemini_model";
  const THEME_KEY = "billsplit_theme";
  const DRAFT_KEY_PREFIX = "billsplit_draft_";
  const STEPS = [
    { key: "info", label: "1. ข้อมูลบิล" },
    { key: "menu", label: "2. เมนู" },
    { key: "people", label: "3. รายชื่อคน" },
    { key: "split", label: "4. หารบิล" },
    { key: "summary", label: "5. สรุปผล" },
  ];
  // AI receipt scanning calls a Cloud Function (scanReceipt, see
  // functions/index.js) instead of the Gemini API directly — the API key
  // lives server-side as a Firebase Functions secret and never ships to the
  // browser. See functions/index.js for the prompt and model allowlist.
  // Selectable models — offered as a dropdown so a user can switch away from
  // one that's hit its free-tier rate limit instead of being stuck. Each
  // option here is a genuinely distinct model (not just aliases of the same
  // underlying model) so they draw from separate quota buckets. Must match
  // the ALLOWED_MODELS list in functions/index.js.
  const GEMINI_MODELS = [
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash (แนะนำ)" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite (ลิมิตสูงกว่า)" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview (สำรอง)" },
  ];

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  let settings = loadSettings();          // {token, owner, repo, branch}
  let firebaseSettings = loadFirebaseSettings(); // public Firebase web config
  let geminiModel = loadGeminiModel();    // selected model id — for in-app AI receipt reading
  let firebaseRuntime = null;             // lazy-loaded Firebase modules/app
  let currentUser = null;                 // Firebase Auth user
  let currentUserProfile = null;          // {email, role, createdAt}
  let indexCache = null;                  // {entries:[...], sha}
  let currentProject = null;              // working project object
  let chartRefs = {};                     // chart.js instances to destroy on re-render
  let activeSnapshotUnsub = null;         // unsubscribe fn for the current onSnapshot listener, if any
  // Guards for the owner summary's live-sync subscription (see
  // subscribeSummaryLiveSync): which project it's currently attached to, and
  // a fingerprint of the data last rendered, so a snapshot that fires with
  // unchanged data (Firestore always fires once immediately on attach) can't
  // trigger a re-render → re-subscribe → new snapshot loop.
  let summarySyncProjectId = null;
  let lastSummarySyncKey = null;
  // Which person rows are expanded in "รายละเอียดต่อคน" — tracked outside the
  // DOM so a live-sync re-render (stepSummary rebuilds the whole body) can
  // restore what the owner had open instead of silently collapsing it.
  let openPersonDetailIds = new Set();
  // Snapshot of {shares, doneBy} as they were the last time we know the owner's
  // in-memory currentProject matched the server. Used to 3-way merge on save so
  // an owner's local edits never blindly clobber picks guests made concurrently.
  let projectSyncBaseline = null;

  function stopLiveSync() {
    if (activeSnapshotUnsub) {
      try { activeSnapshotUnsub(); } catch { /* ignore */ }
      activeSnapshotUnsub = null;
    }
    // Deliberately NOT resetting lastSummarySyncKey here: subscribeSummaryLiveSync
    // calls stopLiveSync() to tear down a stale listener *after* stepSummary()
    // already recorded the fingerprint of what's currently on screen — clearing
    // it here would wipe that fingerprint and make every fire-on-attach
    // snapshot look "changed", defeating the no-op check.
    summarySyncProjectId = null;
  }
  // Fingerprint of only the fields the summary view actually displays —
  // deliberately excludes updatedAt, which changes on every write and would
  // defeat the point of comparing "did anything visible change".
  function summarySyncKey(p) {
    return JSON.stringify({
      name: p.name, place: p.place, date: p.date,
      totalDiscount: p.totalDiscount, serviceChargePercent: p.serviceChargePercent, vatPercent: p.vatPercent,
      items: p.items, people: p.people, shares: p.shares, doneBy: p.doneBy,
      guestAccess: p.guestAccess, guestLocked: p.guestLocked, promptPayId: p.promptPayId,
    });
  }
  function snapshotSyncBaseline(p) {
    return {
      id: p.id,
      shares: JSON.parse(JSON.stringify(p.shares || {})),
      doneBy: [...(p.doneBy || [])],
    };
  }

  // ---------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------
  // Several list items (project cards, wizard step pills, person rows) are
  // plain <div>s with an .onclick handler for layout reasons — this makes
  // them focusable and activatable with Enter/Space so keyboard users can
  // reach them too, without having to restyle them as <button>.
  // Realtime views rebuild their whole DOM subtree on every Firestore
  // snapshot, which otherwise jumps scroll position back to the top and can
  // fire many times a second while several guests are ticking checkboxes at
  // once. This collapses bursts into one render and restores scroll
  // position afterwards, without requiring a full incremental-DOM rewrite.
  let _liveRerenderTimer = null;
  function rerenderPreservingScroll(renderFn, delay = 150) {
    clearTimeout(_liveRerenderTimer);
    _liveRerenderTimer = setTimeout(() => {
      const scrollY = window.scrollY;
      const matrixWrap = document.querySelector(".matrix-wrap");
      const matrixScrollLeft = matrixWrap ? matrixWrap.scrollLeft : 0;
      renderFn();
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollY);
        const newMatrixWrap = document.querySelector(".matrix-wrap");
        if (newMatrixWrap) newMatrixWrap.scrollLeft = matrixScrollLeft;
      });
    }, delay);
  }
  // The split matrix's checkboxes are the app's core interaction and mostly
  // used on phones, but the checkbox itself is well under the 44px touch
  // target minimum. This lets tapping anywhere in the cell toggle it, while
  // the checkbox stays the source of truth (its own click still fires
  // "change" natively, so we only handle taps that land on the <td> itself).
  function wireCellClickToggle(scopeEl) {
    scopeEl.querySelectorAll("table.matrix td").forEach((td) => {
      const cb = td.querySelector('input[type="checkbox"]');
      if (!cb) return;
      td.style.cursor = cb.disabled ? "not-allowed" : "pointer";
      td.addEventListener("click", (e) => {
        if (e.target === cb || cb.disabled) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  }
  function makeKeyboardActivatable(el) {
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        el.click();
      }
    });
  }
  function uuid() {
    return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function baht(n) {
    if (!isFinite(n)) n = 0;
    return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function moneyNumber(n) {
    const value = Number(n);
    return isFinite(value) && value > 0 ? value : 0;
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function toast(msg, isError) {
    const el = document.getElementById("toast");
    el.querySelector("#toast-text").textContent = msg;
    el.style.borderColor = isError ? "var(--danger)" : "var(--border-color)";
    el.setAttribute("aria-live", isError ? "assertive" : "polite");
    el.classList.add("show");
    clearTimeout(el._t);
    // Errors and longer messages get more time on screen so they're not
    // missed — the flat 3.2s timer was too short for the longer Thai +
    // Firebase error strings this app surfaces.
    const duration = Math.min(8000, Math.max(3200, msg.length * 60));
    el._t = setTimeout(() => el.classList.remove("show"), isError ? Math.max(duration, 4500) : duration);
  }
  function b64EncodeUnicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64DecodeUnicode(str) {
    return decodeURIComponent(escape(atob(str)));
  }
  function b64UrlEncode(str) {
    return b64EncodeUnicode(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function b64UrlDecode(str) {
    let normalized = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4) normalized += "=";
    return b64DecodeUnicode(normalized);
  }
  function navigate(hash) { window.location.hash = hash; }
  function normalizeProject(p) {
    p = p && typeof p === "object" ? p : {};
    p.id = String(p.id || uuid());
    if (p.ownerUid) p.ownerUid = String(p.ownerUid);
    if (p.ownerEmail) p.ownerEmail = String(p.ownerEmail);
    p.guestAccess = !!p.guestAccess;
    p.guestLocked = !!p.guestLocked;
    p.name = String(p.name || "");
    p.date = String(p.date || todayISO());
    p.place = String(p.place || "");
    p.promptPayId = String(p.promptPayId || "");
    p.totalDiscount = moneyNumber(p.totalDiscount);
    p.serviceChargePercent = moneyNumber(p.serviceChargePercent);
    p.vatPercent = moneyNumber(p.vatPercent);
    p.items = Array.isArray(p.items) ? p.items : [];
    p.items = p.items.map((it) => ({
      id: String(it.id || uuid()),
      name: String(it.name || ""),
      price: moneyNumber(it.price),
    }));
    p.people = Array.isArray(p.people) ? p.people : [];
    p.people = p.people.map((person) => ({
      id: String(person.id || uuid()),
      name: String(person.name || ""),
    }));
    p.shares = p.shares || {};
    const itemIds = new Set(p.items.map((it) => it.id));
    const peopleIds = new Set(p.people.map((person) => person.id));
    p.shares = Object.fromEntries(Object.entries(p.shares)
      .filter(([itemId]) => itemIds.has(itemId))
      .map(([itemId, ids]) => [itemId, [...new Set((Array.isArray(ids) ? ids : []).filter((id) => peopleIds.has(id)))]]));
    p.doneBy = Array.isArray(p.doneBy) ? p.doneBy : [];
    p.doneBy = [...new Set(p.doneBy.filter((id) => peopleIds.has(id)))];
    return p;
  }
  async function copyText(text) {
    // Legacy execCommand path — still the reliable one inside the Android
    // WebView the mobile app runs in, where navigator.clipboard exists on the
    // secure origin but writeText() rejects. Runs during the click's transient
    // user activation, so it must be reachable even when the async Clipboard
    // API is present but fails.
    function legacyCopy() {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) { /* older webviews */ }
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (e) {
        if (legacyCopy()) return;
        throw e;
      }
    }
    if (!legacyCopy()) throw new Error("คัดลอกลิงก์ไม่สำเร็จ");
  }

  // Lazy-load an external <script> once, resolving when it's ready. Lets us
  // keep the heavy export libraries (html2canvas ~180KB, jsPDF ~360KB) and the
  // QR generator out of the initial page load — most visitors (especially
  // guests picking menu items) never export or need a QR, so they shouldn't
  // pay the download cost on first paint.
  const _scriptPromises = {};
  function loadScriptOnce(src) {
    if (_scriptPromises[src]) return _scriptPromises[src];
    _scriptPromises[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { delete _scriptPromises[src]; reject(new Error("โหลดสคริปต์ไม่สำเร็จ: " + src)); };
      document.head.appendChild(s);
    });
    return _scriptPromises[src];
  }
  const CDN = {
    html2canvas: "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
    jspdf: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
    qrcode: "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js",
  };
  async function ensureHtml2canvas() {
    if (!window.html2canvas) await loadScriptOnce(CDN.html2canvas);
    return window.html2canvas;
  }
  async function ensureJsPdf() {
    if (!window.jspdf) await loadScriptOnce(CDN.jspdf);
    return window.jspdf;
  }
  async function ensureQrLib() {
    if (!window.qrcode) await loadScriptOnce(CDN.qrcode);
    return window.qrcode;
  }

  // ---- PromptPay (Thai QR) — pure-JS EMVCo payload, no external service ----
  // Everyone pays the person who fronted the bill, so the owner supplies their
  // own PromptPay ID (phone / national-ID / e-wallet) and each guest gets a QR
  // pre-filled with the owner's ID + that guest's exact amount.
  function ppTLV(id, value) {
    const len = String(value.length).padStart(2, "0");
    return `${id}${len}${value}`;
  }
  function ppCrc16(payload) {
    let crc = 0xffff;
    for (let i = 0; i < payload.length; i++) {
      crc ^= payload.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xffff;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, "0");
  }
  // Returns { subId, value } for the PromptPay proxy field, or null if the id
  // doesn't look like a valid phone / national-ID / e-wallet number.
  function ppProxy(rawId) {
    const digits = String(rawId || "").replace(/\D/g, "");
    if (!digits) return null;
    if (digits.length === 15) return { subId: "03", value: digits };          // e-wallet
    if (digits.length === 13) return { subId: "02", value: digits };          // national / tax id
    if (digits.length === 10 && digits.startsWith("0"))                       // Thai mobile
      return { subId: "01", value: "0066" + digits.slice(1) };
    if (digits.length === 9) return { subId: "01", value: "0066" + digits };  // mobile w/o leading 0
    return null;
  }
  function promptPayPayload(rawId, amount) {
    const proxy = ppProxy(rawId);
    if (!proxy) return null;
    const merchant = ppTLV("00", "A000000677010111") + ppTLV(proxy.subId, proxy.value);
    const amt = Number(amount);
    const hasAmount = isFinite(amt) && amt > 0;
    let payload =
      ppTLV("00", "01") +                          // format indicator
      ppTLV("01", hasAmount ? "12" : "11") +       // 12 = dynamic (has amount), 11 = static
      ppTLV("29", merchant) +                      // PromptPay merchant account info
      ppTLV("53", "764") +                         // currency THB
      (hasAmount ? ppTLV("54", amt.toFixed(2)) : "") +
      ppTLV("58", "TH");                           // country
    payload += "6304";                             // CRC tag + length, value appended next
    return payload + ppCrc16(payload);
  }
  // Renders a PromptPay QR into `container` (or an error line if the id is
  // invalid / the QR lib can't load). Returns the payload string, or null.
  async function renderPromptPayQr(container, rawId, amount, cellSize = 4) {
    const payload = promptPayPayload(rawId, amount);
    if (!payload) {
      container.innerHTML = `<div class="section-sub">PromptPay ID ไม่ถูกต้อง (ใส่เบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก)</div>`;
      return null;
    }
    try {
      const qrcode = await ensureQrLib();
      const qr = qrcode(0, "M");
      qr.addData(payload);
      qr.make();
      container.innerHTML = qr.createImgTag(cellSize, 0);
      const img = container.querySelector("img");
      if (img) { img.alt = "PromptPay QR"; img.style.width = "180px"; img.style.height = "180px"; img.style.imageRendering = "pixelated"; }
      return payload;
    } catch (e) {
      container.innerHTML = `<div class="section-sub">แสดง QR ไม่สำเร็จ: ${escapeHtml(e.message || "")}</div>`;
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Settings (GitHub connection) — stored only in this browser
  // ---------------------------------------------------------------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveSettingsToStorage(s) {
    settings = s;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    updateGhStatus();
  }
  function clearSettings() {
    settings = null;
    indexCache = null;
    localStorage.removeItem(SETTINGS_KEY);
    updateGhStatus();
  }
  function loadFirebaseSettings() {
    try {
      const raw = localStorage.getItem(FIREBASE_SETTINGS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveFirebaseSettingsToStorage(s) {
    firebaseSettings = s;
    localStorage.setItem(FIREBASE_SETTINGS_KEY, JSON.stringify(s));
    updateGhStatus();
  }
  function clearFirebaseSettings() {
    firebaseSettings = null;
    firebaseRuntime = null;
    localStorage.removeItem(FIREBASE_SETTINGS_KEY);
    updateGhStatus();
  }
  function loadGeminiModel() {
    try {
      return localStorage.getItem(GEMINI_MODEL_KEY) || GEMINI_MODELS[0].id;
    } catch { return GEMINI_MODELS[0].id; }
  }
  function saveGeminiModel(modelId) {
    geminiModel = modelId;
    localStorage.setItem(GEMINI_MODEL_KEY, modelId);
  }
  function isConnected() {
    return !!(settings && settings.token && settings.owner && settings.repo);
  }
  function isFirebaseConnected() {
    return !!(firebaseSettings && firebaseSettings.apiKey && firebaseSettings.authDomain && firebaseSettings.projectId && firebaseSettings.appId);
  }
  function isAdmin() {
    return currentUserProfile && currentUserProfile.role === "admin";
  }
  function isGuestUser() {
    return !!(currentUser && currentUser.isAnonymous);
  }
  async function loadBundledFirebaseConfig() {
    if (isFirebaseConnected()) return firebaseSettings;
    const res = await fetch("firebase-config.json", { cache: "no-store" });
    if (!res.ok) throw new Error("ไม่พบไฟล์ firebase-config.json");
    const config = await res.json();
    const required = ["apiKey", "authDomain", "projectId", "appId"];
    const missing = required.filter((key) => !config[key]);
    if (missing.length) throw new Error(`firebase-config.json ขาด ${missing.join(", ")}`);
    firebaseSettings = config;
    return firebaseSettings;
  }
  function updateGhStatus(state) {
    const el = document.getElementById("gh-status");
    const text = el.querySelector(".gh-status-text");
    const adminBtn = document.getElementById("admin-btn");
    const logoutBtn = document.getElementById("logout-btn");
    el.classList.remove("connected", "error");
    if (currentUser && isGuestUser()) {
      el.classList.add("connected");
      text.textContent = "โหมดเกส (ไม่ต้องเข้าสู่ระบบ)";
      if (adminBtn) adminBtn.style.display = "none";
      if (logoutBtn) logoutBtn.style.display = "none";
      return;
    }
    if (currentUser) {
      el.classList.add("connected");
      text.textContent = `${currentUser.email || "บัญชีผู้ใช้"}${isAdmin() ? " · ผู้ดูแลระบบ" : ""}`;
      if (adminBtn) adminBtn.style.display = isAdmin() ? "inline-flex" : "none";
      if (logoutBtn) logoutBtn.style.display = "inline-flex";
      return;
    }
    if (adminBtn) adminBtn.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "none";
    if (isFirebaseConnected()) { text.textContent = "ยังไม่เข้าสู่ระบบ"; return; }
    if (!isConnected()) { text.textContent = "ยังไม่เข้าสู่ระบบ"; return; }
    if (state === "error") { el.classList.add("error"); text.textContent = "เชื่อมต่อมีปัญหา"; return; }
    el.classList.add("connected");
    text.textContent = `${settings.owner}/${settings.repo}`;
  }

  // ---------------------------------------------------------------
  // GitHub REST API helpers
  // ---------------------------------------------------------------
  async function ghFetch(path, opts = {}) {
    if (!isConnected()) throw new Error("ยังไม่ได้เชื่อมต่อ GitHub");
    const base = `${GH_API}/repos/${settings.owner}/${settings.repo}`;
    const url = path ? `${base}/${path}` : base;
    const res = await fetch(url, {
      ...opts,
      headers: {
        "Authorization": `Bearer ${settings.token}`,
        "Accept": "application/vnd.github+json",
        ...(opts.headers || {}),
      },
    });
    return res;
  }

  async function ghGetFile(path) {
    const res = await ghFetch(`contents/${path}?ref=${encodeURIComponent(settings.branch || "main")}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub error ${res.status} ขณะอ่าน ${path}`);
    const data = await res.json();
    return { sha: data.sha, content: JSON.parse(b64DecodeUnicode(data.content.replace(/\n/g, ""))) };
  }

  async function ghPutFile(path, obj, sha, message) {
    const body = {
      message: message || `update ${path}`,
      content: b64EncodeUnicode(JSON.stringify(obj, null, 2)),
      branch: settings.branch || "main",
    };
    if (sha) body.sha = sha;
    const res = await ghFetch(`contents/${path}`, { method: "PUT", body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub error ${res.status} ขณะบันทึก ${path}`);
    }
    return res.json();
  }

  async function ghDeleteFile(path, sha, message) {
    const res = await ghFetch(`contents/${path}`, {
      method: "DELETE",
      body: JSON.stringify({ message: message || `delete ${path}`, sha, branch: settings.branch || "main" }),
    });
    if (!res.ok) throw new Error(`GitHub error ${res.status} ขณะลบ ${path}`);
  }

  async function testConnection() {
    const res = await ghFetch("");
    if (res.status === 401) throw new Error("โทเค็นไม่ถูกต้องหรือหมดอายุ");
    if (res.status === 404) throw new Error("ไม่พบรีโพนี้ — ตรวจชื่อ owner/repo หรือสร้างรีโพก่อน");
    if (!res.ok) throw new Error(`เชื่อมต่อไม่สำเร็จ (${res.status})`);
    return true;
  }

  // Read-modify-write a file with automatic retry if the remote file changed
  // (sha conflict) between our read and our write — e.g. multiple tabs/sessions
  // editing at once, or a stale in-memory sha after a page reload.
  async function ghPutFileWithRetry(path, buildObj, message, maxRetries = 4) {
    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const file = await ghGetFile(path);
      const obj = buildObj(file ? file.content : null);
      try {
        const result = await ghPutFile(path, obj, file ? file.sha : null, message);
        return { obj, sha: result.content.sha };
      } catch (e) {
        lastErr = e;
        const isShaConflict = /does not match|sha/i.test(e.message || "");
        if (!isShaConflict) throw e; // some other error — don't retry blindly
        // otherwise loop again: re-fetch the latest file and reapply buildObj
      }
    }
    throw lastErr;
  }

  // Index file (projects/_index.json) read-modify-write with conflict retry.
  async function updateProjectIndex({ upsert, removeId } = {}) {
    const { obj, sha } = await ghPutFileWithRetry(
      INDEX_PATH,
      (current) => {
        let entries = (current && current.entries) || [];
        if (removeId) entries = entries.filter((e) => e.id !== removeId);
        if (upsert) {
          const i = entries.findIndex((e) => e.id === upsert.id);
          if (i >= 0) entries[i] = upsert; else entries.unshift(upsert);
        }
        return { entries };
      },
      upsert ? `update index for ${upsert.name}` : `remove ${removeId} from index`
    );
    indexCache = { entries: obj.entries, sha };
    return indexCache;
  }

  async function getIndex(force) {
    if (indexCache && !force) return indexCache;
    const file = await ghGetFile(INDEX_PATH);
    indexCache = file ? { entries: file.content.entries || [], sha: file.sha } : { entries: [], sha: null };
    return indexCache;
  }

  // Reusable "saved people" pool — one shared list across all projects,
  // stored at people/_saved.json in the same repo.
  async function getSavedPeople() {
    const file = await ghGetFile(PEOPLE_POOL_PATH);
    return (file && file.content.names) || [];
  }
  async function addNamesToSavedPeople(names) {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (!clean.length) return [];
    const { obj } = await ghPutFileWithRetry(
      PEOPLE_POOL_PATH,
      (current) => {
        const existing = (current && current.names) || [];
        const merged = [...new Set([...existing, ...clean])];
        return { names: merged };
      },
      "update saved people list"
    );
    return obj.names;
  }

  // Firebase equivalent of the saved-people pool: kept on the signed-in
  // owner's own users/{uid} doc (savedPeople array) so the names they type
  // are remembered across every project on their account. Firestore rules
  // already allow a user to update their own doc (except role).
  async function getSavedPeopleFirebase() {
    if (!currentUser || isGuestUser()) return [];
    if (currentUserProfile && Array.isArray(currentUserProfile.savedPeople)) {
      return currentUserProfile.savedPeople;
    }
    const rt = await getFirebaseRuntime();
    const snap = await rt.getDoc(firebaseUserRef(rt, currentUser.uid));
    const names = (snap.exists() && snap.data().savedPeople) || [];
    if (currentUserProfile) currentUserProfile.savedPeople = names;
    return names;
  }
  async function addNamesToSavedPeopleFirebase(names) {
    if (!currentUser || isGuestUser()) return [];
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (!clean.length) return [];
    const existing = await getSavedPeopleFirebase();
    const merged = [...new Set([...existing, ...clean])].sort((a, b) => a.localeCompare(b, "th"));
    // Nothing new to add — skip the write so we don't churn updatedAt.
    if (merged.length === existing.length) return existing;
    const rt = await getFirebaseRuntime();
    await rt.setDoc(firebaseUserRef(rt, currentUser.uid),
      { savedPeople: merged, updatedAt: new Date().toISOString() }, { merge: true });
    if (currentUserProfile) currentUserProfile.savedPeople = merged;
    return merged;
  }
  // Mode-agnostic wrappers so callers don't care where the pool lives.
  async function loadSavedPeoplePool() {
    if (isFirebaseConnected()) return getSavedPeopleFirebase();
    if (isConnected()) return getSavedPeople();
    return [];
  }
  async function saveNamesToPool(names) {
    if (isFirebaseConnected()) return addNamesToSavedPeopleFirebase(names);
    if (isConnected()) return addNamesToSavedPeople(names);
    return [];
  }

  async function saveProjectToGithub(project, summary) {
    project.updatedAt = new Date().toISOString();
    const { sha } = await ghPutFileWithRetry(
      `${PROJECTS_DIR}/${project.id}.json`,
      () => project,
      `save project ${project.name}`
    );
    project._sha = sha;
    const entry = {
      id: project.id, name: project.name, date: project.date, place: project.place || "",
      grandTotal: summary ? summary.grandTotal : 0, peopleCount: project.people.length,
      updatedAt: project.updatedAt,
    };
    await updateProjectIndex({ upsert: entry });
  }

  async function loadProjectFromGithub(id) {
    const file = await ghGetFile(`${PROJECTS_DIR}/${id}.json`);
    if (!file) throw new Error("ไม่พบโปรเจกต์นี้");
    const p = normalizeProject(file.content);
    p._sha = file.sha;
    return p;
  }

  async function deleteProjectFromGithub(id) {
    const file = await ghGetFile(`${PROJECTS_DIR}/${id}.json`);
    if (file) await ghDeleteFile(`${PROJECTS_DIR}/${id}.json`, file.sha, `delete project ${id}`);
    await updateProjectIndex({ removeId: id });
  }

  // ---------------------------------------------------------------
  // Firebase Firestore backend (free Spark plan friendly)
  // ---------------------------------------------------------------
  async function getFirebaseRuntime(config = firebaseSettings) {
    if (!config) throw new Error("ยังไม่ได้ตั้งค่า Firebase");
    if (firebaseRuntime && firebaseRuntime.projectId === config.projectId) return firebaseRuntime;
    const [{ initializeApp, getApps }, firestore, authMod, functionsMod] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js"),
    ]);
    const appName = `bill-splitter-${config.projectId}`;
    const app = getApps().find((a) => a.name === appName) || initializeApp(config, appName);
    const auth = authMod.getAuth(app);
    const db = firestore.getFirestore(app);
    const fns = functionsMod.getFunctions(app);
    firebaseRuntime = { ...firestore, ...authMod, ...functionsMod, app, auth, db, fns, projectId: config.projectId };
    return firebaseRuntime;
  }

  function firebaseProjectRef(rt, id) {
    return rt.doc(rt.db, "billProjects", id);
  }
  function firebaseUserRef(rt, uid) {
    return rt.doc(rt.db, "users", uid);
  }
  async function loadUserProfile(user) {
    if (!user) return null;
    const rt = await getFirebaseRuntime();
    const ref = firebaseUserRef(rt, user.uid);
    const snap = await rt.getDoc(ref);
    if (snap.exists()) return snap.data();
    const profile = {
      uid: user.uid,
      email: user.email || "",
      role: "user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await rt.setDoc(ref, profile, { merge: true });
    return profile;
  }
  async function refreshAuthState() {
    await loadBundledFirebaseConfig();
    const rt = await getFirebaseRuntime();
    currentUser = await new Promise((resolve) => {
      const unsub = rt.onAuthStateChanged(rt.auth, (user) => {
        unsub();
        resolve(user);
      });
    });
    currentUserProfile = currentUser ? await loadUserProfile(currentUser) : null;
    updateGhStatus();
    return currentUser;
  }
  // Guests never need an email/password account — they only need *some*
  // Firebase Auth session so Firestore rules can identify them as
  // "signed in" and let them write their own picks. Anonymous Auth gives
  // us that with zero signup friction. We deliberately skip
  // loadUserProfile() here so a stray `users/{uid}` doc isn't created for
  // every one-off guest visit.
  async function ensureGuestSession() {
    await loadBundledFirebaseConfig();
    const rt = await getFirebaseRuntime();
    if (!currentUser) {
      currentUser = await new Promise((resolve) => {
        const unsub = rt.onAuthStateChanged(rt.auth, (user) => {
          unsub();
          resolve(user);
        });
      });
    }
    if (!currentUser) {
      if (!rt.signInAnonymously) {
        throw new Error("Anonymous Authentication ยังไม่ได้เปิดใช้งานใน Firebase Console");
      }
      const cred = await rt.signInAnonymously(rt.auth);
      currentUser = cred.user;
    }
    // Guests keep no elevated profile/role, regardless of whether the
    // session turned out to be anonymous or a previously-logged-in owner
    // account opening their own share link.
    if (isGuestUser()) currentUserProfile = null;
    updateGhStatus();
    return currentUser;
  }

  async function signInWithEmail(email, password) {
    const rt = await getFirebaseRuntime();
    await rt.signInWithEmailAndPassword(rt.auth, email, password);
    await refreshAuthState();
  }
  async function sendPasswordReset(email) {
    const rt = await getFirebaseRuntime();
    await rt.sendPasswordResetEmail(rt.auth, email);
  }
  async function registerWithEmail(email, password) {
    const rt = await getFirebaseRuntime();
    const cred = await rt.createUserWithEmailAndPassword(rt.auth, email, password);
    currentUser = cred.user;
    try {
      currentUserProfile = await loadUserProfile(cred.user);
    } catch (e) {
      throw new Error("สร้างบัญชี Auth สำเร็จแล้ว แต่สร้างโปรไฟล์ใน Firestore ไม่สำเร็จ: " + friendlyFirebaseError(e));
    }
    updateGhStatus();
  }
  function friendlyFirebaseError(e) {
    const code = e && e.code ? e.code : "";
    const map = {
      "auth/email-already-in-use": "อีเมลนี้สมัครไว้แล้ว ให้กดเข้าสู่ระบบแทน",
      "auth/invalid-email": "รูปแบบอีเมลไม่ถูกต้อง",
      "auth/weak-password": "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร",
      "auth/operation-not-allowed": "ยังไม่ได้เปิด Email/Password ใน Firebase Authentication",
      "auth/unauthorized-domain": "ยังไม่ได้เพิ่มโดเมน GitHub Pages ใน Authorized domains ของ Firebase Authentication",
      "auth/network-request-failed": "เชื่อมต่อ Firebase ไม่ได้ ตรวจอินเทอร์เน็ตหรือการบล็อก CDN",
      "auth/invalid-credential": "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
      "auth/user-not-found": "ไม่พบบัญชีที่ใช้อีเมลนี้ ลองสมัครบัญชีใหม่แทน",
      "auth/wrong-password": "รหัสผ่านไม่ถูกต้อง",
      "auth/too-many-requests": "ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่",
      "auth/user-disabled": "บัญชีนี้ถูกระงับการใช้งาน",
      "auth/missing-email": "กรุณากรอกอีเมล",
      "permission-denied": "Firestore Rules ยังไม่อนุญาต ให้ Publish rules ล่าสุดจากไฟล์ firestore.rules",
      "failed-precondition": "Firestore ยังไม่พร้อมหรือ query ต้องการ index",
    };
    return map[code] || e.message || "เกิดข้อผิดพลาดจาก Firebase";
  }
  async function signOutCurrentUser() {
    const rt = await getFirebaseRuntime();
    await rt.signOut(rt.auth);
    currentUser = null;
    currentUserProfile = null;
    currentProject = null;
    updateGhStatus();
    navigate("/");
  }

  // 3-way merge for the fields guests write to concurrently (shares, doneBy):
  // an id "changed" if it differs from the baseline snapshotted when the
  // owner last knew their in-memory copy matched the server. If only the
  // remote side changed (a guest ticked something while the owner was
  // editing something else), the remote value wins; otherwise the owner's
  // local edit wins. This stops an owner's save from clobbering picks a
  // guest made in the same window.
  function threeWayMergeSharesDoneBy(remote, local, baseline) {
    const itemIds = new Set([
      ...Object.keys((remote && remote.shares) || {}),
      ...Object.keys((local && local.shares) || {}),
    ]);
    const sortedKey = (arr) => JSON.stringify([...(arr || [])].sort());
    const mergedShares = {};
    itemIds.forEach((itemId) => {
      const remoteVal = (remote.shares && remote.shares[itemId]) || [];
      const localVal = (local.shares && local.shares[itemId]) || [];
      const baseVal = (baseline.shares && baseline.shares[itemId]) || [];
      const remoteChanged = sortedKey(remoteVal) !== sortedKey(baseVal);
      const localChanged = sortedKey(localVal) !== sortedKey(baseVal);
      mergedShares[itemId] = (remoteChanged && !localChanged) ? remoteVal : localVal;
    });
    const mergedDoneBy = [...new Set([...((remote && remote.doneBy) || []), ...((local && local.doneBy) || [])])];
    return { shares: mergedShares, doneBy: mergedDoneBy };
  }

  async function saveProjectToFirebase(project, summary) {
    if (!isFirebaseConnected()) throw new Error("ยังไม่ได้ตั้งค่า Firebase");
    if (!currentUser) throw new Error("กรุณาเข้าสู่ระบบก่อนบันทึก");
    const rt = await getFirebaseRuntime();
    const cleanProject = normalizeProject(JSON.parse(JSON.stringify(project)));
    cleanProject.ownerUid = cleanProject.ownerUid || currentUser.uid;
    cleanProject.ownerEmail = cleanProject.ownerEmail || currentUser.email || "";
    const baseline = (projectSyncBaseline && projectSyncBaseline.id === cleanProject.id)
      ? projectSyncBaseline
      : snapshotSyncBaseline(cleanProject);

    const ref = firebaseProjectRef(rt, cleanProject.id);
    let finalProject = cleanProject;
    await rt.runTransaction(rt.db, async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists()) {
        const remoteProject = normalizeProject(snap.data().project || {});
        const merged = threeWayMergeSharesDoneBy(remoteProject, cleanProject, baseline);
        finalProject = normalizeProject({ ...cleanProject, shares: merged.shares, doneBy: merged.doneBy });
      }
      finalProject.updatedAt = new Date().toISOString();
      const finalSummary = computeSummary(finalProject);
      const entry = {
        id: finalProject.id,
        name: finalProject.name,
        date: finalProject.date,
        place: finalProject.place || "",
        grandTotal: finalSummary.grandTotal,
        peopleCount: finalProject.people.length,
        ownerUid: finalProject.ownerUid,
        ownerEmail: finalProject.ownerEmail || "",
        updatedAt: finalProject.updatedAt,
      };
      tx.set(ref, { project: finalProject, entry }, { merge: true });
    });
    currentProject = finalProject;
    projectSyncBaseline = snapshotSyncBaseline(finalProject);
    saveDraftLocal(currentProject);
  }

  async function loadProjectFromFirebase(id, config = firebaseSettings) {
    const rt = await getFirebaseRuntime(config);
    const snap = await rt.getDoc(firebaseProjectRef(rt, id));
    if (!snap.exists()) throw new Error("ไม่พบโปรเจกต์นี้ใน Firebase");
    return normalizeProject(snap.data().project || {});
  }

  async function deleteProjectFromFirebase(id) {
    const rt = await getFirebaseRuntime();
    await rt.deleteDoc(firebaseProjectRef(rt, id));
  }

  async function getFirebaseIndex() {
    const rt = await getFirebaseRuntime();
    if (!currentUser) return { entries: [] };
    const base = rt.collection(rt.db, "billProjects");
    const q = isAdmin()
      ? rt.query(base)
      : rt.query(base, rt.where("project.ownerUid", "==", currentUser.uid));
    const snap = await rt.getDocs(q);
    const entries = snap.docs.map((docSnap) => docSnap.data().entry).filter(Boolean)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return { entries };
  }

  async function updateGuestProjectFirebase(projectId, updater, message, config = firebaseSettings) {
    const rt = await getFirebaseRuntime(config);
    const ref = firebaseProjectRef(rt, projectId);
    let nextProject = null;
    await rt.runTransaction(rt.db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("ไม่พบโปรเจกต์นี้ใน Firebase");
      nextProject = normalizeProject(snap.data().project || {});
      updater(nextProject);
      nextProject.updatedAt = new Date().toISOString();
      const summary = computeSummary(nextProject);
      const entry = {
        id: nextProject.id,
        name: nextProject.name,
        date: nextProject.date,
        place: nextProject.place || "",
        grandTotal: summary.grandTotal,
        peopleCount: nextProject.people.length,
        ownerUid: nextProject.ownerUid || "",
        ownerEmail: nextProject.ownerEmail || "",
        updatedAt: nextProject.updatedAt,
      };
      tx.set(ref, { project: nextProject, entry, lastGuestMessage: message || "guest update" }, { merge: true });
    });
    currentProject = normalizeProject(nextProject);
    saveDraftLocal(currentProject);
    return currentProject;
  }

  async function updateGuestProject(projectId, updater, message) {
    const { obj, sha } = await ghPutFileWithRetry(
      `${PROJECTS_DIR}/${projectId}.json`,
      (current) => {
        const next = normalizeProject(current || currentProject);
        updater(next);
        next.updatedAt = new Date().toISOString();
        return next;
      },
      message || `guest update ${projectId}`
    );
    currentProject = normalizeProject(obj);
    currentProject._sha = sha;
    saveDraftLocal(currentProject);
    return currentProject;
  }

  function buildShareLink(project = currentProject) {
    if (!project) throw new Error("ยังไม่มีโปรเจกต์ให้แชร์");
    if (!isFirebaseConnected()) {
      throw new Error("แชร์ให้เพื่อนต้องใช้ Firebase ฟรี เพื่อไม่ต้องฝัง GitHub token ในลิงก์");
    }
    const base = `${window.location.origin}${window.location.pathname}`;
    const parts = [
      "guest",
      project.id,
    ];
    return `${base}#/${parts.join("/")}`;
  }

  // A friendly invite message so a shared link never arrives as a bare URL —
  // the recipient sees what it is and what to do before tapping.
  function buildShareMessage(project, link) {
    const name = (project.name || "").trim();
    const place = (project.place || "").trim();
    const date = (project.date || "").trim();
    const lines = [
      `🧾 มาหารบิล${name ? ` "${name}"` : ""} กัน!`,
    ];
    const meta = [place, date].filter(Boolean).join(" · ");
    if (meta) lines.push(`📍 ${meta}`);
    lines.push("👉 กดลิงก์เพื่อติ๊กเมนูที่คุณกิน แล้วดูยอดที่ต้องจ่าย (ไม่ต้องสมัครสมาชิก)");
    lines.push(link);
    return lines.join("\n");
  }

  // Open the OS share sheet when the platform provides one, so "แชร์" shares
  // the whole invite (text + link), not just a copied URL. Order: the native
  // Capacitor Share plugin (Android/iOS app) -> Web Share API (mobile web) ->
  // return false so the caller can fall back to clipboard. A user-cancelled
  // share counts as handled (true) — we must not then also copy.
  async function tryNativeShare({ title, text, url }) {
    try {
      const cap = window.Capacitor;
      const SharePlugin = cap && cap.Plugins && cap.Plugins.Share;
      if (SharePlugin && (!cap.isNativePlatform || cap.isNativePlatform())) {
        await SharePlugin.share({ title, text, url, dialogTitle: title });
        return true;
      }
    } catch (e) {
      // Plugin present but the user dismissed the sheet — treat as done.
      if (e && /cancel|dismiss|abort/i.test(String(e.message || e))) return true;
    }
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url });
        return true;
      }
    } catch (e) {
      if (e && (e.name === "AbortError" || /cancel|abort/i.test(String(e.message || e)))) return true;
      // Any other Web Share failure -> fall through to clipboard.
    }
    return false;
  }

  async function shareProjectLink(project = currentProject) {
    // Copy FIRST, before any awaited work. Browsers only honor a clipboard
    // write during the click's transient user activation; an awaited network/DB
    // save (or the focus shift it causes) revokes that activation, so a copy
    // that runs *after* the save is rejected — which is exactly the "เปิดการ
    // แชร์แล้ว แต่คัดลอกลิงก์ไม่สำเร็จ" case. The link is deterministic from
    // project.id, so it doesn't need the save to finish first. Callers must
    // therefore invoke this BEFORE any await, not after persisting.
    let link, message;
    try {
      link = buildShareLink(project);
      message = buildShareMessage(project, link);
    } catch (e) {
      toast(e.message || "สร้างลิงก์แชร์ไม่สำเร็จ", true);
      return;
    }
    // Prefer the OS share sheet (shares text + link together); only copy the
    // full invite to the clipboard when no share sheet is available. Both run
    // BEFORE the persist await so the click's user activation is still valid.
    let copyOk = true;
    let usedShareSheet = false;
    usedShareSheet = await tryNativeShare({ title: "หารบิล", text: message, url: link });
    if (!usedShareSheet) {
      try {
        await copyText(message);
      } catch (e) {
        copyOk = false;
      }
    }
    // Now persist the shares/doneBy the user just ticked and turn guest access
    // on. persistDraftAndMaybeGithub saves the local draft plus Firebase or
    // GitHub (whichever is connected) and surfaces its own error toast on
    // failure, so it covers every storage mode.
    try {
      // persistDraftAndMaybeGithub() saves currentProject, so the guestAccess
      // flag must be set on that same object. Sharing only ever targets the
      // open project; bail if a caller passes anything else. Compare by id,
      // not object identity: the summary's live-sync replaces currentProject
      // with a fresh normalized object on every snapshot, so a handler that
      // captured the project at render time would otherwise fail this check
      // even though it IS the open project.
      if (!currentProject || project.id !== currentProject.id) {
        toast("แชร์ได้เฉพาะโปรเจกต์ที่เปิดอยู่", true);
        return;
      }
      currentProject.guestAccess = true;
      const ok = await persistDraftAndMaybeGithub();
      if (!ok) return;
      if (usedShareSheet) {
        toast("เปิดการแชร์แล้ว — เลือกแอปที่จะส่งลิงก์ให้เพื่อนได้เลย");
      } else {
        toast(copyOk
          ? "คัดลอกข้อความชวนหารบิลพร้อมลิงก์แล้ว — วางส่งให้เพื่อนได้เลย ทุกคนที่มีลิงก์จะเห็นชื่อและยอดของทุกคน"
          : "เปิดการแชร์แล้ว แต่คัดลอกไม่สำเร็จ — แตะลิงก์นี้ค้างเพื่อคัดลอกเอง: " + link, !copyOk);
      }
    } catch (e) {
      toast("บันทึกการแชร์ไม่สำเร็จ: " + (e.message || ""), true);
    }
  }

  function applyGuestSettings(parts) {
    settings = null;
    indexCache = null;
    updateGhStatus();
  }

  // ---------------------------------------------------------------
  // Project model
  // ---------------------------------------------------------------
  function blankProject() {
    return {
      id: uuid(), name: "", date: todayISO(), place: "", promptPayId: "",
      ownerUid: currentUser ? currentUser.uid : "",
      ownerEmail: currentUser ? (currentUser.email || "") : "",
      totalDiscount: 0, serviceChargePercent: 0, vatPercent: 0,
      items: [], people: [], shares: {}, doneBy: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  }
  function saveDraftLocal(project) {
    localStorage.setItem(DRAFT_KEY_PREFIX + project.id, JSON.stringify(project));
  }
  function loadDraftLocal(id) {
    const raw = localStorage.getItem(DRAFT_KEY_PREFIX + id);
    return raw ? normalizeProject(JSON.parse(raw)) : null;
  }
  // Every visit to /project/new (and every unfinished wizard session) leaves
  // a draft behind that's never cleaned up otherwise — sweep out anything
  // stale on startup so localStorage doesn't grow unbounded.
  function purgeOldDrafts(maxAgeDays = 14) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    Object.keys(localStorage)
      .filter((k) => k.startsWith(DRAFT_KEY_PREFIX))
      .forEach((k) => {
        try {
          const draft = JSON.parse(localStorage.getItem(k));
          const ts = draft && (draft.updatedAt || draft.createdAt);
          if (!ts || new Date(ts).getTime() < cutoff) localStorage.removeItem(k);
        } catch {
          localStorage.removeItem(k);
        }
      });
  }

  // ---------------------------------------------------------------
  // Calculation engine — mirrors the Form_bill logic:
  // each item's share of a single total discount is proportional to
  // its price; remaining cost of each item is split evenly among the
  // people marked as having shared it; service charge / VAT (if any)
  // are then distributed proportionally to each person's subtotal.
  // ---------------------------------------------------------------
  // Raw per-person floats can be off by a satang or two from the displayed
  // grand total once each is independently rounded to 2dp — nitpicky but
  // visible on the receipt people screenshot into group chats. Redistribute
  // the rounding remainder (in satang) to the largest fractional parts first
  // so the displayed per-person amounts always sum to exactly grandTotal.
  function reconcilePersonTotals(personFinal, grandTotal) {
    if (!personFinal.length) return personFinal;
    const rawSatang = personFinal.map((p) => p.total * 100);
    const flooredSatang = rawSatang.map(Math.floor);
    let diff = Math.round(grandTotal * 100) - flooredSatang.reduce((a, b) => a + b, 0);
    const order = personFinal
      .map((_, i) => i)
      .sort((a, b) => (rawSatang[b] - flooredSatang[b]) - (rawSatang[a] - flooredSatang[a]));
    const finalSatang = [...flooredSatang];
    let idx = 0;
    while (diff !== 0 && order.length) {
      const target = order[idx % order.length];
      finalSatang[target] += diff > 0 ? 1 : -1;
      diff += diff > 0 ? -1 : 1;
      idx++;
    }
    return personFinal.map((p, i) => ({ ...p, total: finalSatang[i] / 100 }));
  }

  function computeSummary(project) {
    const items = project.items || [];
    const people = project.people || [];
    const sumPrices = items.reduce((s, it) => s + (Number(it.price) || 0), 0);
    const totalDiscount = Math.min(moneyNumber(project.totalDiscount), sumPrices);

    const itemResults = items.map((it) => {
      const price = Number(it.price) || 0;
      const discountShare = sumPrices > 0 ? (price / sumPrices) * totalDiscount : 0;
      const priceAfter = Math.max(0, price - discountShare);
      const sharers = (project.shares && project.shares[it.id]) || [];
      const perPerson = sharers.length > 0 ? priceAfter / sharers.length : 0;
      return { ...it, price, discountShare, priceAfter, sharers, perPerson };
    });

    const subtotalAfterDiscount = itemResults.reduce((s, it) => s + it.priceAfter, 0);
    const serviceCharge = subtotalAfterDiscount * ((Number(project.serviceChargePercent) || 0) / 100);
    const vat = (subtotalAfterDiscount + serviceCharge) * ((Number(project.vatPercent) || 0) / 100);
    const grandTotal = subtotalAfterDiscount + serviceCharge + vat;

    const personTotals = {};
    people.forEach((p) => (personTotals[p.id] = 0));
    itemResults.forEach((it) => it.sharers.forEach((pid) => {
      if (personTotals[pid] === undefined) personTotals[pid] = 0;
      personTotals[pid] += it.perPerson;
    }));

    const personFinal = people.map((p) => {
      const base = personTotals[p.id] || 0;
      const ratio = subtotalAfterDiscount > 0 ? base / subtotalAfterDiscount : 0;
      const extra = ratio * (serviceCharge + vat);
      return { id: p.id, name: p.name, base, extra, total: base + extra };
    });
    const reconciledPeople = reconcilePersonTotals(personFinal, grandTotal);

    const unassignedItems = itemResults.filter((it) => it.sharers.length === 0 && it.price > 0);

    return {
      items: itemResults, people: reconciledPeople, sumPrices, totalDiscount,
      subtotalAfterDiscount, serviceCharge, vat, grandTotal, unassignedItems,
    };
  }

  // ---------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------
  function parseHash() {
    const h = window.location.hash.replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean);
    return parts; // [] -> home, ["project","new"], ["project",id,step]
  }

  async function router() {
    const parts = parseHash();
    stopLiveSync();
    try {
      if (parts[0] === "guest" && parts[1]) {
        applyGuestSettings(parts);
        try {
          await ensureGuestSession();
        } catch (e) {
          renderGuestSessionError(e);
          return;
        }
        try {
          await renderGuestMode(parts[1]);
        } catch (e) {
          // A dead/revoked link, or the owner turned guestAccess off — either
          // way this is still a guest, so show a guest-appropriate error
          // instead of falling through to the owner's home view.
          console.error(e);
          renderGuestLoadError(e);
        }
        return;
      }
      if (!isFirebaseConnected()) await loadBundledFirebaseConfig();
      if (!currentUser && !["login"].includes(parts[0])) {
        await refreshAuthState();
      }
      // Guest routes (#/guest/...) already returned above. If we reach here as
      // an anonymous "guest" session, it's a leftover from previously opening a
      // share link — Firebase persists that anonymous sign-in in the browser.
      // Left as-is it counts as "logged in", so the owner is trapped in guest
      // mode: the login form is skipped and the logout button is hidden. Drop
      // the anonymous session so the auth gate shows and they can sign in.
      if (currentUser && isGuestUser()) {
        try {
          const rt = await getFirebaseRuntime();
          await rt.signOut(rt.auth);
        } catch (e) { console.error(e); }
        currentUser = null;
        currentUserProfile = null;
      }
      if (parts[0] === "login") {
        renderAuthGate();
        return;
      }
      if (!currentUser) {
        // Preserve the deep link (e.g. a project the user bookmarked) so
        // signing in returns them to where they were instead of home.
        const deepLink = window.location.hash ? window.location.hash.replace(/^#/, "") : null;
        renderAuthGate(deepLink);
        return;
      }
      if (parts[0] === "admin") {
        await renderAdmin();
        return;
      }
      if (parts[0] === "project" && parts[1] === "new") {
        currentProject = blankProject();
        saveDraftLocal(currentProject);
        projectSyncBaseline = snapshotSyncBaseline(currentProject);
        // Replace this history entry instead of pushing a new one — otherwise
        // pressing Back from step 1 lands on /project/new again and creates
        // yet another blank project, forever.
        const url = window.location.pathname + window.location.search
          + `#/project/${currentProject.id}/info`;
        window.history.replaceState(null, "", url);
        router();
        return;
      }
      if (parts[0] === "project" && parts[1]) {
        const id = parts[1];
        const step = parts[2] || "info";
        if (!currentProject || currentProject.id !== id) {
          if (isFirebaseConnected()) {
            // Server-first: guests may have changed shares/doneBy since we
            // last had this project open, so a stale localStorage draft is
            // only trusted as a last resort when the live fetch itself fails
            // (e.g. offline) — never as the default source of truth.
            try {
              currentProject = await loadProjectFromFirebase(id);
              saveDraftLocal(currentProject);
            } catch (e) {
              // Distinguish "the doc genuinely doesn't exist" (e.g. it was
              // deleted) from a transient failure like being offline — only
              // the latter should fall back to a possibly-stale local draft.
              // Otherwise a deleted project can resurrect itself from the
              // orphaned draft and get re-created on the next save.
              const notFound = e && e.message === "ไม่พบโปรเจกต์นี้ใน Firebase";
              if (notFound) {
                localStorage.removeItem(DRAFT_KEY_PREFIX + id);
                currentProject = null;
              } else {
                currentProject = loadDraftLocal(id);
                if (currentProject) {
                  toast("โหลดข้อมูลล่าสุดจาก Firebase ไม่ได้ กำลังใช้ข้อมูลที่บันทึกไว้ในเครื่องแทน (อาจไม่ใช่ข้อมูลล่าสุด)", true);
                }
              }
            }
          } else {
            currentProject = loadDraftLocal(id);
            if (!currentProject && isConnected()) {
              currentProject = await loadProjectFromGithub(id);
              saveDraftLocal(currentProject);
            }
          }
          if (!currentProject) { toast("ไม่พบโปรเจกต์นี้", true); navigate("/"); return; }
          projectSyncBaseline = snapshotSyncBaseline(currentProject);
        }
        renderWizard(step);
        return;
      }
      await renderHome();
    } catch (e) {
      console.error(e);
      toast(e.message || "เกิดข้อผิดพลาด", true);
      // If we don't have a signed-in user at this point, the failure happened
      // during Firebase init/auth itself (e.g. the SDK couldn't be fetched
      // over a flaky connection) — renderHome() assumes a working connection
      // and will throw trying to read currentUser fields, so show a proper
      // retryable error screen instead of a view that's guaranteed to crash.
      if (!currentUser) {
        renderFatalError(e);
      } else {
        renderHome();
      }
    }
  }

  function renderFatalError(e) {
    const root = document.getElementById("view-root");
    root.innerHTML = `
      <div class="empty-state">
        <div class="emoji">⚠️</div>
        <p>โหลดแอปไม่สำเร็จ — ${escapeHtml((e && e.message) || "เกิดข้อผิดพลาดที่ไม่คาดคิด")}</p>
        <p class="section-sub">ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต หรือลองรีเฟรชหน้าอีกครั้ง</p>
        <br><button class="btn primary" id="fatal-retry-btn">🔄 ลองใหม่</button>
      </div>`;
    root.querySelector("#fatal-retry-btn").onclick = () => router();
  }

  // ---------------------------------------------------------------
  // View: Auth / Admin
  // ---------------------------------------------------------------
  function renderAuthGate(returnHash) {
    const root = document.getElementById("view-root");
    // mode: "choice" -> pick register/login first; "register"/"login" -> show email form
    let mode = "choice";

    function draw() {
      const isRegister = mode === "register";
      const isChoice = mode === "choice";
      const formHtml = isChoice ? "" : `
          <form id="auth-form">
            <button type="button" class="btn ghost sm auth-back" id="auth-back-btn">← ย้อนกลับ</button>
            <div class="auth-mode-head">${isRegister ? "สมัครบัญชีใหม่" : "เข้าสู่ระบบ"}</div>
            <div class="field"><label>Email</label><input type="email" inputmode="email" id="auth-email" autocomplete="email" required></div>
            <div class="field"><label>Password</label><input type="password" id="auth-password" autocomplete="${isRegister ? "new-password" : "current-password"}" required minlength="6"></div>
            <div class="modal-actions" style="justify-content:flex-start;">
              <button type="submit" class="btn primary" id="auth-submit-btn">${isRegister ? "สมัครบัญชี" : "เข้าสู่ระบบ"}</button>
              ${isRegister
                ? `<button type="button" class="btn ghost" id="auth-switch-btn">มีบัญชีแล้ว? เข้าสู่ระบบ</button>`
                : `<button type="button" class="btn ghost" id="auth-switch-btn">ยังไม่มีบัญชี? สมัครใหม่</button>`}
            </div>
            ${isRegister ? "" : `<button type="button" class="btn ghost sm" id="auth-forgot-btn" style="margin-top:4px;">ลืมรหัสผ่าน?</button>`}
            <div class="settings-test-result" id="auth-result"></div>
          </form>`;
      const choiceHtml = isChoice ? `
          <div class="auth-choice">
            <button type="button" class="btn primary auth-choice-btn" id="auth-choose-register">สมัครสมาชิกใหม่</button>
            <button type="button" class="btn ghost auth-choice-btn" id="auth-choose-login">มีบัญชีแล้ว เข้าสู่ระบบ</button>
          </div>` : "";
      root.innerHTML = `
      <div class="auth-shell">
        <div class="card auth-card">
          <div class="section-title">หารบิลอย่างแฟร์ ครบ จบในลิงก์เดียว</div>
          <div class="section-sub">
            แบ่งจ่ายบิลกับเพื่อนแบบยุติธรรม แต่ละคนติ๊กเฉพาะเมนูที่ตัวเองกิน
            ระบบสรุปยอดให้อัตโนมัติพร้อมใบเสร็จและ QR PromptPay
          </div>
          <div class="how-row">
            <div class="how-step"><span class="how-num">1</span><span>กรอกเมนู<br>&amp; รายชื่อ</span></div>
            <div class="how-step"><span class="how-num">2</span><span>แชร์ลิงก์<br>ให้เพื่อนติ๊ก</span></div>
            <div class="how-step"><span class="how-num">3</span><span>ได้ยอด<br>&amp; ใบเสร็จ</span></div>
          </div>
          <div class="help-box" style="margin-bottom:18px;">
            💡 เฉพาะ<strong>เจ้าของบิล</strong>ต้องมีบัญชีเพื่อเก็บโปรเจกต์ไว้ —
            เพื่อนที่กดลิงก์แชร์ <strong>ไม่ต้องสมัครหรือเข้าสู่ระบบ</strong>
          </div>
          ${choiceHtml}${formHtml}
        </div>
      </div>`;
      wire();
    }

    function wire() {
      if (mode === "choice") {
        root.querySelector("#auth-choose-register").onclick = () => { mode = "register"; draw(); };
        root.querySelector("#auth-choose-login").onclick = () => { mode = "login"; draw(); };
        return;
      }
      const result = root.querySelector("#auth-result");
      const emailEl = root.querySelector("#auth-email");
      const passEl = root.querySelector("#auth-password");
      emailEl.focus();
      async function runAuth() {
        const email = emailEl.value.trim();
        const password = passEl.value;
        if (!email || !password) return;
        result.textContent = mode === "register" ? "กำลังสมัครบัญชี..." : "กำลังเข้าสู่ระบบ...";
        result.className = "settings-test-result";
        try {
          if (mode === "register") await registerWithEmail(email, password);
          else await signInWithEmail(email, password);
          result.textContent = "สำเร็จ";
          result.className = "settings-test-result ok";
          navigate(returnHash || "/");
          router();
        } catch (e) {
          result.textContent = "❌ " + friendlyFirebaseError(e);
          result.className = "settings-test-result fail";
        }
      }
      root.querySelector("#auth-form").onsubmit = (e) => { e.preventDefault(); runAuth(); };
      root.querySelector("#auth-back-btn").onclick = () => { mode = "choice"; draw(); };
      root.querySelector("#auth-switch-btn").onclick = () => {
        mode = mode === "register" ? "login" : "register";
        draw();
      };
      const forgotBtn = root.querySelector("#auth-forgot-btn");
      if (forgotBtn) forgotBtn.onclick = async () => {
        const email = emailEl.value.trim();
        if (!email) {
          result.textContent = "❌ กรอกอีเมลก่อนกดลืมรหัสผ่าน";
          result.className = "settings-test-result fail";
          emailEl.focus();
          return;
        }
        result.textContent = "กำลังส่งอีเมลรีเซ็ตรหัสผ่าน...";
        result.className = "settings-test-result";
        try {
          await sendPasswordReset(email);
          result.textContent = "✅ ส่งอีเมลรีเซ็ตรหัสผ่านแล้ว ตรวจสอบกล่องจดหมายของคุณ";
          result.className = "settings-test-result ok";
        } catch (e) {
          result.textContent = "❌ " + friendlyFirebaseError(e);
          result.className = "settings-test-result fail";
        }
      };
    }

    draw();
  }

  function renderGuestSessionError(e) {
    const root = document.getElementById("view-root");
    root.innerHTML = `<div class="guest-shell">
      <div class="card guest-card">
        <div class="section-title">เข้าร่วมหารบิลไม่สำเร็จ</div>
        <div class="section-sub">${escapeHtml((e && e.message) || "เกิดข้อผิดพลาด")}</div>
        <div class="help-box">💡 ถ้าเจ้าของโปรเจกต์เห็นข้อความนี้แจ้งมา ให้ตรวจว่าเปิด
          <strong>Anonymous</strong> ไว้ใน Firebase Console → Authentication → Sign-in method แล้วหรือยัง</div>
        <div class="wizard-footer">
          <button class="btn primary" id="guest-retry-btn">ลองใหม่</button>
        </div>
      </div>
    </div>`;
    root.querySelector("#guest-retry-btn").onclick = () => router();
  }

  function renderGuestLoadError(e) {
    const root = document.getElementById("view-root");
    root.innerHTML = `<div class="guest-shell">
      <div class="card guest-card">
        <div class="section-title">ลิงก์นี้ใช้งานไม่ได้</div>
        <div class="section-sub">${escapeHtml((e && e.message) || "ไม่พบโปรเจกต์นี้")}</div>
        <div class="help-box">💡 ลิงก์อาจพิมพ์ผิด, โปรเจกต์ถูกลบไปแล้ว หรือเจ้าของโปรเจกต์ปิดการแชร์แล้ว — ลองขอลิงก์ใหม่จากเจ้าของบิล</div>
        <div class="wizard-footer">
          <button class="btn primary" id="guest-load-retry-btn">ลองใหม่</button>
        </div>
      </div>
    </div>`;
    root.querySelector("#guest-load-retry-btn").onclick = () => router();
  }

  async function renderAdmin() {
    const root = document.getElementById("view-root");
    if (!isAdmin()) {
      root.innerHTML = `<div class="empty-state"><div class="emoji">⛔</div><p>บัญชีนี้ไม่มีสิทธิ์ Admin</p></div>`;
      return;
    }
    const rt = await getFirebaseRuntime();
    root.innerHTML = `<div class="empty-state">กำลังโหลด Admin...</div>`;
    const [projectSnap, userSnap] = await Promise.all([
      rt.getDocs(rt.collection(rt.db, "billProjects")),
      rt.getDocs(rt.collection(rt.db, "users")),
    ]);
    const projects = projectSnap.docs.map((d) => d.data().entry || {}).filter(Boolean)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const users = userSnap.docs.map((d) => d.data()).filter(Boolean)
      .sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));
    root.innerHTML = `
      <div class="toolbar-row">
        <div><div class="section-title">ผู้ดูแลระบบ</div><div class="section-sub">ดูข้อมูลรวมของระบบ</div></div>
        <button class="btn ghost" id="admin-home">กลับหน้าหลัก</button>
      </div>
      <div class="dash-grid">
        <div class="card stat-card"><div class="stat-value">${projects.length}</div><div class="stat-label">โปรเจกต์ทั้งหมด</div></div>
        <div class="card stat-card"><div class="stat-value">${users.length}</div><div class="stat-label">ผู้ใช้ทั้งหมด</div></div>
      </div>
      <div class="card" style="margin-bottom:20px;">
        <h3 class="section-title" style="font-size:0.95rem;">โปรเจกต์ทั้งหมด</h3>
        <div class="admin-list">${projects.map((p) => `
          <div class="admin-row">
            <div><strong>${escapeHtml(p.name || "(ไม่มีชื่อ)")}</strong><br><span>${escapeHtml(p.ownerEmail || "-")} · ${escapeHtml(p.date || "")}</span></div>
            <div>฿${baht(p.grandTotal || 0)}</div>
          </div>`).join("") || `<div class="empty-state">ยังไม่มีโปรเจกต์</div>`}
        </div>
      </div>
      <div class="card">
        <h3 class="section-title" style="font-size:0.95rem;">ผู้ใช้</h3>
        <div class="admin-list">${users.map((u) => `
          <div class="admin-row">
            <div><strong>${escapeHtml(u.email || "(ไม่มีอีเมล)")}</strong><br><span>${escapeHtml(u.uid || "")}</span></div>
            <div class="badge ${u.role === "admin" ? "ok" : "warn"}">${escapeHtml(u.role || "user")}</div>
          </div>`).join("") || `<div class="empty-state">ยังไม่มีผู้ใช้</div>`}
        </div>
      </div>`;
    root.querySelector("#admin-home").onclick = () => navigate("/");
  }

  // ---------------------------------------------------------------
  // View: Home
  // ---------------------------------------------------------------
  async function renderHome() {
    const root = document.getElementById("view-root");
    if (!isConnected() && !isFirebaseConnected()) {
      root.innerHTML = `
        <div class="card connect-banner">
          <div>
            <h3>โหลดการตั้งค่าที่เก็บข้อมูลไม่สำเร็จ</h3>
            <p>ไม่พบหรือโหลดไฟล์ firebase-config.json ไม่ได้ — ตรวจว่าไฟล์นี้อยู่ในโฟลเดอร์เดียวกับ index.html และมีค่าครบ (ดู README) แล้วลองใหม่</p>
          </div>
          <button class="btn primary" id="home-connect-btn">🔄 ลองใหม่</button>
        </div>
        <div class="empty-state">
          <div class="emoji">🧾</div>
          <p>เริ่มสร้างโปรเจกต์หารบิลแรกของคุณได้เลย แม้ยังเชื่อมต่อที่เก็บข้อมูลไม่สำเร็จ<br>(ข้อมูลจะถูกเก็บไว้ในเบราว์เซอร์นี้ก่อน จนกว่าจะเชื่อมต่อได้และบันทึก)</p>
          <br><button class="btn secondary" id="home-new-btn-empty">+ สร้างโปรเจกต์ใหม่</button>
        </div>`;
      root.querySelector("#home-connect-btn").onclick = () => {
        indexCache = null;
        firebaseRuntime = null;
        toast("กำลังลองโหลดการตั้งค่าที่เก็บข้อมูลอีกครั้ง...");
        router();
      };
      root.querySelector("#home-new-btn-empty").onclick = () => navigate("/project/new");
      return;
    }

    const storageName = isAdmin()
      ? `ผู้ดูแลระบบ · Firebase: ${escapeHtml(firebaseSettings.projectId)}`
      : `บัญชี ${escapeHtml((currentUser && currentUser.email) || "")}`;
    root.innerHTML = `<div class="toolbar-row"><div><div class="section-title">โปรเจกต์หารบิล</div>
      <div class="section-sub">เก็บไว้ที่ ${storageName}</div></div>
      <button class="btn primary" id="home-new-btn">+ สร้างโปรเจกต์ใหม่</button></div>
      <div id="home-list"><div class="empty-state">กำลังโหลด...</div></div>`;
    root.querySelector("#home-new-btn").onclick = () => navigate("/project/new");

    try {
      const idx = isFirebaseConnected() ? await getFirebaseIndex() : await getIndex(true);
      const listEl = root.querySelector("#home-list");
      // Index entries are stored data (Firestore/GitHub), not necessarily
      // written by this version of the app — normalize so a legacy or
      // malformed entry (missing peopleCount, non-string id, etc.) can't
      // break rendering or the data-id-based selector below.
      const entries = idx.entries.map(normalizeIndexEntry).filter((e) => e.id);
      if (!entries.length) {
        listEl.innerHTML = `<div class="empty-state"><div class="emoji">📭</div><p>ยังไม่มีโปรเจกต์ — เริ่มสร้างโปรเจกต์แรกของคุณ</p></div>`;
        updateGhStatus();
        return;
      }
      listEl.innerHTML = `<div class="project-grid">${entries.map(projectCardHtml).join("")}</div>`;
      entries.forEach((e) => {
        const card = listEl.querySelector(`[data-id="${CSS.escape(e.id)}"]`);
        const openArea = card.querySelector(".open-area");
        openArea.onclick = () => navigate(`/project/${e.id}/summary`);
        makeKeyboardActivatable(openArea);
        card.querySelector(".btn-del").onclick = (ev) => {
          ev.stopPropagation();
          const storageLabel = isFirebaseConnected() ? "Firebase" : "GitHub";
          confirmModal("ลบโปรเจกต์นี้?", `จะลบข้อมูลของ "${e.name}" ออกจาก ${storageLabel} อย่างถาวร`, async () => {
            if (isFirebaseConnected()) await deleteProjectFromFirebase(e.id);
            else await deleteProjectFromGithub(e.id);
            localStorage.removeItem(DRAFT_KEY_PREFIX + e.id);
            toast("ลบโปรเจกต์แล้ว");
            renderHome();
          });
        };
      });
      updateGhStatus();
    } catch (e) {
      updateGhStatus("error");
      root.querySelector("#home-list").innerHTML =
        `<div class="empty-state"><div class="emoji">⚠️</div><p>${escapeHtml(e.message)}</p></div>`;
    }
  }

  // Defensive normalization for project-index entries: they're read back
  // from Firestore/GitHub as opaque stored data, not necessarily written by
  // this version of the app, so coerce every field to the type the UI
  // assumes instead of trusting it directly.
  function normalizeIndexEntry(e) {
    return {
      id: String((e && e.id) || ""),
      name: String((e && e.name) || ""),
      date: String((e && e.date) || ""),
      place: String((e && e.place) || ""),
      grandTotal: Number(e && e.grandTotal) || 0,
      peopleCount: Number(e && e.peopleCount) || 0,
      ownerEmail: String((e && e.ownerEmail) || ""),
      updatedAt: String((e && e.updatedAt) || ""),
    };
  }
  function projectCardHtml(e) {
    return `<div class="card project-card" data-id="${escapeHtml(e.id)}">
      <div class="open-area">
        <h4>${escapeHtml(e.name || "(ไม่มีชื่อ)")}</h4>
        <div class="meta">${escapeHtml(e.place || "")} · ${escapeHtml(e.date || "")} · ${e.peopleCount} คน${isAdmin() && e.ownerEmail ? ` · ${escapeHtml(e.ownerEmail)}` : ""}</div>
        <div class="amount-label">ยอดรวม</div>
        <div class="amount">฿${baht(e.grandTotal)}</div>
      </div>
      <div class="card-actions">
        <button class="btn-del" title="ลบ">🗑️</button>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------
  // View: Guest self-select
  // ---------------------------------------------------------------
  async function renderGuestMode(projectId) {
    const root = document.getElementById("view-root");
    root.innerHTML = `<div class="guest-shell"><div class="empty-state">กำลังโหลดโปรเจกต์...</div></div>`;
    currentProject = await loadProjectFromFirebase(projectId, firebaseSettings);
    saveDraftLocal(currentProject);

    const guestKey = `billsplit_guest_${projectId}`;
    const savedPersonId = localStorage.getItem(guestKey);
    const savedPerson = currentProject.people.find((p) => p.id === savedPersonId);
    let currentView = savedPerson ? { type: "split", personId: savedPerson.id } : { type: "picker" };
    let guestSyncError = null;

    // Shown only to the project owner previewing their own project's guest
    // view (a real anonymous guest has no owner summary to return to). Lets
    // them jump back out instead of relying on the browser/system back button.
    function ownerBannerHtml() {
      const isOwner = currentUser && currentProject && currentProject.ownerUid
        && currentProject.ownerUid === currentUser.uid;
      if (!isOwner) return "";
      return `<div class="card" style="border-color:var(--accent); margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <span class="section-sub" style="margin:0;">👁️ กำลังดูมุมมองเกส (ในฐานะเจ้าของบิล)</span>
        <button class="btn ghost sm" id="owner-exit-guest-btn">← ออกจากโหมดเกส</button>
      </div>`;
    }

    function shell(inner) {
      root.innerHTML = `<div class="guest-shell">${ownerBannerHtml()}${guestSyncError ? syncErrorBannerHtml() : ""}${inner}</div>`;
      const retryBtn = root.querySelector("#guest-sync-retry");
      if (retryBtn) retryBtn.onclick = () => { guestSyncError = null; renderCurrentView(); };
      const exitBtn = root.querySelector("#owner-exit-guest-btn");
      if (exitBtn) exitBtn.onclick = () => navigate("/project/" + projectId + "/summary");
    }

    function syncErrorBannerHtml() {
      return `<div class="card" style="border-color:var(--danger); margin-bottom:14px;">
        <strong>⚠️ ซิงก์ข้อมูลล้มเหลว</strong>
        <div class="section-sub">${escapeHtml(guestSyncError)}</div>
        <button class="btn ghost sm" id="guest-sync-retry" style="margin-top:8px;">ลองใหม่</button>
      </div>`;
    }

    function doneSet() {
      const validIds = new Set(currentProject.people.map((p) => p.id));
      return new Set((currentProject.doneBy || []).filter((id) => validIds.has(id)));
    }

    // Colored step indicator shown across the whole guest flow so a friend
    // always knows where they are: check menu -> confirm mine -> wait for
    // friends -> everyone done, pay. `caption` overrides the default status
    // line (used to inject the live "waiting for N more" count).
    const GUEST_STAGES = [
      { key: "check",   label: "เช็ครายละเอียด", icon: "🔍", desc: "กำลังเช็ครายละเอียดเมนูของคุณ" },
      { key: "confirm", label: "ยืนยันของฉัน",   icon: "✍️", desc: "ตรวจแล้วกดยืนยันรายละเอียดของคุณ" },
      { key: "waiting", label: "รอเพื่อน",        icon: "⏳", desc: "รอเพื่อนยืนยันให้ครบทุกคน" },
      { key: "done",    label: "จ่ายเงินได้",     icon: "✅", desc: "ยืนยันครบทุกคนแล้ว จ่ายเงินได้เลย" },
    ];
    function guestProgressHtml(stageKey, caption) {
      const order = GUEST_STAGES.map((s) => s.key);
      const idx = Math.max(0, order.indexOf(stageKey));
      let steps = '<div class="gp-steps">';
      GUEST_STAGES.forEach((st, i) => {
        if (i > 0) steps += `<div class="gp-line ${i <= idx ? "on" : ""}"></div>`;
        const state = i < idx ? "complete" : i === idx ? "current" : "upcoming";
        steps += `<div class="gp-node ${state}">
          <span class="gp-dot">${i < idx ? "✓" : i + 1}</span>
          <span class="gp-label">${st.label}</span>
        </div>`;
      });
      steps += "</div>";
      const cur = GUEST_STAGES[idx];
      return `<div class="guest-progress" data-stage="${cur.key}">
        ${steps}
        <div class="gp-caption">${cur.icon} ${escapeHtml(caption || cur.desc)}</div>
      </div>`;
    }

    function renderCurrentView() {
      if (currentView.type === "picker") renderGuestNamePicker();
      else if (currentView.type === "split") renderGuestSplit(currentView.personId);
      else renderGuestSummary(currentView.personId);
    }

    // Realtime sync: reflect what other guests (and the owner) do without
    // needing a manual refresh. Falls back gracefully — if this fails to
    // attach, writes/reads still work, they just won't be live.
    try {
      const rt = await getFirebaseRuntime(firebaseSettings);
      stopLiveSync();
      activeSnapshotUnsub = rt.onSnapshot(
        firebaseProjectRef(rt, projectId),
        (snap) => {
          if (!snap.exists()) return;
          currentProject = normalizeProject(snap.data().project || {});
          saveDraftLocal(currentProject);
          rerenderPreservingScroll(renderCurrentView);
        },
        (err) => {
          guestSyncError = "หลุดการเชื่อมต่อแบบเรียลไทม์: " + (err.message || err);
          renderCurrentView();
        }
      );
    } catch (e) {
      console.error(e);
    }

    renderCurrentView();

    function renderGuestNamePicker() {
      currentView = { type: "picker" };
      const done = doneSet();
      const people = currentProject.people.filter((p) => p.name.trim());
      const nameCounts = {};
      people.forEach((p) => {
        const key = p.name.trim();
        nameCounts[key] = (nameCounts[key] || 0) + 1;
      });
      const hasDup = Object.values(nameCounts).some((c) => c > 1);
      shell(`
        <div class="card guest-card">
          ${guestProgressHtml("check", "เลือกชื่อของคุณเพื่อเริ่มเช็ครายละเอียดเมนู")}
          <div class="section-title">เลือกชื่อของคุณ</div>
          <div class="section-sub">${escapeHtml(currentProject.name || "โปรเจกต์หารบิล")} · ${escapeHtml(currentProject.place || "")}</div>
          <div class="guest-name-grid">
            ${people.map((p) => {
              const isDup = nameCounts[p.name.trim()] > 1;
              return `<button class="guest-name-card ${done.has(p.id) ? "done" : ""}" data-person="${p.id}">
                <span>${escapeHtml(p.name)}${isDup ? ` <small style="opacity:.6;">#${escapeHtml(p.id.slice(-4))}</small>` : ""}</span>
                <small>${done.has(p.id) ? "เลือกแล้ว" : "คลิกเพื่อเลือกเมนู"}</small>
              </button>`;
            }).join("")}
          </div>
          ${hasDup ? `<div class="help-box">💡 มีชื่อซ้ำกันในรายชื่อ — ถ้าไม่แน่ใจว่าใบไหนคือของคุณ ให้ถามเจ้าของโปรเจกต์ (สังเกตรหัสต่อท้ายชื่อ)</div>` : ""}
        </div>
      `);
      root.querySelectorAll(".guest-name-card").forEach((card) => {
        card.onclick = () => {
          localStorage.setItem(guestKey, card.dataset.person);
          renderGuestSplit(card.dataset.person);
        };
      });
    }

    function renderGuestSplit(personId) {
      const p = currentProject;
      const me = p.people.find((pp) => pp.id === personId);
      if (!me) { renderGuestNamePicker(); return; }
      if (doneSet().has(personId) || p.guestLocked) { renderGuestSummary(personId); return; }
      currentView = { type: "split", personId };

      const items = p.items.filter((it) => it.name.trim());
      const people = p.people.filter((pp) => pp.name.trim());
      shell(`
        <div class="card guest-card">
          ${guestProgressHtml("check", "ติ๊กเมนูที่คุณกิน แล้วกดยืนยันเมื่อครบ")}
          <div class="toolbar-row">
            <div>
              <div class="section-title">เลือกเมนูของ ${escapeHtml(me.name)}</div>
              <div class="section-sub">ติ๊กได้เฉพาะคอลัมน์ของคุณ ระบบบันทึกให้ทันทีที่ติ๊ก <span class="save-indicator" id="guest-save-indicator"></span></div>
            </div>
            <button class="btn ghost" id="guest-switch-name">เปลี่ยนชื่อ</button>
          </div>
          <div class="matrix-wrap"><table class="matrix guest-matrix">
            <thead><tr><th class="item-name-th">เมนู</th><th>ราคา</th>${people.map((pp) => `<th class="${pp.id === personId ? "guest-my-col" : "guest-locked-col"}">${escapeHtml(pp.name)}</th>`).join("")}</tr></thead>
            <tbody>${items.map((it) => {
              const sharers = p.shares[it.id] || [];
              return `<tr data-item="${it.id}">
                <td class="item-name-cell">${escapeHtml(it.name)}</td>
                <td class="item-price">฿${baht(it.price)}</td>
                ${people.map((pp) => {
                  const isMe = pp.id === personId;
                  return `<td class="${isMe ? "guest-my-col" : "guest-locked-col"}">
                    <input type="checkbox" data-item="${it.id}" data-person="${pp.id}" ${sharers.includes(pp.id) ? "checked" : ""} ${isMe ? "" : "disabled"}>
                  </td>`;
                }).join("")}
              </tr>`;
            }).join("")}</tbody>
          </table></div>
          <div class="wizard-footer">
            <button class="btn ghost" id="guest-preview">ดูสรุปของฉัน</button>
            <button class="btn primary" id="guest-confirm">✅ ยืนยันการเลือก</button>
          </div>
        </div>
      `);
      wireCellClickToggle(root);

      root.querySelector("#guest-switch-name").onclick = () => {
        localStorage.removeItem(guestKey);
        renderGuestNamePicker();
      };
      root.querySelector("#guest-preview").onclick = () => renderGuestSummary(personId);
      root.querySelectorAll(`input[type=checkbox][data-person="${personId}"]`).forEach((cb) => {
        cb.onchange = async () => {
          cb.disabled = true;
          const itemId = cb.dataset.item;
          const checked = cb.checked;
          try {
            await updateGuestProjectFirebase(projectId, (project) => {
              project.shares[itemId] = project.shares[itemId] || [];
              if (checked) {
                if (!project.shares[itemId].includes(personId)) project.shares[itemId].push(personId);
              } else {
                project.shares[itemId] = project.shares[itemId].filter((pid) => pid !== personId);
                project.doneBy = (project.doneBy || []).filter((pid) => pid !== personId);
              }
            }, `guest ${me.name} update shares`, firebaseSettings);
            guestSyncError = null;
            // A toast on every single tick was noisy, especially combined
            // with the realtime re-renders while several guests are ticking
            // at once — show a quiet inline indicator instead and reserve
            // the toast for actual errors.
            const indicator = root.querySelector("#guest-save-indicator");
            if (indicator) {
              indicator.textContent = "✓ บันทึกอัตโนมัติ";
              indicator.classList.add("show");
              clearTimeout(indicator._t);
              indicator._t = setTimeout(() => indicator.classList.remove("show"), 1800);
            }
          } catch (e) {
            cb.checked = !checked;
            guestSyncError = e.message || "บันทึกไม่สำเร็จ";
            toast("บันทึกไม่สำเร็จ: " + guestSyncError, true);
            renderGuestSplit(personId);
            return;
          } finally {
            cb.disabled = false;
          }
        };
      });
      root.querySelector("#guest-confirm").onclick = (e) => withButtonPending(e.currentTarget, "กำลังยืนยัน...", async () => {
        try {
          await updateGuestProjectFirebase(projectId, (project) => {
            project.doneBy = project.doneBy || [];
            if (!project.doneBy.includes(personId)) project.doneBy.push(personId);
          }, `guest ${me.name} confirmed`, firebaseSettings);
          guestSyncError = null;
          const missing = currentProject.people.filter((pp) => pp.name.trim() && !doneSet().has(pp.id)).length;
          toast(missing ? `ยืนยันแล้ว รอเพื่อนอีก ${missing} คน` : "ทุกคนเลือกครบแล้ว");
          renderGuestSummary(personId);
        } catch (e) {
          guestSyncError = e.message || "ยืนยันไม่สำเร็จ";
          toast("ยืนยันไม่สำเร็จ: " + guestSyncError, true);
          renderGuestSplit(personId);
        }
      });
    }

    function renderGuestSummary(personId) {
      const p = currentProject;
      currentView = { type: "summary", personId };
      const s = computeSummary(p);
      const me = p.people.find((pp) => pp.id === personId);
      const mine = s.people.find((pp) => pp.id === personId);
      const done = doneSet();
      const totalPeople = p.people.filter((pp) => pp.name.trim()).length;
      const missing = Math.max(0, totalPeople - done.size);
      const locked = !!p.guestLocked && !done.has(personId);
      const myLines = s.items.filter((it) => it.sharers.includes(personId))
        .map((it) => `<div class="line"><span>${escapeHtml(it.name)}</span><span>฿${baht(it.perPerson)}</span></div>`).join("");

      const iConfirmed = done.has(personId);
      let stageKey, stageCaption;
      if (!iConfirmed) {
        stageKey = "confirm";
        stageCaption = "ตรวจยอดของคุณ แล้วกดยืนยันการเลือก";
      } else if (missing > 0) {
        stageKey = "waiting";
        stageCaption = `ยืนยันแล้ว · รอเพื่อนอีก ${missing} คน จะอัปเดตให้อัตโนมัติ`;
      } else {
        stageKey = "done";
        stageCaption = "ทุกคนยืนยันครบแล้ว จ่ายเงินได้เลย";
      }

      shell(`
        <div class="card guest-card">
          ${guestProgressHtml(stageKey, stageCaption)}
          <div class="toolbar-row">
            <div>
              <div class="section-title">${missing ? `สรุปของ ${escapeHtml(me ? me.name : "")}` : "สรุปผลครบแล้ว"}</div>
              <div class="section-sub">${missing ? `รอเพื่อนอีก ${missing} คน · จะอัปเดตให้อัตโนมัติ` : "ทุกคนยืนยันการเลือกครบแล้ว"}</div>
            </div>
            ${(!done.has(personId) && !p.guestLocked) ? `<button class="btn ghost" id="guest-edit">กลับไปแก้ไข</button>` : ""}
            ${(done.has(personId) && !p.guestLocked) ? `<button class="btn ghost" id="guest-unconfirm">✏️ แก้ไขการเลือก</button>` : ""}
          </div>
          ${locked ? `<div class="badge warn" style="display:inline-block;margin-bottom:14px;">🔒 เจ้าของโปรเจกต์ปิดรับการแก้ไขจากเพื่อนแล้ว</div>` : ""}
          <div class="dash-grid">
            <div class="card stat-card"><div class="stat-value">฿${baht(mine ? mine.total : 0)}</div><div class="stat-label">ยอดของฉัน</div></div>
            <div class="card stat-card"><div class="stat-value">฿${baht(s.grandTotal)}</div><div class="stat-label">ยอดรวมทั้งบิล</div></div>
            <div class="card stat-card"><div class="stat-value">${done.size}/${totalPeople}</div><div class="stat-label">ยืนยันแล้ว</div></div>
          </div>
          <div class="card personal-receipt" style="margin-bottom:20px;">
            <h3 class="section-title" style="font-size:0.95rem;">รายละเอียดของฉัน</h3>
            <div class="person-detail open">
              ${myLines || "<em>ยังไม่ได้เลือกเมนู</em>"}
              <div class="line"><span>ค่าบริการ+VAT ส่วนแบ่ง</span><span>฿${baht(mine ? mine.extra : 0)}</span></div>
            </div>
          </div>
          <div class="card" style="margin-bottom:20px;">
            <h3 class="section-title" style="font-size:0.95rem;">ยอดของแต่ละคน</h3>
            <div class="section-sub">${done.size}/${totalPeople} คนยืนยันการเลือกแล้ว</div>
            <div class="roster-list">
              ${s.people.filter((pf) => (p.people.find((pp) => pp.id === pf.id) || {}).name?.trim()).map((pf) => {
                const isMe = pf.id === personId;
                const confirmed = done.has(pf.id);
                return `<div class="roster-row${isMe ? " me" : ""}">
                  <span class="roster-name">${escapeHtml(pf.name)}${isMe ? ` <span class="roster-you">ฉัน</span>` : ""}</span>
                  <span class="roster-status ${confirmed ? "ok" : "wait"}">${confirmed ? "✓ ยืนยันแล้ว" : "⏳ กำลังเลือก"}</span>
                  <span class="roster-amt">฿${baht(pf.total)}</span>
                </div>`;
              }).join("")}
            </div>
          </div>
          ${p.promptPayId && mine && mine.total > 0 ? `
          <div class="card promptpay-card" style="margin-bottom:20px;">
            <h3 class="section-title" style="font-size:0.95rem;">สแกนจ่ายคืน ${escapeHtml(p.name || "")}</h3>
            <div class="section-sub">โอนยอดของคุณ ฿${baht(mine.total)} ผ่าน PromptPay ได้เลย</div>
            <div class="promptpay-qr" id="guest-ppqr"><div class="section-sub">กำลังสร้าง QR...</div></div>
            <div class="wizard-footer" style="justify-content:center;">
              <button class="btn ghost sm" id="guest-copy-amount">📋 คัดลอกยอด + ชื่อบิล</button>
            </div>
          </div>` : ""}
          <div id="guest-receipt-capture">
            <div class="receipt">
              <h3>${escapeHtml(p.place || "ใบเสร็จ")}</h3>
              <div class="sub">${escapeHtml(p.name)} · ${escapeHtml(p.date || "")}</div>
              <div class="divider"></div>
              ${s.items.map((it) => `<div class="rline"><span>${escapeHtml(it.name)} (${it.sharers.length} คน)</span><span>฿${baht(it.priceAfter)}</span></div>`).join("")}
              <div class="divider"></div>
              <div class="rline"><span>ส่วนลดรวม</span><span>-฿${baht(s.totalDiscount)}</span></div>
              <div class="rline"><span>ค่าบริการ (${p.serviceChargePercent || 0}%)</span><span>฿${baht(s.serviceCharge)}</span></div>
              <div class="rline"><span>VAT (${p.vatPercent || 0}%)</span><span>฿${baht(s.vat)}</span></div>
              <div class="divider"></div>
              <div class="rline total"><span>รวมสุทธิ</span><span>฿${baht(s.grandTotal)}</span></div>
              <div class="divider"></div>
              ${s.people.map((pf) => `<div class="rline"><span>${escapeHtml(pf.name)}</span><span>฿${baht(pf.total)}</span></div>`).join("")}
              <div class="barcode"></div>
            </div>
          </div>
          <div class="wizard-footer">
            <button class="btn ghost" id="guest-export-img">🖼️ Export รูปภาพ</button>
          </div>
        </div>
      `);
      const edit = root.querySelector("#guest-edit");
      if (edit) edit.onclick = () => renderGuestSplit(personId);
      const unconfirm = root.querySelector("#guest-unconfirm");
      if (unconfirm) unconfirm.onclick = async () => {
        unconfirm.disabled = true;
        try {
          await updateGuestProjectFirebase(projectId, (project) => {
            project.doneBy = (project.doneBy || []).filter((pid) => pid !== personId);
          }, `guest ${me.name} reopened selection`, firebaseSettings);
          guestSyncError = null;
          renderGuestSplit(personId);
        } catch (e) {
          guestSyncError = e.message || "แก้ไขไม่สำเร็จ";
          toast("แก้ไขไม่สำเร็จ: " + guestSyncError, true);
          unconfirm.disabled = false;
        }
      };
      root.querySelector("#guest-export-img").onclick = () => exportImage(p, root.querySelector("#guest-receipt-capture"));
      const ppqr = root.querySelector("#guest-ppqr");
      if (ppqr && mine) renderPromptPayQr(ppqr, p.promptPayId, mine.total);
      const copyAmountBtn = root.querySelector("#guest-copy-amount");
      if (copyAmountBtn) copyAmountBtn.onclick = async () => {
        try {
          await copyText(`${me ? me.name + " " : ""}ยอดที่ต้องจ่ายบิล "${p.name}" = ฿${baht(mine ? mine.total : 0)}`);
          toast("คัดลอกยอดแล้ว");
        } catch (e) {
          toast("คัดลอกไม่สำเร็จ: " + (e.message || ""), true);
        }
      };
    }
  }

  // ---------------------------------------------------------------
  // View: Wizard
  // ---------------------------------------------------------------
  // Set by wizardFooter() to the current step's onSave, so the step pills
  // below can persist in-flight edits before jumping to another step
  // instead of silently dropping them (a refresh after a pill jump used to
  // lose whatever wasn't already saved).
  let currentStepSave = null;

  // Runs fn() with the button disabled and swapped to a pending label, so a
  // slow network round-trip can't be double-clicked into duplicate saves and
  // the user isn't left guessing whether anything happened.
  async function withButtonPending(btn, pendingLabel, fn) {
    if (!btn || btn.disabled) return fn();
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = pendingLabel;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function renderWizard(step) {
    const root = document.getElementById("view-root");
    const stepIdx = Math.max(0, STEPS.findIndex((s) => s.key === step));
    root.innerHTML = `
      <div class="wizard-steps">${STEPS.map((s, i) => `
        <div class="wizard-step-pill ${i === stepIdx ? "active" : i < stepIdx ? "done" : ""}" data-step="${s.key}">${s.label}</div>
      `).join("")}</div>
      <div class="card" id="wizard-body"></div>
    `;
    const body = document.getElementById("wizard-body");
    const renderers = { info: stepInfo, menu: stepMenu, people: stepPeople, split: stepSplit, summary: stepSummary };
    currentStepSave = null;
    (renderers[STEPS[stepIdx].key] || stepInfo)(body, stepIdx);
    root.querySelectorAll(".wizard-step-pill").forEach((el) => {
      el.onclick = async () => {
        if (el.classList.contains("active")) return;
        if (currentStepSave) await withButtonPending(el, "กำลังบันทึก...", currentStepSave);
        navigate(`/project/${currentProject.id}/${el.dataset.step}`);
      };
      makeKeyboardActivatable(el);
    });
  }

  function wizardFooter(body, stepIdx, opts = {}) {
    currentStepSave = opts.onSave || null;
    const prevKey = stepIdx > 0 ? STEPS[stepIdx - 1].key : null;
    const nextKey = stepIdx < STEPS.length - 1 ? STEPS[stepIdx + 1].key : null;
    const footer = document.createElement("div");
    footer.className = "wizard-footer";
    footer.innerHTML = `
      <button class="btn ghost" id="wf-home">🏠 หน้าหลัก</button>
      <div style="display:flex; gap:10px;">
        ${prevKey ? `<button class="btn ghost" id="wf-prev">← ย้อนกลับ</button>` : ""}
        ${nextKey ? `<button class="btn primary" id="wf-next">บันทึก & ถัดไป →</button>` : ""}
      </div>`;
    body.appendChild(footer);
    footer.querySelector("#wf-home").onclick = () => navigate("/");
    if (prevKey) footer.querySelector("#wf-prev").onclick = (e) => withButtonPending(e.currentTarget, "กำลังบันทึก...", async () => {
      if (opts.onSave) await opts.onSave();
      navigate(`/project/${currentProject.id}/${prevKey}`);
    });
    if (nextKey) footer.querySelector("#wf-next").onclick = (e) => withButtonPending(e.currentTarget, "กำลังบันทึก...", async () => {
      if (opts.onSave) {
        const ok = await opts.onSave();
        if (ok === false) return;
      }
      navigate(`/project/${currentProject.id}/${nextKey}`);
    });
  }

  async function persistDraftAndMaybeGithub() {
    saveDraftLocal(currentProject);
    if (isFirebaseConnected()) {
      try {
        const summary = computeSummary(currentProject);
        await saveProjectToFirebase(currentProject, summary);
      } catch (e) {
        toast("บันทึกขึ้น Firebase ไม่สำเร็จ: " + e.message, true);
        return false;
      }
    } else if (isConnected()) {
      try {
        const summary = computeSummary(currentProject);
        await saveProjectToGithub(currentProject, summary);
      } catch (e) {
        toast("บันทึกขึ้น GitHub ไม่สำเร็จ: " + e.message, true);
        return false;
      }
    }
    return true;
  }

  // --- Step 1: info ---
  function stepInfo(body, stepIdx) {
    const p = currentProject;
    body.innerHTML = `
      <div class="section-title">ข้อมูลบิล</div>
      <div class="section-sub">เริ่มจากตั้งชื่อโปรเจกต์ วันที่ และส่วนลด/ค่าบริการ/VAT ของบิลนี้</div>
      <div class="field"><label>ชื่อโปรเจกต์ / บิล</label><input type="text" id="f-name" value="${escapeHtml(p.name)}" placeholder="เช่น มื้อเย็นวันศุกร์"></div>
      <div class="field-row">
        <div class="field"><label>วันที่</label><input type="date" id="f-date" value="${escapeHtml(p.date)}"></div>
        <div class="field"><label>ร้าน/สถานที่</label><input type="text" id="f-place" value="${escapeHtml(p.place)}" placeholder="ชื่อร้าน"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>ส่วนลดรวม (บาท)</label><input type="number" min="0" step="0.01" id="f-discount" value="${p.totalDiscount || ""}" placeholder="0"></div>
        <div class="field"><label>ค่าบริการ (%)</label><input type="number" min="0" step="0.01" id="f-service" value="${p.serviceChargePercent || ""}" placeholder="0"></div>
        <div class="field"><label>VAT (%)</label><input type="number" min="0" step="0.01" id="f-vat" value="${p.vatPercent || ""}" placeholder="0"></div>
      </div>
      <div class="field"><label>PromptPay รับเงิน (ไม่บังคับ)</label><input type="text" inputmode="numeric" id="f-promptpay" value="${escapeHtml(p.promptPayId)}" placeholder="เบอร์มือถือ หรือ เลขบัตรประชาชน"></div>
      <div class="help-box">💡 ส่วนลดรวมจะถูกหารเฉลี่ยให้แต่ละเมนูตามสัดส่วนราคา ส่วนค่าบริการและ VAT จะคิดจากยอดรวมหลังหักส่วนลด แล้วเฉลี่ยคืนให้แต่ละคนตามสัดส่วนที่กิน<br>💸 ถ้าใส่ PromptPay ของคุณ (คนที่จ่ายบิลไปก่อน) เพื่อน ๆ จะเห็น QR พร้อมยอดของตัวเองไว้สแกนโอนคืนได้เลย</div>
    `;
    function sync() {
      p.name = body.querySelector("#f-name").value;
      p.date = body.querySelector("#f-date").value;
      p.place = body.querySelector("#f-place").value;
      p.promptPayId = body.querySelector("#f-promptpay").value.trim();
      p.totalDiscount = Math.max(0, parseFloat(body.querySelector("#f-discount").value) || 0);
      p.serviceChargePercent = Math.max(0, parseFloat(body.querySelector("#f-service").value) || 0);
      p.vatPercent = Math.max(0, parseFloat(body.querySelector("#f-vat").value) || 0);
    }
    body.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", sync));
    body.querySelectorAll('input[type="number"]').forEach((inp) => inp.addEventListener("focus", () => inp.select()));
    wizardFooter(body, stepIdx, {
      onSave: async () => {
        sync();
        if (!p.name.trim()) { toast("กรุณาตั้งชื่อโปรเจกต์ก่อน", true); return false; }
        return persistDraftAndMaybeGithub();
      },
    });
  }

  // --- AI receipt photo reading (calls the scanReceipt Cloud Function,
  // which holds the Gemini API key server-side — see functions/index.js) ---
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(reader.error || new Error("อ่านไฟล์ไม่สำเร็จ"));
      reader.readAsDataURL(file);
    });
  }
  async function callGeminiReceiptVision(file) {
    // Guard oversized uploads before we spend time encoding + sending: base64
    // inflates ~33% and Gemini's inline-request cap is ~20MB, so reject well
    // below that with a clear message instead of an opaque HTTP 400 from the
    // Cloud Function.
    const MAX_BYTES = 12 * 1024 * 1024; // ~12MB source ≈ ~16MB base64
    if (file.size > MAX_BYTES) {
      throw new Error(`รูปใหญ่เกินไป (${(file.size / 1048576).toFixed(1)}MB) — กรุณาย่อรูปหรือถ่ายใหม่ให้เล็กกว่า ${Math.floor(MAX_BYTES / 1048576)}MB`);
    }
    const base64Data = await readFileAsBase64(file);
    const mimeType = file.type || "image/jpeg";
    const model = geminiModel || GEMINI_MODELS[0].id;
    const rt = await getFirebaseRuntime();
    const scanReceipt = rt.httpsCallable(rt.fns, "scanReceipt", { timeout: 60000 });
    try {
      const res = await scanReceipt({ imageBase64: base64Data, mimeType, model });
      return res.data;
    } catch (e) {
      // Firebase callable errors carry a human-readable .message (the same
      // Thai text scanReceipt threw via HttpsError, e.g. the 429 "switch
      // model" hint) — surface that as-is instead of a generic wrapper.
      throw new Error(e.message || "เรียก AI ไม่สำเร็จ");
    }
  }

  // --- Step 2: menu ---
  function stepMenu(body, stepIdx) {
    const p = currentProject;
    function rowsHtml() {
      return p.items.map((it) => `
        <div class="row-item" data-id="${it.id}">
          <input type="text" class="name-input" placeholder="ชื่อเมนู" value="${escapeHtml(it.name)}">
          <input type="number" min="0" step="0.01" class="price-input" placeholder="ราคา" value="${it.price || ""}">
          <button class="row-remove-btn" title="ลบ">✕</button>
        </div>`).join("");
    }
    function totalLine() {
      const sum = p.items.reduce((s, it) => s + (Number(it.price) || 0), 0);
      return `<div class="help-box">รวมราคาเมนู (ก่อนหักส่วนลด): <strong style="color:var(--accent)">฿${baht(sum)}</strong></div>`;
    }
    body.innerHTML = `
      <div class="section-title">รายการเมนู</div>
      <div class="section-sub">กรอกชื่อเมนูและราคาตามใบเสร็จ หรืออัปโหลดรูปบิลให้ AI อ่านและสร้างรายการให้อัตโนมัติ</div>
      <div class="row-list" id="menu-rows">${rowsHtml()}</div>
      <div style="display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap; align-items:center;">
        <button class="btn ghost sm" id="add-item-btn">+ เพิ่มเมนู</button>
        <button class="btn primary sm" id="scan-photo-btn">📷 อัปโหลดรูปบิล (AI อ่านให้อัตโนมัติ)</button>
        <input type="file" id="scan-photo-input" accept="image/*" style="display:none;">
        <label class="model-select-field">
          โมเดล AI
          <select id="f-gemini-model">${GEMINI_MODELS.map((m) => `<option value="${m.id}" ${m.id === geminiModel ? "selected" : ""}>${escapeHtml(m.label)}</option>`).join("")}</select>
        </label>
      </div>
      <div class="prompt-helper">
        <div>
          <strong>📷 อัปโหลดรูปบิลให้แอปอ่านเอง</strong>
          <p>กดปุ่ม “อัปโหลดรูปบิล” แล้วเลือกรูปใบเสร็จ แอปจะส่งรูปให้ Gemini API อ่านและเติมรายการเมนูให้อัตโนมัติ (ตรวจสอบราคาอีกครั้งก่อนไปขั้นต่อไป) ถ้าอัปโหลดรูปไม่สำเร็จหรือขึ้นแจ้งเตือนติดลิมิต ให้ลองเปลี่ยน “โมเดล AI” ด้านบนแล้วลองใหม่อีกครั้ง</p>
        </div>
      </div>
      <div id="menu-total">${totalLine()}</div>
    `;
    body.querySelector("#menu-rows").addEventListener("focusin", (e) => {
      if (e.target.matches('input[type="number"]')) e.target.select();
    });
    function wireRows() {
      body.querySelectorAll("#menu-rows .row-item").forEach((row) => {
        const id = row.dataset.id;
        const item = p.items.find((x) => x.id === id);
        row.querySelector(".name-input").oninput = (e) => { item.name = e.target.value; };
        row.querySelector(".price-input").oninput = (e) => {
          item.price = Math.max(0, parseFloat(e.target.value) || 0);
          body.querySelector("#menu-total").innerHTML = totalLine();
        };
        row.querySelector(".row-remove-btn").onclick = () => {
          p.items = p.items.filter((x) => x.id !== id);
          delete p.shares[id];
          body.querySelector("#menu-rows").innerHTML = rowsHtml();
          body.querySelector("#menu-total").innerHTML = totalLine();
          wireRows();
        };
      });
    }
    wireRows();
    body.querySelector("#add-item-btn").onclick = () => {
      p.items.push({ id: uuid(), name: "", price: 0 });
      body.querySelector("#menu-rows").innerHTML = rowsHtml();
      wireRows();
    };
    // Used by the AI photo scan below. Re-scanning the same bill twice (an
    // easy misstep) used to duplicate every item and silently double the
    // bill total — skip anything whose name+price already matches an
    // existing row.
    function mergeParsedMenu(parsed) {
      const list = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(list) || !list.length) throw new Error("ไม่พบรายการเมนู (items)");
      if (!Array.isArray(parsed)) {
        if (parsed.billName && !p.name.trim()) p.name = String(parsed.billName).trim();
        if (parsed.place && !p.place.trim()) p.place = String(parsed.place).trim();
        if (parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date))) p.date = String(parsed.date);
        if (isFinite(Number(parsed.totalDiscount))) p.totalDiscount = moneyNumber(parsed.totalDiscount);
        if (isFinite(Number(parsed.serviceChargePercent))) p.serviceChargePercent = moneyNumber(parsed.serviceChargePercent);
        if (isFinite(Number(parsed.vatPercent))) p.vatPercent = moneyNumber(parsed.vatPercent);
      }
      const existingSig = new Set(p.items.map((x) => `${x.name.trim().toLowerCase()}|${x.price}`));
      let added = 0, skipped = 0;
      list.forEach((it) => {
        const name = String(it.name || it.ชื่อเมนู || "").trim();
        // Prices may arrive as strings with separators/currency signs (e.g.
        // "1,200" or "฿1200") from an external AI import — strip those before
        // Number() so they don't silently become NaN → 0 and understate the bill.
        let rawPrice = it.price || it.ราคา || 0;
        if (typeof rawPrice === "string") rawPrice = rawPrice.replace(/[,\s฿$]/g, "");
        const price = Number(rawPrice);
        if (!name) return;
        const cleanPrice = isFinite(price) ? price : 0;
        const sig = `${name.toLowerCase()}|${cleanPrice}`;
        if (existingSig.has(sig)) { skipped++; return; }
        p.items.push({ id: uuid(), name, price: cleanPrice });
        existingSig.add(sig);
        added++;
      });
      body.querySelector("#menu-rows").innerHTML = rowsHtml();
      body.querySelector("#menu-total").innerHTML = totalLine();
      wireRows();
      return { added, skipped };
    }
    body.querySelector("#f-gemini-model").onchange = (e) => {
      saveGeminiModel(e.target.value);
    };
    body.querySelector("#scan-photo-btn").onclick = () => {
      body.querySelector("#scan-photo-input").click();
    };
    body.querySelector("#scan-photo-input").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const btn = body.querySelector("#scan-photo-btn");
      try {
        await withButtonPending(btn, "กำลังให้ AI อ่านรูป...", async () => {
          const parsed = await callGeminiReceiptVision(file);
          // The AI call can take many seconds; if the user switched step or
          // project meanwhile, `p`/`body` are stale (the step pills aren't
          // disabled during the request) — don't write into a detached view or
          // the wrong project.
          if (currentProject !== p || !body.querySelector("#menu-rows")) {
            toast("ยกเลิกการเติมเมนู เพราะออกจากหน้านี้ไปแล้ว ลองสแกนใหม่อีกครั้ง", true);
            return;
          }
          const { added, skipped } = mergeParsedMenu(parsed);
          toast(`AI อ่านบิลสำเร็จ ${added} รายการ${skipped ? ` (ข้ามรายการซ้ำ ${skipped} รายการ)` : ""} — ตรวจสอบราคาอีกครั้งก่อนไปขั้นต่อไป`);
        });
      } catch (err) {
        toast("อ่านรูปบิลไม่สำเร็จ: " + (err.message || ""), true);
      }
      e.target.value = "";
    };
    wizardFooter(body, stepIdx, {
      onSave: async () => {
        const valid = p.items.filter((it) => it.name.trim() && Number(it.price) > 0);
        if (!valid.length) { toast("กรุณาเพิ่มเมนูอย่างน้อย 1 รายการ พร้อมราคา", true); return false; }
        return persistDraftAndMaybeGithub();
      },
    });
  }

  // --- Step 3: people ---
  function stepPeople(body, stepIdx) {
    const p = currentProject;
    function rowsHtml() {
      return p.people.map((pp) => `
        <div class="row-item" data-id="${pp.id}">
          <input type="text" class="name-input" placeholder="ชื่อคน" value="${escapeHtml(pp.name)}">
          <button class="row-remove-btn" title="ลบ">✕</button>
        </div>`).join("");
    }
    body.innerHTML = `
      <div class="section-title">รายชื่อคน</div>
      <div class="section-sub">เพิ่มชื่อทุกคนที่ร่วมบิลนี้ — ชื่อที่กรอกจะถูกบันทึกไว้ใช้ซ้ำในโปรเจกต์ถัดไปด้วย</div>
      <div class="row-list" id="people-rows">${rowsHtml()}</div>
      <button class="btn ghost sm" id="add-person-btn">+ เพิ่มคน</button>
      <div id="saved-people-box" style="margin-top:18px;"></div>
    `;
    function wireRows() {
      body.querySelectorAll("#people-rows .row-item").forEach((row) => {
        const id = row.dataset.id;
        const person = p.people.find((x) => x.id === id);
        row.querySelector(".name-input").oninput = (e) => { person.name = e.target.value; };
        row.querySelector(".row-remove-btn").onclick = () => {
          p.people = p.people.filter((x) => x.id !== id);
          Object.keys(p.shares).forEach((k) => { p.shares[k] = (p.shares[k] || []).filter((pid) => pid !== id); });
          body.querySelector("#people-rows").innerHTML = rowsHtml();
          wireRows();
        };
      });
    }
    wireRows();
    body.querySelector("#add-person-btn").onclick = () => {
      p.people.push({ id: uuid(), name: "" });
      body.querySelector("#people-rows").innerHTML = rowsHtml();
      wireRows();
    };

    // --- Saved people pool: names the owner has used before, remembered on
    // their account (Firebase) or repo (GitHub) and offered as quick-add chips.
    const savedBox = body.querySelector("#saved-people-box");
    function renderSavedChips(names) {
      const current = new Set(p.people.map((pp) => pp.name.trim()).filter(Boolean));
      const available = names.filter((n) => !current.has(n));
      if (!available.length) {
        savedBox.innerHTML = names.length
          ? `<div class="help-box">เพิ่มทุกคนจากรายชื่อที่บันทึกไว้ครบแล้ว ✅</div>` : "";
        return;
      }
      savedBox.innerHTML = `
        <div class="section-sub" style="margin-bottom:8px;">รายชื่อที่เคยใช้ (แตะเพื่อเพิ่ม)</div>
        <div class="chip-list">${available.map((n) => `<button class="chip" data-name="${escapeHtml(n)}">+ ${escapeHtml(n)}</button>`).join("")}</div>
      `;
      savedBox.querySelectorAll(".chip").forEach((chip) => {
        chip.onclick = () => {
          p.people.push({ id: uuid(), name: chip.dataset.name });
          body.querySelector("#people-rows").innerHTML = rowsHtml();
          wireRows();
          renderSavedChips(names);
        };
      });
    }
    if (isFirebaseConnected() || isConnected()) {
      savedBox.innerHTML = `<div class="help-box">กำลังโหลดรายชื่อที่เคยใช้...</div>`;
      loadSavedPeoplePool().then(renderSavedChips).catch(() => { savedBox.innerHTML = ""; });
    }

    wizardFooter(body, stepIdx, {
      onSave: async () => {
        const valid = p.people.filter((pp) => pp.name.trim());
        if (!valid.length) { toast("กรุณาเพิ่มคนอย่างน้อย 1 คน", true); return false; }
        const ok = await persistDraftAndMaybeGithub();
        // Remember these names for next time (fire-and-forget — never block
        // the wizard on the pool write).
        if (ok) saveNamesToPool(valid.map((pp) => pp.name)).catch(() => {});
        return ok;
      },
    });
  }

  // --- Step 4: split matrix ---
  function stepSplit(body, stepIdx) {
    const p = currentProject;
    const items = p.items.filter((it) => it.name.trim());
    const people = p.people.filter((pp) => pp.name.trim());

    function countFor(itemId) { return (p.shares[itemId] || []).length; }
    function tableHtml() {
      return `<div class="matrix-wrap"><table class="matrix">
        <thead><tr><th class="item-name-th">เมนู</th><th>ราคา</th><th>ทุกคน</th>${people.map((pp) => `<th>${escapeHtml(pp.name)}</th>`).join("")}<th>หาร/คน</th></tr></thead>
        <tbody>${items.map((it) => {
          const sharers = p.shares[it.id] || [];
          const cnt = sharers.length;
          const allChecked = people.length > 0 && cnt === people.length;
          return `<tr data-item="${it.id}">
            <td class="item-name-cell">${escapeHtml(it.name)}</td>
            <td class="item-price">฿${baht(it.price)}</td>
            <td><input type="checkbox" class="row-all-cb" data-item="${it.id}" ${allChecked ? "checked" : ""} title="ทุกคนหารเมนูนี้"></td>
            ${people.map((pp) => `<td><input type="checkbox" data-item="${it.id}" data-person="${pp.id}" ${sharers.includes(pp.id) ? "checked" : ""}></td>`).join("")}
            <td><span class="share-count-tag ${cnt === 0 ? "zero" : ""}">${cnt} คน</span></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      <div style="margin-top:14px; display:flex; gap:10px;">
        <button class="btn ghost sm" id="select-all-btn">✓ ทุกคนหารทุกเมนูเท่ากัน</button>
      </div>`;
    }

    body.innerHTML = `
      <div class="toolbar-row">
        <div>
          <div class="section-title">ใครกินอะไร</div>
          <div class="section-sub">ติ๊กเครื่องหมายคนที่กินเมนูนั้น ๆ หรือติ๊กคอลัมน์ "ทุกคน" เพื่อหารเมนูนั้นเท่ากันทุกคนในแถวเดียว</div>
        </div>
        <button class="btn ghost" id="share-link-btn">📤 แชร์ลิงก์</button>
      </div>
      ${(!items.length || !people.length) ? `<div class="empty-state"><p>กรุณาเพิ่มเมนูและรายชื่อคนให้ครบก่อน</p></div>` : tableHtml()}
    `;
    body.querySelector("#share-link-btn").onclick = (e) => withButtonPending(e.currentTarget, "📤 กำลังเตรียมลิงก์...", () => shareProjectLink(p));
    function wire() {
      wireCellClickToggle(body);
      body.querySelectorAll('input[type=checkbox][data-item][data-person]').forEach((cb) => {
        cb.onchange = () => {
          const itemId = cb.dataset.item, personId = cb.dataset.person;
          p.shares[itemId] = p.shares[itemId] || [];
          if (cb.checked) {
            if (!p.shares[itemId].includes(personId)) p.shares[itemId].push(personId);
          } else {
            p.shares[itemId] = p.shares[itemId].filter((x) => x !== personId);
          }
          const row = cb.closest("tr");
          const cnt = p.shares[itemId].length;
          const tag = row.querySelector(".share-count-tag");
          tag.textContent = `${cnt} คน`;
          tag.classList.toggle("zero", cnt === 0);
          const allCb = row.querySelector(".row-all-cb");
          if (allCb) allCb.checked = people.length > 0 && cnt === people.length;
        };
      });
      body.querySelectorAll('.row-all-cb').forEach((cb) => {
        cb.onchange = () => {
          const itemId = cb.dataset.item;
          p.shares[itemId] = cb.checked ? people.map((pp) => pp.id) : [];
          const row = cb.closest("tr");
          row.querySelectorAll('input[type=checkbox][data-person]').forEach((pcb) => { pcb.checked = cb.checked; });
          const cnt = p.shares[itemId].length;
          const tag = row.querySelector(".share-count-tag");
          tag.textContent = `${cnt} คน`;
          tag.classList.toggle("zero", cnt === 0);
        };
      });
      const selAll = body.querySelector("#select-all-btn");
      if (selAll) selAll.onclick = () => {
        items.forEach((it) => { p.shares[it.id] = people.map((pp) => pp.id); });
        body.innerHTML = `
          <div class="toolbar-row">
            <div>
              <div class="section-title">ใครกินอะไร</div>
              <div class="section-sub">ติ๊กเครื่องหมายคนที่กินเมนูนั้น ๆ หรือติ๊กคอลัมน์ "ทุกคน" เพื่อหารเมนูนั้นเท่ากันทุกคนในแถวเดียว</div>
            </div>
            <button class="btn ghost" id="share-link-btn">📤 แชร์ลิงก์</button>
          </div>
          ${tableHtml()}`;
        body.querySelector("#share-link-btn").onclick = () => shareProjectLink(p);
        wire();
        wizardFooter(body, stepIdx, footerOpts);
      };
    }
    wire();
    const footerOpts = {
      onSave: async () => {
        const summary = computeSummary(p);
        if (summary.unassignedItems.length) {
          toast(`⚠️ มี ${summary.unassignedItems.length} เมนูที่ยังไม่มีคนหาร`, true);
        }
        return persistDraftAndMaybeGithub();
      },
    };
    wizardFooter(body, stepIdx, footerOpts);
  }

  // --- Step 5: summary dashboard ---
  function stepSummary(body, stepIdx) {
    const p = currentProject;
    lastSummarySyncKey = summarySyncKey(p);
    const s = computeSummary(p);
    const totalPeople = p.people.filter((pp) => pp.name.trim()).length;
    const doneSetIds = new Set((p.doneBy || []).filter((id) => p.people.some((pp) => pp.id === id)));
    const doneCount = doneSetIds.size;
    // Who the owner still needs to chase (only meaningful once sharing is on).
    const pendingPeople = p.guestAccess
      ? p.people.filter((pp) => pp.name.trim() && !doneSetIds.has(pp.id))
      : [];

    body.innerHTML = `
      <div class="section-title">สรุปผล — ${escapeHtml(p.name)}</div>
      <div class="section-sub">${escapeHtml(p.place || "")} · ${escapeHtml(p.date || "")}</div>

      <div class="summary-actions">
        ${p.guestAccess ? `<button class="btn primary" id="owner-guest-view-btn" title="เปิดดูมุมมองที่เกสเห็น — ติ๊กเมนูแทนเพื่อนได้ด้วย">👁️ เข้าโหมดเกส</button>` : ""}
        <button class="btn ${p.guestAccess ? "ghost" : "primary"}" id="share-summary-btn">📤 แชร์ลิงก์</button>
        <button class="btn ghost" id="save-now-btn">💾 บันทึก</button>
        <div class="export-wrap">
          <button class="btn ghost" id="export-btn" aria-haspopup="true" aria-expanded="false">⬇️ Export ▾</button>
          <div class="export-menu" id="export-menu" hidden>
            <button class="btn ghost sm" id="export-pdf-opt">⬇️ PDF (ใบเสร็จ 80mm)</button>
            <button class="btn ghost sm" id="export-img-opt">🖼️ รูปภาพ (PNG)</button>
          </div>
        </div>
        ${p.guestAccess ? `<button class="btn ghost" id="guest-lock-btn">${p.guestLocked ? "🔓 เปิดรับการแก้ไขอีกครั้ง" : "🔒 ปิดรับการแก้ไขจากเกส"}</button>` : ""}
      </div>
      <div class="section-sub summary-share-hint">📤 <strong>แชร์ลิงก์</strong> = ส่งให้เพื่อนแต่ละคนกดเลือกเมนูที่ตัวเองกิน ระบบสรุปยอดให้อัตโนมัติ (เพื่อนไม่ต้องสมัคร/เข้าสู่ระบบ)${p.guestAccess ? `<br>👁️ <strong>เข้าโหมดเกส</strong> = เข้าไปติ๊กยืนยันเมนูที่ตัวคุณเองกิน (หรือติ๊กแทนเพื่อนก็ได้)` : ""}</div>

      ${s.unassignedItems.length ? `<div class="badge warn" style="display:inline-block;margin-bottom:14px;">⚠️ มี ${s.unassignedItems.length} เมนูที่ยังไม่ระบุคนหาร — ยอดรวมอาจไม่ครบ</div>` : ""}
      ${p.guestAccess ? `<div class="badge ${doneCount >= totalPeople && totalPeople > 0 ? "ok" : "warn"}" style="display:inline-block;margin-bottom:14px;margin-left:8px;" id="guest-progress-badge">👥 เกสยืนยันแล้ว ${doneCount}/${totalPeople} คน${p.guestLocked ? " · ปิดรับการแก้ไขแล้ว" : " · อัปเดตสด"}</div>` : ""}

      ${pendingPeople.length ? `
      <div class="card pending-card" style="margin-bottom:20px;">
        <div class="toolbar-row" style="margin-bottom:8px;">
          <div class="section-title" style="font-size:0.95rem;">รอเพื่อนอีก ${pendingPeople.length} คน</div>
          <button class="btn ghost sm" id="copy-nudge-btn">📋 คัดลอกข้อความตาม</button>
        </div>
        <div class="chip-list">${pendingPeople.map((pp) => `<span class="chip" style="cursor:default;">${escapeHtml(pp.name)}</span>`).join("")}</div>
      </div>` : ""}

      <div class="dash-grid">
        <div class="card stat-card"><div class="stat-value">฿${baht(s.grandTotal)}</div><div class="stat-label">ยอดรวมสุทธิ</div></div>
        <div class="card stat-card"><div class="stat-value">${s.people.length}</div><div class="stat-label">จำนวนคน</div></div>
        <div class="card stat-card"><div class="stat-value">฿${baht(s.totalDiscount)}</div><div class="stat-label">ส่วนลดรวม</div></div>
        <div class="card stat-card"><div class="stat-value">฿${baht(s.grandTotal / Math.max(1, s.people.length))}</div><div class="stat-label">เฉลี่ยต่อคน</div></div>
      </div>

      <div class="charts-grid">
        <div class="card"><h3 class="section-title" style="font-size:0.95rem;">ยอดที่แต่ละคนต้องจ่าย</h3><div class="chart-box"><canvas id="chart-bar"></canvas></div></div>
        <div class="card"><h3 class="section-title" style="font-size:0.95rem;">สัดส่วนการจ่ายเงิน</h3><div class="chart-box"><canvas id="chart-pie"></canvas></div></div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h3 class="section-title" style="font-size:0.95rem;">รายละเอียดต่อคน</h3>
        <div class="person-breakdown" id="person-breakdown">
          ${s.people.map((pf) => personRowHtml(pf, s, p)).join("")}
        </div>
      </div>

      <div id="receipt-capture">
        <div class="receipt">
          <h3>${escapeHtml(p.place || "ใบเสร็จ")}</h3>
          <div class="sub">${escapeHtml(p.name)} · ${escapeHtml(p.date || "")}</div>
          <div class="divider"></div>
          ${s.items.map((it) => `<div class="rline"><span>${escapeHtml(it.name)} (${it.sharers.length} คน)</span><span>฿${baht(it.priceAfter)}</span></div>`).join("")}
          <div class="divider"></div>
          <div class="rline"><span>ส่วนลดรวม</span><span>-฿${baht(s.totalDiscount)}</span></div>
          <div class="rline"><span>ค่าบริการ (${p.serviceChargePercent || 0}%)</span><span>฿${baht(s.serviceCharge)}</span></div>
          <div class="rline"><span>VAT (${p.vatPercent || 0}%)</span><span>฿${baht(s.vat)}</span></div>
          <div class="divider"></div>
          <div class="rline total"><span>รวมสุทธิ</span><span>฿${baht(s.grandTotal)}</span></div>
          <div class="divider"></div>
          ${s.people.map((pf) => `<div class="rline"><span>${escapeHtml(pf.name)}</span><span>฿${baht(pf.total)}</span></div>`).join("")}
          <div class="barcode"></div>
        </div>
      </div>
    `;

    body.querySelectorAll(".person-row").forEach((row) => {
      row.onclick = () => {
        const nowOpen = row.nextElementSibling.classList.toggle("open");
        const pid = row.dataset.person;
        if (pid) { if (nowOpen) openPersonDetailIds.add(pid); else openPersonDetailIds.delete(pid); }
      };
      makeKeyboardActivatable(row);
    });

    body.querySelector("#save-now-btn").onclick = (e) => withButtonPending(e.currentTarget, "💾 กำลังบันทึก...", async () => {
      const ok = await persistDraftAndMaybeGithub();
      toast(ok ? "บันทึกแล้ว" : "บันทึกไม่สำเร็จ", !ok);
    });
    // Use currentProject (not the captured p) — live-sync may have swapped it
    // for a fresh object since render. Re-render after the first share so the
    // action bar updates (share drops to secondary, 👁️ เข้าโหมดเกส appears).
    body.querySelector("#share-summary-btn").onclick = (e) => withButtonPending(e.currentTarget, "📤 กำลังเตรียมลิงก์...", async () => {
      const wasShared = !!(currentProject && currentProject.guestAccess);
      await shareProjectLink(currentProject);
      if (!wasShared && currentProject && currentProject.guestAccess) renderWizard("summary");
    });
    const lockBtn = body.querySelector("#guest-lock-btn");
    if (lockBtn) lockBtn.onclick = async () => {
      currentProject.guestLocked = !currentProject.guestLocked;
      const ok = await persistDraftAndMaybeGithub();
      toast(ok ? (currentProject.guestLocked ? "ปิดรับการแก้ไขจากเกสแล้ว" : "เปิดให้เกสแก้ไขได้อีกครั้ง") : "บันทึกไม่สำเร็จ", !ok);
      renderWizard("summary");
    };
    // Owner-only: open this project's guest view (same as a share link would).
    // Persist first so the guest side loads the latest shares/doneBy from
    // Firebase. The owner stays logged in — ensureGuestSession keeps the
    // existing session rather than swapping in an anonymous one — so backing
    // out returns to this owner summary.
    const guestViewBtn = body.querySelector("#owner-guest-view-btn");
    if (guestViewBtn) guestViewBtn.onclick = (e) => withButtonPending(e.currentTarget, "กำลังเปิดโหมดเกส...", async () => {
      await persistDraftAndMaybeGithub();
      navigate("/guest/" + p.id);
    });
    // Combined Export button: click opens a small menu to pick the format.
    // The outside-click closer is attached only while the menu is open and
    // removed when it closes, so re-rendering the summary can't pile up stale
    // document listeners.
    const exportBtn = body.querySelector("#export-btn");
    const exportMenu = body.querySelector("#export-menu");
    function closeExportMenu() {
      exportMenu.hidden = true;
      exportBtn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onExportOutside);
    }
    function onExportOutside(ev) {
      if (!exportMenu.contains(ev.target) && ev.target !== exportBtn) closeExportMenu();
    }
    exportBtn.onclick = (e) => {
      e.stopPropagation();
      if (exportMenu.hidden) {
        exportMenu.hidden = false;
        exportBtn.setAttribute("aria-expanded", "true");
        setTimeout(() => document.addEventListener("click", onExportOutside), 0);
      } else {
        closeExportMenu();
      }
    };
    body.querySelector("#export-pdf-opt").onclick = () => { closeExportMenu(); exportPdf(p, body.querySelector("#receipt-capture")); };
    body.querySelector("#export-img-opt").onclick = () => { closeExportMenu(); exportImage(p, body.querySelector("#receipt-capture")); };

    const nudgeBtn = body.querySelector("#copy-nudge-btn");
    if (nudgeBtn) nudgeBtn.onclick = async () => {
      // A ready-to-paste reminder the owner can drop into the group chat,
      // including the share link so friends can jump straight in.
      let link = "";
      try { link = buildShareLink(p); } catch { /* not shareable yet */ }
      const names = pendingPeople.map((pp) => pp.name).join(", ");
      const msg = `เหลือ ${names} ยังไม่เลือกเมนูบิล "${p.name}" นะ 🙏${link ? "\n👉 " + link : ""}`;
      try {
        await copyText(msg);
        toast("คัดลอกข้อความตามเพื่อนแล้ว");
      } catch (e) {
        toast("คัดลอกไม่สำเร็จ: " + (e.message || ""), true);
      }
    };

    renderCharts(s);
    wizardFooter(body, stepIdx, { onSave: () => persistDraftAndMaybeGithub() });
    subscribeSummaryLiveSync(p.id);
  }

  // Keep the owner's summary dashboard fresh while guests are actively
  // filling in their picks, without requiring a manual page reload.
  //
  // stepSummary() calls this on every render, and Firestore's onSnapshot
  // fires once immediately on attach with the *current* doc (not just future
  // changes) — so without the two guards below, the first fire re-renders,
  // the re-render re-subscribes, the new subscription fires again on attach,
  // and so on forever: an infinite loop that visibly flickered the whole
  // dashboard (charts destroyed/recreated on every cycle). Fixed by:
  //  1. Not attaching a second listener for a project we're already
  //     watching — re-invoking this from every stepSummary() render becomes
  //     a no-op instead of tearing down and recreating the subscription.
  //  2. Comparing a fingerprint of the displayed fields before re-rendering
  //     — the fire-on-attach snapshot always matches what's already on
  //     screen, so it updates state silently without touching the DOM.
  async function subscribeSummaryLiveSync(projectId) {
    if (!isFirebaseConnected() || !projectId) return;
    if (summarySyncProjectId === projectId && activeSnapshotUnsub) return;
    try {
      const rt = await getFirebaseRuntime();
      stopLiveSync();
      summarySyncProjectId = projectId;
      activeSnapshotUnsub = rt.onSnapshot(firebaseProjectRef(rt, projectId), (snap) => {
        if (!snap.exists()) return;
        const updated = normalizeProject(snap.data().project || {});
        if (!currentProject || currentProject.id !== projectId) return;
        currentProject = updated;
        // The summary view doesn't let the owner edit shares/doneBy, so any
        // live update here is by definition something guests did — treat it
        // as the new known-good baseline, not a conflict for the next save.
        projectSyncBaseline = snapshotSyncBaseline(currentProject);
        if (summarySyncKey(updated) === lastSummarySyncKey) return; // nothing visible changed
        if (parseHash()[0] === "project" && parseHash()[2] === "summary") {
          rerenderPreservingScroll(() => {
            // Re-render just the wizard body content instead of the whole
            // page (renderWizard rebuilds #view-root, including the step
            // pills) — this is the view that updates most often while
            // guests are actively picking, so keep the rebuild as narrow
            // as the current markup structure allows.
            const wizardBody = document.getElementById("wizard-body");
            if (wizardBody && document.getElementById("view-root").contains(wizardBody)) {
              stepSummary(wizardBody, STEPS.findIndex((s) => s.key === "summary"));
            } else {
              renderWizard("summary");
            }
          });
        }
      });
    } catch (e) {
      console.error(e);
    }
  }

  function personRowHtml(pf, s, p) {
    const lines = s.items.filter((it) => it.sharers.includes(pf.id))
      .map((it) => `<div class="line"><span>${escapeHtml(it.name)}</span><span>฿${baht(it.perPerson)}</span></div>`).join("");
    const isOpen = openPersonDetailIds.has(pf.id);
    return `<div>
      <div class="person-row" data-person="${escapeHtml(pf.id)}"><span class="name">${escapeHtml(pf.name)}</span><span class="amt">฿${baht(pf.total)}</span></div>
      <div class="person-detail${isOpen ? " open" : ""}">
        ${lines || "<em>ไม่มีรายการ</em>"}
        <div class="line"><span>ค่าบริการ+VAT ส่วนแบ่ง</span><span>฿${baht(pf.extra)}</span></div>
      </div>
    </div>`;
  }

  function renderCharts(s) {
    if (!window.Chart) {
      document.querySelectorAll(".chart-box").forEach((box) => {
        box.innerHTML = `<div class="empty-state" style="padding:30px 10px;">โหลดกราฟไม่ได้ แต่สรุปยอดยังใช้งานได้</div>`;
      });
      return;
    }
    Object.values(chartRefs).forEach((c) => c && c.destroy());
    const isLight = document.body.classList.contains("light-theme");
    const gridColor = isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.06)";
    const textColor = isLight ? "#475569" : "#9aa3b2";
    const palette = ["#e8b84b", "#2dd4bf", "#60a5fa", "#f87171", "#a78bfa", "#34d399", "#fbbf24", "#f472b6"];

    const barCtx = document.getElementById("chart-bar");
    if (barCtx) {
      chartRefs.bar = new Chart(barCtx, {
        type: "bar",
        data: {
          labels: s.people.map((p) => p.name),
          datasets: [{ data: s.people.map((p) => Number(p.total.toFixed(2))), backgroundColor: palette[0], borderRadius: 6 }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: textColor }, grid: { display: false } },
            y: { ticks: { color: textColor }, grid: { color: gridColor } },
          },
        },
      });
    }
    const pieCtx = document.getElementById("chart-pie");
    if (pieCtx) {
      chartRefs.pie = new Chart(pieCtx, {
        type: "doughnut",
        data: {
          labels: s.people.map((p) => p.name),
          datasets: [{ data: s.people.map((p) => Number(p.total.toFixed(2))), backgroundColor: s.people.map((_, i) => palette[i % palette.length]) }],
        },
        options: { plugins: { legend: { position: "bottom", labels: { color: textColor, boxWidth: 12 } } } },
      });
    }
  }

  // ---------------------------------------------------------------
  // PDF / image export
  // ---------------------------------------------------------------
  // In the Capacitor Android shell, MainActivity injects window.AndroidDownload
  // because the WebView silently drops anchor/blob/data downloads (the export
  // button would do nothing). Hand the file — with its real filename — to
  // native code to write into Downloads. In a normal browser AndroidDownload
  // is undefined and callers do the standard anchor download instead.
  function nativeSave(dataUrl, filename, mime) {
    try {
      if (window.AndroidDownload && typeof window.AndroidDownload.saveBase64 === "function") {
        window.AndroidDownload.saveBase64(dataUrl, filename, mime);
        return true;
      }
    } catch (e) { /* fall through to the browser download path */ }
    return false;
  }

  async function exportPdf(project, captureEl) {
    toast("กำลังสร้าง PDF...");
    try {
      // Loaded on demand — see loadScriptOnce. Falls back to a clear error if
      // the CDN can't be reached instead of a blank failure.
      await Promise.all([ensureHtml2canvas(), ensureJsPdf()]);
      const canvas = await html2canvas(captureEl, { scale: 2, backgroundColor: "#fdfaf2" });
      const { jsPDF } = window.jspdf;
      const imgData = canvas.toDataURL("image/png");

      // ขนาดบิลแบบใบเสร็จร้านสะดวกซื้อจริง: กว้างคงที่ ~80mm ยาวเท่าที่
      // เนื้อหาต้องการ รวมอยู่ในไฟล์เดียว หน้าเดียว ไม่ตัดแบ่งหน้า
      const MM_TO_PT = 2.83465;
      const pageWidthPt = 80 * MM_TO_PT; // ~226.77pt
      const marginPt = 10;
      const contentWidthPt = pageWidthPt - marginPt * 2;
      const imgHeightPt = (canvas.height * contentWidthPt) / canvas.width;
      const pageHeightPt = imgHeightPt + marginPt * 2;

      const pdf = new jsPDF({ unit: "pt", format: [pageWidthPt, pageHeightPt] });
      pdf.addImage(imgData, "PNG", marginPt, marginPt, contentWidthPt, imgHeightPt);

      const filename = `bill_${(project.name || "project").replace(/[^a-zA-Z0-9ก-๙_-]+/g, "_")}.pdf`;
      if (!nativeSave(pdf.output("datauristring"), filename, "application/pdf")) {
        pdf.save(filename);
      }
      toast("ดาวน์โหลด PDF เรียบร้อย (ขนาดใบเสร็จ 80mm หน้าเดียว)");
    } catch (e) {
      console.error(e);
      toast("Export PDF ไม่สำเร็จ: " + e.message, true);
    }
  }

  async function exportImage(project, captureEl) {
    toast("กำลังสร้างรูปภาพ...");
    try {
      await ensureHtml2canvas(); // loaded on demand — see loadScriptOnce
      const canvas = await html2canvas(captureEl, { scale: 2, backgroundColor: "#fdfaf2" });
      const filename = `bill_${(project.name || "project").replace(/[^a-zA-Z0-9ก-๙_-]+/g, "_")}.png`;
      const dataUrl = canvas.toDataURL("image/png");
      if (!nativeSave(dataUrl, filename, "image/png")) {
        const link = document.createElement("a");
        link.download = filename;
        link.href = dataUrl;
        link.click();
      }
      toast("ดาวน์โหลดรูปภาพเรียบร้อย");
    } catch (e) {
      console.error(e);
      toast("Export รูปภาพไม่สำเร็จ: " + e.message, true);
    }
  }

  // ---------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------
  function confirmModal(title, bodyText, onOk) {
    const modal = document.getElementById("confirm-modal");
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-body").textContent = bodyText;
    modal.classList.add("open");
    const previouslyFocused = document.activeElement;
    const cancelBtn = document.getElementById("confirm-cancel");
    const okBtn = document.getElementById("confirm-ok");
    const focusables = [cancelBtn, okBtn];
    const cleanup = () => {
      modal.classList.remove("open");
      document.removeEventListener("keydown", onKeydown);
      modal.removeEventListener("mousedown", onOverlayClick);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
    function onKeydown(e) {
      if (e.key === "Escape") { cleanup(); return; }
      if (e.key === "Tab") {
        e.preventDefault();
        const idx = focusables.indexOf(document.activeElement);
        const next = e.shiftKey
          ? (idx <= 0 ? focusables.length - 1 : idx - 1)
          : (idx === focusables.length - 1 ? 0 : idx + 1);
        focusables[next].focus();
      }
    }
    function onOverlayClick(e) {
      if (e.target === modal) cleanup();
    }
    document.addEventListener("keydown", onKeydown);
    modal.addEventListener("mousedown", onOverlayClick);
    cancelBtn.onclick = cleanup;
    okBtn.onclick = async () => { cleanup(); await onOk(); };
    cancelBtn.focus();
  }

  // ---------------------------------------------------------------
  // Init / wiring
  // ---------------------------------------------------------------
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light") document.body.classList.add("light-theme");
    document.getElementById("theme-toggle").onclick = () => {
      document.body.classList.toggle("light-theme");
      localStorage.setItem(THEME_KEY, document.body.classList.contains("light-theme") ? "light" : "dark");
      if (chartRefs.bar || chartRefs.pie) {
        const s = currentProject ? computeSummary(currentProject) : null;
        if (s) renderCharts(s);
      }
    };
  }

  function initHeaderButtons() {
    const adminBtn = document.getElementById("admin-btn");
    const logoutBtn = document.getElementById("logout-btn");
    if (adminBtn) adminBtn.onclick = () => navigate("/admin");
    if (logoutBtn) logoutBtn.onclick = () => signOutCurrentUser();
  }

  window.addEventListener("hashchange", router);
  window.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    initHeaderButtons();
    purgeOldDrafts();
    try {
      await refreshAuthState();
    } catch (e) {
      console.error(e);
      toast(e.message || "โหลด Firebase config ไม่สำเร็จ", true);
      updateGhStatus("error");
    }
    router();
  });
})();
