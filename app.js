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
  const THEME_KEY = "billsplit_theme";
  const DRAFT_KEY_PREFIX = "billsplit_draft_";
  const STEPS = [
    { key: "info", label: "1. ข้อมูลบิล" },
    { key: "menu", label: "2. เมนู" },
    { key: "people", label: "3. รายชื่อคน" },
    { key: "split", label: "4. หารบิล" },
    { key: "summary", label: "5. สรุปผล" },
  ];

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  let settings = loadSettings();          // {token, owner, repo, branch}
  let firebaseSettings = loadFirebaseSettings(); // public Firebase web config
  let firebaseRuntime = null;             // lazy-loaded Firebase modules/app
  let indexCache = null;                  // {entries:[...], sha}
  let currentProject = null;              // working project object
  let chartRefs = {};                     // chart.js instances to destroy on re-render

  // ---------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------
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
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 3200);
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
    p.name = String(p.name || "");
    p.date = String(p.date || todayISO());
    p.place = String(p.place || "");
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
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
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
  function isConnected() {
    return !!(settings && settings.token && settings.owner && settings.repo);
  }
  function isFirebaseConnected() {
    return !!(firebaseSettings && firebaseSettings.apiKey && firebaseSettings.authDomain && firebaseSettings.projectId && firebaseSettings.appId);
  }
  function updateGhStatus(state) {
    const el = document.getElementById("gh-status");
    const text = el.querySelector(".gh-status-text");
    el.classList.remove("connected", "error");
    if (isFirebaseConnected()) {
      el.classList.add("connected");
      text.textContent = `Firebase: ${firebaseSettings.projectId}`;
      return;
    }
    if (!isConnected()) { text.textContent = "ยังไม่เชื่อมต่อ"; return; }
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
    const [{ initializeApp, getApps }, firestore, authMod] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
    ]);
    const appName = `bill-splitter-${config.projectId}`;
    const app = getApps().find((a) => a.name === appName) || initializeApp(config, appName);
    const auth = authMod.getAuth(app);
    if (!auth.currentUser) await authMod.signInAnonymously(auth);
    const db = firestore.getFirestore(app);
    firebaseRuntime = { ...firestore, ...authMod, app, auth, db, projectId: config.projectId };
    return firebaseRuntime;
  }

  function firebaseProjectRef(rt, id) {
    return rt.doc(rt.db, "billProjects", id);
  }

  async function saveProjectToFirebase(project, summary) {
    if (!isFirebaseConnected()) throw new Error("ยังไม่ได้ตั้งค่า Firebase");
    const rt = await getFirebaseRuntime();
    const cleanProject = normalizeProject(JSON.parse(JSON.stringify(project)));
    cleanProject.ownerUid = cleanProject.ownerUid || rt.auth.currentUser.uid;
    cleanProject.updatedAt = new Date().toISOString();
    const entry = {
      id: cleanProject.id,
      name: cleanProject.name,
      date: cleanProject.date,
      place: cleanProject.place || "",
      grandTotal: summary ? summary.grandTotal : 0,
      peopleCount: cleanProject.people.length,
      updatedAt: cleanProject.updatedAt,
    };
    await rt.setDoc(firebaseProjectRef(rt, cleanProject.id), { project: cleanProject, entry }, { merge: true });
    currentProject = cleanProject;
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
    const q = rt.query(rt.collection(rt.db, "billProjects"), rt.orderBy("entry.updatedAt", "desc"));
    const snap = await rt.getDocs(q);
    return { entries: snap.docs.map((docSnap) => docSnap.data().entry).filter(Boolean) };
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
      b64UrlEncode(JSON.stringify(firebaseSettings)),
    ];
    return `${base}#/${parts.join("/")}`;
  }

  async function shareProjectLink(project = currentProject) {
    try {
      const link = buildShareLink(project);
      await copyText(link);
      toast("คัดลอกลิงก์แชร์แล้ว");
    } catch (e) {
      toast(e.message || "สร้างลิงก์แชร์ไม่สำเร็จ", true);
    }
  }

  function applyGuestSettings(parts) {
    const decoded = b64UrlDecode(parts[2]);
    if (parts.length === 3 && decoded.trim().startsWith("{")) {
      firebaseSettings = JSON.parse(decoded);
      settings = null;
    } else {
      throw new Error("ลิงก์ guest แบบเก่าที่ฝัง GitHub token ถูกปิดเพื่อความปลอดภัย กรุณาสร้างลิงก์ใหม่ด้วย Firebase");
    }
    indexCache = null;
    updateGhStatus();
  }

  // ---------------------------------------------------------------
  // Project model
  // ---------------------------------------------------------------
  function blankProject() {
    return {
      id: uuid(), name: "", date: todayISO(), place: "",
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

  // ---------------------------------------------------------------
  // Calculation engine — mirrors the Form_bill logic:
  // each item's share of a single total discount is proportional to
  // its price; remaining cost of each item is split evenly among the
  // people marked as having shared it; service charge / VAT (if any)
  // are then distributed proportionally to each person's subtotal.
  // ---------------------------------------------------------------
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

    const unassignedItems = itemResults.filter((it) => it.sharers.length === 0 && it.price > 0);

    return {
      items: itemResults, people: personFinal, sumPrices, totalDiscount,
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
    try {
      if (parts[0] === "guest" && parts[1] && parts[2]) {
        applyGuestSettings(parts);
        await renderGuestMode(parts[1]);
        return;
      }
      if (parts[0] === "project" && parts[1] === "new") {
        currentProject = blankProject();
        saveDraftLocal(currentProject);
        navigate(`/project/${currentProject.id}/info`);
        return;
      }
      if (parts[0] === "project" && parts[1]) {
        const id = parts[1];
        const step = parts[2] || "info";
        if (!currentProject || currentProject.id !== id) {
          currentProject = loadDraftLocal(id);
          if (!currentProject && isFirebaseConnected()) {
            currentProject = await loadProjectFromFirebase(id);
            saveDraftLocal(currentProject);
          } else if (!currentProject && isConnected()) {
            currentProject = await loadProjectFromGithub(id);
            saveDraftLocal(currentProject);
          }
          if (!currentProject) { toast("ไม่พบโปรเจกต์นี้", true); navigate("/"); return; }
        }
        renderWizard(step);
        return;
      }
      await renderHome();
    } catch (e) {
      console.error(e);
      toast(e.message || "เกิดข้อผิดพลาด", true);
      renderHome();
    }
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
            <h3>ยังไม่เชื่อมต่อที่เก็บข้อมูล</h3>
            <p>เชื่อมต่อ Firebase ฟรีสำหรับแชร์หลายคน หรือ GitHub สำหรับเก็บไฟล์ส่วนตัว</p>
          </div>
          <button class="btn primary" id="home-connect-btn">⚙️ ตั้งค่าที่เก็บข้อมูล</button>
        </div>
        <div class="empty-state">
          <div class="emoji">🧾</div>
          <p>เริ่มสร้างโปรเจกต์หารบิลแรกของคุณได้เลย แม้ยังไม่เชื่อมต่อ GitHub<br>(ข้อมูลจะถูกเก็บไว้ในเบราว์เซอร์นี้ก่อน จนกว่าจะเชื่อมต่อและบันทึก)</p>
          <br><button class="btn secondary" id="home-new-btn-empty">+ สร้างโปรเจกต์ใหม่</button>
        </div>`;
      root.querySelector("#home-connect-btn").onclick = openSettingsModal;
      root.querySelector("#home-new-btn-empty").onclick = () => navigate("/project/new");
      return;
    }

    const storageName = isFirebaseConnected()
      ? `Firebase: ${escapeHtml(firebaseSettings.projectId)}`
      : `${escapeHtml(settings.owner)}/${escapeHtml(settings.repo)}`;
    root.innerHTML = `<div class="toolbar-row"><div><div class="section-title">โปรเจกต์หารบิล</div>
      <div class="section-sub">เก็บไว้ที่ ${storageName}</div></div>
      <button class="btn primary" id="home-new-btn">+ สร้างโปรเจกต์ใหม่</button></div>
      <div id="home-list"><div class="empty-state">กำลังโหลด...</div></div>`;
    root.querySelector("#home-new-btn").onclick = () => navigate("/project/new");

    try {
      const idx = isFirebaseConnected() ? await getFirebaseIndex() : await getIndex(true);
      const listEl = root.querySelector("#home-list");
      if (!idx.entries.length) {
        listEl.innerHTML = `<div class="empty-state"><div class="emoji">📭</div><p>ยังไม่มีโปรเจกต์ — เริ่มสร้างโปรเจกต์แรกของคุณ</p></div>`;
        updateGhStatus();
        return;
      }
      listEl.innerHTML = `<div class="project-grid">${idx.entries.map(projectCardHtml).join("")}</div>`;
      idx.entries.forEach((e) => {
        const card = listEl.querySelector(`[data-id="${e.id}"]`);
        card.querySelector(".open-area").onclick = () => navigate(`/project/${e.id}/summary`);
        card.querySelector(".btn-del").onclick = (ev) => {
          ev.stopPropagation();
          const storageLabel = isFirebaseConnected() ? "Firebase" : "GitHub";
          confirmModal("ลบโปรเจกต์นี้?", `จะลบข้อมูลของ "${e.name}" ออกจาก ${storageLabel} อย่างถาวร`, async () => {
            if (isFirebaseConnected()) await deleteProjectFromFirebase(e.id);
            else await deleteProjectFromGithub(e.id);
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

  function projectCardHtml(e) {
    return `<div class="card project-card" data-id="${e.id}">
      <div class="open-area">
        <h4>${escapeHtml(e.name || "(ไม่มีชื่อ)")}</h4>
        <div class="meta">${escapeHtml(e.place || "")} · ${escapeHtml(e.date || "")} · ${e.peopleCount} คน</div>
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
    if (savedPerson) renderGuestSplit(savedPerson.id);
    else renderGuestNamePicker();

    function shell(inner) {
      root.innerHTML = `<div class="guest-shell">${inner}</div>`;
    }

    function doneSet() {
      const validIds = new Set(currentProject.people.map((p) => p.id));
      return new Set((currentProject.doneBy || []).filter((id) => validIds.has(id)));
    }

    function renderGuestNamePicker() {
      const done = doneSet();
      shell(`
        <div class="card guest-card">
          <div class="section-title">เลือกชื่อของคุณ</div>
          <div class="section-sub">${escapeHtml(currentProject.name || "โปรเจกต์หารบิล")} · ${escapeHtml(currentProject.place || "")}</div>
          <div class="guest-name-grid">
            ${currentProject.people.filter((p) => p.name.trim()).map((p) => `
              <button class="guest-name-card ${done.has(p.id) ? "done" : ""}" data-person="${p.id}">
                <span>${escapeHtml(p.name)}</span>
                <small>${done.has(p.id) ? "เลือกแล้ว" : "คลิกเพื่อเลือกเมนู"}</small>
              </button>
            `).join("")}
          </div>
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
      if (doneSet().has(personId)) { renderGuestSummary(personId); return; }

      const items = p.items.filter((it) => it.name.trim());
      const people = p.people.filter((pp) => pp.name.trim());
      shell(`
        <div class="card guest-card">
          <div class="toolbar-row">
            <div>
              <div class="section-title">เลือกเมนูของ ${escapeHtml(me.name)}</div>
              <div class="section-sub">ติ๊กได้เฉพาะคอลัมน์ของคุณ ระบบจะบันทึกขึ้น GitHub ทันที</div>
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
            toast("บันทึกแล้ว");
          } catch (e) {
            cb.checked = !checked;
            toast("บันทึกไม่สำเร็จ: " + e.message, true);
          } finally {
            cb.disabled = false;
          }
        };
      });
      root.querySelector("#guest-confirm").onclick = async () => {
        try {
          await updateGuestProjectFirebase(projectId, (project) => {
            project.doneBy = project.doneBy || [];
            if (!project.doneBy.includes(personId)) project.doneBy.push(personId);
          }, `guest ${me.name} confirmed`, firebaseSettings);
          const missing = currentProject.people.filter((pp) => pp.name.trim() && !doneSet().has(pp.id)).length;
          toast(missing ? `ยืนยันแล้ว รอเพื่อนอีก ${missing} คน` : "ทุกคนเลือกครบแล้ว");
          renderGuestSummary(personId);
        } catch (e) {
          toast("ยืนยันไม่สำเร็จ: " + e.message, true);
        }
      };
    }

    function renderGuestSummary(personId) {
      const p = currentProject;
      const s = computeSummary(p);
      const me = p.people.find((pp) => pp.id === personId);
      const mine = s.people.find((pp) => pp.id === personId);
      const done = doneSet();
      const totalPeople = p.people.filter((pp) => pp.name.trim()).length;
      const missing = Math.max(0, totalPeople - done.size);
      const myLines = s.items.filter((it) => it.sharers.includes(personId))
        .map((it) => `<div class="line"><span>${escapeHtml(it.name)}</span><span>฿${baht(it.perPerson)}</span></div>`).join("");

      shell(`
        <div class="card guest-card">
          <div class="toolbar-row">
            <div>
              <div class="section-title">${missing ? `สรุปของ ${escapeHtml(me ? me.name : "")}` : "สรุปผลครบแล้ว"}</div>
              <div class="section-sub">${missing ? `รอเพื่อนอีก ${missing} คน` : "ทุกคนยืนยันการเลือกครบแล้ว"}</div>
            </div>
            ${done.has(personId) ? "" : `<button class="btn ghost" id="guest-edit">กลับไปแก้ไข</button>`}
          </div>
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
      root.querySelector("#guest-export-img").onclick = () => exportImage(p, root.querySelector("#guest-receipt-capture"));
    }
  }

  // ---------------------------------------------------------------
  // View: Wizard
  // ---------------------------------------------------------------
  function renderWizard(step) {
    const root = document.getElementById("view-root");
    const stepIdx = Math.max(0, STEPS.findIndex((s) => s.key === step));
    root.innerHTML = `
      <div class="wizard-steps">${STEPS.map((s, i) => `
        <div class="wizard-step-pill ${i === stepIdx ? "active" : i < stepIdx ? "done" : ""}" data-step="${s.key}">${s.label}</div>
      `).join("")}</div>
      <div class="card" id="wizard-body"></div>
    `;
    root.querySelectorAll(".wizard-step-pill").forEach((el) => {
      el.onclick = () => navigate(`/project/${currentProject.id}/${el.dataset.step}`);
    });
    const body = document.getElementById("wizard-body");
    const renderers = { info: stepInfo, menu: stepMenu, people: stepPeople, split: stepSplit, summary: stepSummary };
    (renderers[STEPS[stepIdx].key] || stepInfo)(body, stepIdx);
  }

  function wizardFooter(body, stepIdx, opts = {}) {
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
    if (prevKey) footer.querySelector("#wf-prev").onclick = async () => {
      if (opts.onSave) await opts.onSave();
      navigate(`/project/${currentProject.id}/${prevKey}`);
    };
    if (nextKey) footer.querySelector("#wf-next").onclick = async () => {
      if (opts.onSave) {
        const ok = await opts.onSave();
        if (ok === false) return;
      }
      navigate(`/project/${currentProject.id}/${nextKey}`);
    };
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
        <div class="field"><label>ส่วนลดรวม (บาท)</label><input type="number" min="0" step="0.01" id="f-discount" value="${p.totalDiscount}"></div>
        <div class="field"><label>ค่าบริการ (%)</label><input type="number" min="0" step="0.01" id="f-service" value="${p.serviceChargePercent}"></div>
        <div class="field"><label>VAT (%)</label><input type="number" min="0" step="0.01" id="f-vat" value="${p.vatPercent}"></div>
      </div>
      <div class="help-box">💡 ส่วนลดรวมจะถูกหารเฉลี่ยให้แต่ละเมนูตามสัดส่วนราคา ส่วนค่าบริการและ VAT จะคิดจากยอดรวมหลังหักส่วนลด แล้วเฉลี่ยคืนให้แต่ละคนตามสัดส่วนที่กิน</div>
    `;
    function sync() {
      p.name = body.querySelector("#f-name").value;
      p.date = body.querySelector("#f-date").value;
      p.place = body.querySelector("#f-place").value;
      p.totalDiscount = parseFloat(body.querySelector("#f-discount").value) || 0;
      p.serviceChargePercent = parseFloat(body.querySelector("#f-service").value) || 0;
      p.vatPercent = parseFloat(body.querySelector("#f-vat").value) || 0;
    }
    body.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", sync));
    wizardFooter(body, stepIdx, {
      onSave: async () => {
        sync();
        if (!p.name.trim()) { toast("กรุณาตั้งชื่อโปรเจกต์ก่อน", true); return false; }
        return persistDraftAndMaybeGithub();
      },
    });
  }

  // --- Step 2: menu ---
  function stepMenu(body, stepIdx) {
    const p = currentProject;
    function rowsHtml() {
      return p.items.map((it) => `
        <div class="row-item" data-id="${it.id}">
          <input type="text" class="name-input" placeholder="ชื่อเมนู" value="${escapeHtml(it.name)}">
          <input type="number" min="0" step="0.01" class="price-input" placeholder="ราคา" value="${it.price}">
          <button class="row-remove-btn" title="ลบ">✕</button>
        </div>`).join("");
    }
    function totalLine() {
      const sum = p.items.reduce((s, it) => s + (Number(it.price) || 0), 0);
      return `<div class="help-box">รวมราคาเมนู (ก่อนหักส่วนลด): <strong style="color:var(--accent)">฿${baht(sum)}</strong></div>`;
    }
    body.innerHTML = `
      <div class="section-title">รายการเมนู</div>
      <div class="section-sub">กรอกชื่อเมนูและราคาตามใบเสร็จ หรือนำเข้าจากไฟล์ที่ Claude อ่านจากรูปบิลให้</div>
      <div class="row-list" id="menu-rows">${rowsHtml()}</div>
      <div style="display:flex; gap:10px; margin-bottom:16px; flex-wrap:wrap;">
        <button class="btn ghost sm" id="add-item-btn">+ เพิ่มเมนู</button>
        <button class="btn ghost sm" id="import-json-btn">📥 นำเข้าจากไฟล์ (Claude อ่านจากรูปบิล)</button>
        <input type="file" id="import-json-input" accept="application/json,.json" style="display:none;">
      </div>
      <div class="help-box" style="margin-bottom:16px;">
        💡 อัปโหลดรูปบิลให้ Claude ในแชท แล้วขอให้ "อ่านเมนูจากรูปนี้" — Claude จะส่งไฟล์ .json กลับมาให้
        กดปุ่ม "นำเข้าจากไฟล์" แล้วเลือกไฟล์นั้น รายการจะถูกเติมเข้าตารางด้านบนให้อัตโนมัติ
      </div>
      <div id="menu-total">${totalLine()}</div>
    `;
    function wireRows() {
      body.querySelectorAll("#menu-rows .row-item").forEach((row) => {
        const id = row.dataset.id;
        const item = p.items.find((x) => x.id === id);
        row.querySelector(".name-input").oninput = (e) => { item.name = e.target.value; };
        row.querySelector(".price-input").oninput = (e) => {
          item.price = parseFloat(e.target.value) || 0;
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
    body.querySelector("#import-json-btn").onclick = () => body.querySelector("#import-json-input").click();
    body.querySelector("#import-json-input").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed) ? parsed : parsed.items;
        if (!Array.isArray(list) || !list.length) throw new Error("ไฟล์ไม่มีรายการเมนู (items)");
        let added = 0;
        list.forEach((it) => {
          const name = String(it.name || it.ชื่อเมนู || "").trim();
          const price = Number(it.price || it.ราคา || 0);
          if (!name) return;
          p.items.push({ id: uuid(), name, price: isFinite(price) ? price : 0 });
          added++;
        });
        body.querySelector("#menu-rows").innerHTML = rowsHtml();
        body.querySelector("#menu-total").innerHTML = totalLine();
        wireRows();
        toast(`นำเข้าเมนูสำเร็จ ${added} รายการ — ตรวจสอบราคาอีกครั้งก่อนไปขั้นต่อไป`);
      } catch (err) {
        toast("นำเข้าไฟล์ไม่สำเร็จ: " + err.message, true);
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

    // --- Saved people pool (shared across all projects, stored on GitHub) ---
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
        <div class="section-sub" style="margin-bottom:8px;">รายชื่อที่บันทึกไว้ (คลิกเพื่อเพิ่ม)</div>
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
    if (isConnected()) {
      savedBox.innerHTML = `<div class="help-box">กำลังโหลดรายชื่อที่บันทึกไว้...</div>`;
      getSavedPeople().then(renderSavedChips).catch(() => { savedBox.innerHTML = ""; });
    }

    wizardFooter(body, stepIdx, {
      onSave: async () => {
        const valid = p.people.filter((pp) => pp.name.trim());
        if (!valid.length) { toast("กรุณาเพิ่มคนอย่างน้อย 1 คน", true); return false; }
        const ok = await persistDraftAndMaybeGithub();
        if (ok && isConnected() && !isFirebaseConnected()) {
          addNamesToSavedPeople(valid.map((pp) => pp.name)).catch(() => {});
        }
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
    body.querySelector("#share-link-btn").onclick = async () => {
      const ok = await persistDraftAndMaybeGithub();
      if (ok) shareProjectLink(p);
    };
    function wire() {
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
        body.querySelector("#share-link-btn").onclick = async () => {
          const ok = await persistDraftAndMaybeGithub();
          if (ok) shareProjectLink(p);
        };
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
    const s = computeSummary(p);

    body.innerHTML = `
      <div class="toolbar-row">
        <div><div class="section-title">สรุปผล — ${escapeHtml(p.name)}</div>
        <div class="section-sub">${escapeHtml(p.place || "")} · ${escapeHtml(p.date || "")}</div></div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn ghost" id="share-summary-btn">📤 แชร์ลิงก์</button>
          <button class="btn ghost" id="save-now-btn">💾 บันทึกขึ้น GitHub</button>
          <button class="btn ghost" id="export-img-btn">🖼️ Export รูปภาพ</button>
          <button class="btn primary" id="export-pdf-btn">⬇️ Export PDF</button>
        </div>
      </div>

      ${s.unassignedItems.length ? `<div class="badge warn" style="display:inline-block;margin-bottom:14px;">⚠️ มี ${s.unassignedItems.length} เมนูที่ยังไม่ระบุคนหาร — ยอดรวมอาจไม่ครบ</div>` : ""}

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
      row.onclick = () => row.nextElementSibling.classList.toggle("open");
    });

    body.querySelector("#save-now-btn").onclick = async () => {
      const ok = await persistDraftAndMaybeGithub();
      toast(ok ? "บันทึกขึ้น GitHub แล้ว" : "บันทึกไม่สำเร็จ", !ok);
    };
    body.querySelector("#share-summary-btn").onclick = async () => {
      const ok = await persistDraftAndMaybeGithub();
      if (ok) shareProjectLink(p);
    };
    body.querySelector("#export-img-btn").onclick = () => exportImage(p, body.querySelector("#receipt-capture"));
    body.querySelector("#export-pdf-btn").onclick = () => exportPdf(p, body.querySelector("#receipt-capture"));

    renderCharts(s);
    wizardFooter(body, stepIdx, { onSave: () => persistDraftAndMaybeGithub() });
  }

  function personRowHtml(pf, s, p) {
    const lines = s.items.filter((it) => it.sharers.includes(pf.id))
      .map((it) => `<div class="line"><span>${escapeHtml(it.name)}</span><span>฿${baht(it.perPerson)}</span></div>`).join("");
    return `<div>
      <div class="person-row"><span class="name">${escapeHtml(pf.name)}</span><span class="amt">฿${baht(pf.total)}</span></div>
      <div class="person-detail">
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
          datasets: [{ data: s.people.map((p) => Number(p.total.toFixed(2))), backgroundColor: palette }],
        },
        options: { plugins: { legend: { position: "bottom", labels: { color: textColor, boxWidth: 12 } } } },
      });
    }
  }

  // ---------------------------------------------------------------
  // PDF export
  // ---------------------------------------------------------------
  async function exportPdf(project, captureEl) {
    toast("กำลังสร้าง PDF...");
    try {
      if (!window.html2canvas || !window.jspdf) {
        throw new Error("โหลดไลบรารี PDF ไม่สำเร็จ กรุณาต่ออินเทอร์เน็ตแล้วรีเฟรชหน้า");
      }
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
      pdf.save(filename);
      toast("ดาวน์โหลด PDF เรียบร้อย (ขนาดใบเสร็จ 80mm หน้าเดียว)");
    } catch (e) {
      console.error(e);
      toast("Export PDF ไม่สำเร็จ: " + e.message, true);
    }
  }

  async function exportImage(project, captureEl) {
    toast("กำลังสร้างรูปภาพ...");
    try {
      if (!window.html2canvas) {
        throw new Error("โหลดไลบรารีสร้างรูปภาพไม่สำเร็จ กรุณาต่ออินเทอร์เน็ตแล้วรีเฟรชหน้า");
      }
      const canvas = await html2canvas(captureEl, { scale: 2, backgroundColor: "#fdfaf2" });
      const link = document.createElement("a");
      link.download = `bill_${(project.name || "project").replace(/[^a-zA-Z0-9ก-๙_-]+/g, "_")}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      toast("ดาวน์โหลดรูปภาพเรียบร้อย");
    } catch (e) {
      console.error(e);
      toast("Export รูปภาพไม่สำเร็จ: " + e.message, true);
    }
  }

  // ---------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------
  function openSettingsModal() {
    const modal = document.getElementById("settings-modal");
    document.getElementById("set-firebase-config").value = firebaseSettings ? JSON.stringify(firebaseSettings, null, 2) : "";
    if (settings) {
      document.getElementById("set-token").value = settings.token || "";
      document.getElementById("set-owner").value = settings.owner || "";
      document.getElementById("set-repo").value = settings.repo || "";
      document.getElementById("set-branch").value = settings.branch || "main";
    }
    document.getElementById("settings-test-result").textContent = "";
    document.getElementById("firebase-test-result").textContent = "";
    modal.classList.add("open");
  }
  function closeSettingsModal() { document.getElementById("settings-modal").classList.remove("open"); }

  function confirmModal(title, bodyText, onOk) {
    const modal = document.getElementById("confirm-modal");
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-body").textContent = bodyText;
    modal.classList.add("open");
    const cleanup = () => modal.classList.remove("open");
    document.getElementById("confirm-cancel").onclick = cleanup;
    document.getElementById("confirm-ok").onclick = async () => { cleanup(); await onOk(); };
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

  function initSettingsModal() {
    document.getElementById("settings-btn").onclick = openSettingsModal;
    document.getElementById("settings-close").onclick = closeSettingsModal;
    document.getElementById("firebase-save").onclick = async () => {
      const resultEl = document.getElementById("firebase-test-result");
      try {
        const raw = document.getElementById("set-firebase-config").value.trim();
        if (!raw) throw new Error("กรุณาวาง Firebase config JSON");
        const parsed = JSON.parse(raw);
        const required = ["apiKey", "authDomain", "projectId", "appId"];
        const missing = required.filter((key) => !parsed[key]);
        if (missing.length) throw new Error(`config ขาด ${missing.join(", ")}`);
        resultEl.textContent = "กำลังทดสอบ Firebase...";
        resultEl.className = "settings-test-result";
        firebaseRuntime = null;
        await getFirebaseRuntime(parsed);
        saveFirebaseSettingsToStorage(parsed);
        resultEl.textContent = "✅ บันทึก Firebase แล้ว";
        resultEl.className = "settings-test-result ok";
        indexCache = null;
        setTimeout(() => { closeSettingsModal(); router(); }, 500);
      } catch (err) {
        resultEl.textContent = "❌ " + (err.message || "ตั้งค่า Firebase ไม่สำเร็จ");
        resultEl.className = "settings-test-result fail";
      }
    };
    document.getElementById("firebase-disconnect").onclick = () => {
      clearFirebaseSettings();
      document.getElementById("set-firebase-config").value = "";
      document.getElementById("firebase-test-result").textContent = "ล้าง Firebase แล้ว";
      document.getElementById("firebase-test-result").className = "settings-test-result";
      router();
    };
    document.getElementById("settings-disconnect").onclick = () => {
      clearSettings();
      closeSettingsModal();
      toast("ล้างการเชื่อมต่อ GitHub แล้ว");
      router();
    };
    document.getElementById("settings-form").onsubmit = async (e) => {
      e.preventDefault();
      const newSettings = {
        token: document.getElementById("set-token").value.trim(),
        owner: document.getElementById("set-owner").value.trim(),
        repo: document.getElementById("set-repo").value.trim(),
        branch: document.getElementById("set-branch").value.trim() || "main",
      };
      const resultEl = document.getElementById("settings-test-result");
      resultEl.textContent = "กำลังทดสอบการเชื่อมต่อ...";
      resultEl.className = "settings-test-result";
      const prev = settings;
      saveSettingsToStorage(newSettings);
      try {
        await testConnection();
        resultEl.textContent = "✅ เชื่อมต่อสำเร็จ!";
        resultEl.className = "settings-test-result ok";
        indexCache = null;
        setTimeout(() => { closeSettingsModal(); router(); }, 700);
      } catch (err) {
        settings = prev;
        if (prev) localStorage.setItem(SETTINGS_KEY, JSON.stringify(prev));
        else localStorage.removeItem(SETTINGS_KEY);
        resultEl.textContent = "❌ " + err.message;
        resultEl.className = "settings-test-result fail";
        updateGhStatus("error");
      }
    };
  }

  window.addEventListener("hashchange", router);
  window.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initSettingsModal();
    updateGhStatus();
    router();
  });
})();
