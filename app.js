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
