(function () {
  "use strict";

  const SEED_WORDS = window.WORD_DATA || [];
  const UPLOAD_KEY = "wordMemoryCoach.uploadedWords.v3";
  const PROGRESS_KEY = "wordMemoryCoach.progress.v3";
  const OFFLINE_KEY = "wordMemoryCoach.offlineRoom.v3";
  const COVER_KEY = "wordMemoryCoach.coverImage.v1";
  const DEFAULT_COVER = "assets/farm-cover.webp";
  const FALLBACK_COVER = "assets/farm-cover.jpg";
  const COVER_PLACEHOLDER = "assets/farm-cover-placeholder.svg";
  const MODULES = {
    read: { phase: 1, title: "读音浇灌", eyebrow: "READ ALOUD" },
    understand: { phase: 2, title: "理解施肥", eyebrow: "UNDERSTAND" },
    spell: { phase: 3, title: "默写收获", eyebrow: "SPELLING" }
  };

  const dom = {};
  const session = {
    role: "teacher",
    name: "张老师",
    room: "WORD-1800",
    clientId: getClientId(),
    view: "read",
    pendingModule: "read",
    joined: false,
    connected: false,
    offline: false,
    state: null,
    pollingTimer: null,
    pollingBusy: false,
    readTimer: null,
    activeTool: "pointer",
    activeColor: "#b83b35",
    currentStroke: null,
    readQueueRunning: false,
    activeAudio: null,
    audioCache: new Map(),
    audioPrefetchTimer: null,
    audioPrefetchRun: 0,
    erasing: false,
    erasedStrokeIds: new Set(),
    lastRenderedWordId: null,
    selectedSpellIds: new Set(),
    previewTask: null,
    teacherShowAnswer: false,
    enrichmentToken: 0,
    progress: readJson(PROGRESS_KEY, {})
  };

  function getClientId() {
    const key = "wordMemoryCoach.clientId.v3";
    let clientId = "";
    try { clientId = localStorage.getItem(key) || ""; } catch (error) { console.warn(error); }
    if (!clientId) {
      clientId = window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try { localStorage.setItem(key, clientId); } catch (error) { console.warn(error); }
    }
    return clientId;
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn("读取本地数据失败", error);
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { console.warn(error); }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function cacheDom() {
    [
      "loadingScreen", "bootProgressBar", "bootProgressText",
      "homeScreen", "appRoot", "coverImage", "coverImageInput", "uploadCoverButton",
      "resetCoverButton", "homeConnectionButton", "homeSessionLabel", "homeButton",
      "connectionStatus", "roomLabel", "copyInviteButton", "uploadButton", "leaveButton",
      "joinDialog", "roomInput", "nameInput", "joinButton", "uploadDialog", "wordFileInput",
      "uploadText", "uploadPreview", "autoEnrich", "cancelUpload", "confirmUpload", "dayNav", "dayWordList",
      "dailyPendingCount", "weekProgressText", "wordListCount", "wordBankLabel", "enrichCurrentWordsButton", "wordBankSelect", "loadWordBankButton", "manageWordBanksButton",
      "bankManagerDialog", "bankManagerList", "closeBankManagerButton",
      "exportStudentDataButton", "studentPublishDialog", "studentPublishToken", "studentPublishRepo", "studentPublishBranch", "studentPublishRememberToken", "studentPublishStatus", "downloadStudentDataButton", "publishStudentDataButton", "closeStudentPublishButton", "studentPageUrlPreview",
      "activeDayLabel", "moduleEyebrow", "moduleTitle", "wordPosition", "studentCount",
      "readView", "readWordGrid", "readQueueButton", "previousWord", "nextWord",
      "understandView", "understandingList", "spellView", "spellSelectedCount",
      "selectAllSpell", "invertSpellSelection", "clearSpellSelection", "spellWordChecklist",
      "spellTaskType", "generateSpellTask", "publishSpellTask", "spellTaskTitle",
      "spellTaskCount", "spellTaskList", "submitSpellTask", "toggleTeacherAnswer",
      "toggleStudentAnswer", "studentTaskResult", "answerKeyPanel", "toolBar", "colorBar",
      "clearStrokes", "submissionCounter", "studentSubmissions", "pageAnnotationCanvas"
    ].forEach((id) => { dom[id] = document.getElementById(id); });
  }

  function bindEvents() {
    document.querySelectorAll("[data-module]").forEach((button) => {
      button.addEventListener("click", () => requestModule(button.dataset.module));
    });
    dom.homeConnectionButton.addEventListener("click", () => openJoinDialog("read"));
    dom.uploadCoverButton.addEventListener("click", () => dom.coverImageInput.click());
    dom.coverImageInput.addEventListener("change", handleCoverImage);
    dom.resetCoverButton.addEventListener("click", resetCoverImage);
    dom.coverImage.addEventListener("error", handleCoverImageError);
    dom.homeButton.addEventListener("click", showHome);
    document.querySelectorAll(".role-card").forEach((button) => {
      button.addEventListener("click", () => {
        session.role = button.dataset.role;
        document.querySelectorAll(".role-card").forEach((item) => item.classList.toggle("is-active", item === button));
        dom.nameInput.value = session.role === "teacher" ? "张老师" : "学生";
      });
    });
    dom.joinButton.addEventListener("click", joinClassroom);
    dom.leaveButton.addEventListener("click", leaveClassroom);
    dom.dayNav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-day]");
      if (button) selectDay(Number(button.dataset.day));
    });
    dom.loadWordBankButton.addEventListener("click", loadSelectedWordBank);
    dom.manageWordBanksButton.addEventListener("click", openBankManager);
    dom.closeBankManagerButton.addEventListener("click", () => dom.bankManagerDialog.close());
    dom.bankManagerList.addEventListener("click", handleBankManagerClick);
    dom.exportStudentDataButton.addEventListener("click", openStudentPublishDialog);
    dom.closeStudentPublishButton.addEventListener("click", () => dom.studentPublishDialog.close());
    dom.downloadStudentDataButton.addEventListener("click", downloadStudentData);
    dom.publishStudentDataButton.addEventListener("click", publishStudentData);
    dom.dayWordList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-word-id]");
      if (button) selectWord(button.dataset.wordId);
    });
    dom.readWordGrid.addEventListener("click", handleReadGridClick);
    dom.readQueueButton.addEventListener("click", toggleReadQueue);
    dom.previousWord.addEventListener("click", () => moveWord(-1));
    dom.nextWord.addEventListener("click", () => moveWord(1));
    dom.selectAllSpell.addEventListener("click", () => setAllSpellSelection(true));
    dom.invertSpellSelection.addEventListener("click", invertSpellSelection);
    dom.clearSpellSelection.addEventListener("click", () => setAllSpellSelection(false));
    dom.spellWordChecklist.addEventListener("change", handleSpellCheckChange);
    dom.generateSpellTask.addEventListener("click", () => generateSpellTask(false));
    dom.publishSpellTask.addEventListener("click", () => generateSpellTask(true));
    dom.spellTaskList.addEventListener("click", handleSpellTaskListClick);
    dom.submitSpellTask.addEventListener("click", submitSpellTask);
    dom.toggleTeacherAnswer.addEventListener("click", toggleTeacherAnswer);
    dom.toggleStudentAnswer.addEventListener("click", toggleStudentAnswer);
    dom.copyInviteButton.addEventListener("click", copyInvite);
    dom.enrichCurrentWordsButton.addEventListener("click", enrichCurrentWordBank);
    dom.uploadButton.addEventListener("click", () => dom.uploadDialog.showModal());
    dom.cancelUpload.addEventListener("click", () => dom.uploadDialog.close());
    dom.confirmUpload.addEventListener("click", confirmUpload);
    dom.wordFileInput.addEventListener("change", loadWordFile);
    dom.uploadText.addEventListener("input", updateUploadPreview);
    dom.toolBar.addEventListener("click", handleToolClick);
    dom.colorBar.addEventListener("click", handleColorClick);
    dom.clearStrokes.addEventListener("click", clearStrokes);
    dom.studentSubmissions.addEventListener("click", handleFeedbackClick);
    dom.pageAnnotationCanvas.addEventListener("pointerdown", startStroke);
    dom.pageAnnotationCanvas.addEventListener("pointermove", extendStroke);
    dom.pageAnnotationCanvas.addEventListener("pointerup", finishStroke);
    dom.pageAnnotationCanvas.addEventListener("pointercancel", finishStroke);
    window.addEventListener("resize", resizeCanvas);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      session.activeTool = "pointer";
      document.querySelectorAll("[data-tool]").forEach((item) => item.classList.remove("is-active"));
      updateCanvasMode();
    });
    window.addEventListener("beforeunload", () => {
      if (session.pollingTimer) clearInterval(session.pollingTimer);
      if (session.readTimer) clearInterval(session.readTimer);
    });
  }

  function handleCoverImage(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("请选择图片文件。");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      alert("封面图片请控制在 12MB 以内。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxWidth = 2400;
        const scale = Math.min(1, maxWidth / image.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
        try {
          localStorage.setItem(COVER_KEY, dataUrl);
          setCoverImage(dataUrl, { fallback: FALLBACK_COVER });
        } catch (error) {
          alert("图片压缩后仍无法保存，请换一张尺寸更小的图片。");
        }
        event.target.value = "";
      };
      image.onerror = () => alert("图片读取失败，请更换文件。");
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function setCoverImage(source, options = {}) {
    const fallback = options.fallback || FALLBACK_COVER;
    dom.coverImage.dataset.fallback = fallback;
    dom.coverImage.dataset.fallbackActive = "";
    dom.coverImage.src = source;
  }

  function handleCoverImageError() {
    const fallback = dom.coverImage.dataset.fallback || FALLBACK_COVER;
    const fallbackActive = dom.coverImage.dataset.fallbackActive === "true";
    if (fallback && fallback !== dom.coverImage.getAttribute("src") && !fallbackActive) {
      dom.coverImage.dataset.fallbackActive = "true";
      dom.coverImage.src = fallback;
      return;
    }
    if (dom.coverImage.getAttribute("src") !== COVER_PLACEHOLDER) {
      dom.coverImage.src = COVER_PLACEHOLDER;
    }
  }

  function resetCoverImage() {
    try { localStorage.removeItem(COVER_KEY); } catch (error) { console.warn(error); }
    setCoverImage(DEFAULT_COVER, { fallback: FALLBACK_COVER });
  }

  function applySavedCover() {
    try {
      const saved = localStorage.getItem(COVER_KEY);
      if (saved) setCoverImage(saved, { fallback: FALLBACK_COVER });
    } catch (error) {
      console.warn(error);
    }
  }

  function loadImageOnce(source) {
    return new Promise((resolve) => {
      const image = new Image();
      let settled = false;
      let timeoutId = null;
      const finish = (loaded) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        image.onload = null;
        image.onerror = null;
        resolve(loaded);
      };
      timeoutId = window.setTimeout(() => finish(false), 15000);
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.decoding = "async";
      image.src = source;
    });
  }

  async function preloadImage(source, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (await loadImageOnce(source)) return true;
      if (attempt < retries) {
        await new Promise((resolve) => window.setTimeout(resolve, 450 * (attempt + 1)));
      }
    }
    return false;
  }

  async function preloadCover(source, fallback) {
    if (await preloadImage(source, 2)) return source;
    if (fallback && fallback !== source && await preloadImage(fallback, 2)) return fallback;
    return COVER_PLACEHOLDER;
  }

  function updateBootProgress(completed, total, label) {
    const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 100;
    if (dom.bootProgressBar) dom.bootProgressBar.style.width = `${percent}%`;
    if (dom.bootProgressText) {
      dom.bootProgressText.textContent = percent >= 100
        ? "资源装载完成，正在进入农场…"
        : `正在装载${label} ${percent}%`;
    }
  }

  async function preloadApplicationResources() {
    const source = dom.coverImage.getAttribute("src") || DEFAULT_COVER;
    const fallback = dom.coverImage.dataset.fallback || FALLBACK_COVER;
    const total = 2;
    let completed = 0;
    const reportProgress = (label) => {
      completed += 1;
      updateBootProgress(completed, total, label);
    };

    updateBootProgress(0, total, "资源");
    const [coverSource] = await Promise.all([
      preloadCover(source, fallback).then((resolvedSource) => {
        reportProgress("封面");
        return resolvedSource;
      }),
      preloadImage(COVER_PLACEHOLDER, 2).then((loaded) => {
        reportProgress("像素素材");
        return loaded;
      })
    ]);

    setCoverImage(coverSource, { fallback });
  }
  function openJoinDialog(moduleName) {
    session.pendingModule = moduleName || "read";
    dom.joinDialog.showModal();
  }

  async function requestModule(moduleName) {
    if (!MODULES[moduleName]) return;
    session.pendingModule = moduleName;
    if (!session.joined) {
      openJoinDialog(moduleName);
      return;
    }
    if (session.role === "student") {
      enterModule(moduleName);
      return;
    }
    const phase = MODULES[moduleName].phase;
    if (session.state) session.state.phase = phase;
    enterModule(moduleName);
    void sendAction("setPhase", { phase }, false).catch((error) => {
      console.warn("模块同步失败，已保留本地切换", error);
      setConnectionStatus("同步中断", false);
    });
  }

  async function joinClassroom() {
    session.room = dom.roomInput.value.trim().toUpperCase() || "WORD-1800";
    session.name = dom.nameInput.value.trim() || (session.role === "teacher" ? "张老师" : "学生");
    document.body.classList.toggle("role-student", session.role === "student");
    document.body.classList.toggle("role-teacher", session.role === "teacher");
    dom.roomLabel.textContent = session.room;

    try {
      if (location.protocol === "file:") activateOfflineMode();
      else await joinOnlineRoom();
    } catch (error) {
      console.warn("在线同步不可用，切换单机模式", error);
      activateOfflineMode();
    }

    session.joined = true;
    dom.joinDialog.close();
    dom.homeSessionLabel.textContent = `${session.role === "teacher" ? "教师" : "学生"} · ${session.room}`;
    if (session.role === "teacher") {
      const phase = MODULES[session.pendingModule].phase;
      if (session.state) session.state.phase = phase;
      void sendAction("setPhase", { phase }, false).catch((error) => {
        console.warn("初始模块同步失败", error);
        setConnectionStatus("同步中断", false);
      });
    }
    const initialModule = session.pendingModule || phaseToModule(Number(session.state.phase));
    enterModule(initialModule);
    startPolling();
    updateHistory();
  }

  async function joinOnlineRoom() {
    session.state = await requestState();
    session.offline = false;
    session.connected = true;
    setConnectionStatus("在线同步", true);
    await sendAction("join", { name: session.name }, false);
  }

  function activateOfflineMode() {
    session.offline = true;
    session.connected = false;
    setConnectionStatus("单机模式", false);
    session.state = readJson(OFFLINE_KEY, null) || createOfflineState();
    if (!session.state.words || !session.state.words.length) session.state.words = loadLocalWords();
  }

  function createOfflineState() {
    const words = loadLocalWords();
    return {
      roomId: session.room, version: 0, phase: 1,
      activeDay: words[0] ? words[0].day : 1,
      activeWordId: words[0] ? words[0].id : null,
      words, strokes: {}, students: {}, batchName: "种子词库",
      batchDate: new Date().toISOString().slice(0, 10),
      newWordIds: words.map((word) => word.id),
      spellTask: null, showSpellAnswers: false,
      activeBankId: "seed",
      wordBanks: [{ id: "seed", name: "种子词库", date: new Date().toISOString().slice(0, 10), words }]
    };
  }

  function loadLocalWords() {
    const uploaded = readJson(UPLOAD_KEY, null);
    return Array.isArray(uploaded) && uploaded.length ? uploaded : SEED_WORDS;
  }

  function updateHistory() {
    try {
      const params = new URLSearchParams();
      params.set("room", session.room);
      params.set("role", session.role);
      params.set("module", session.view);
      history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
    } catch (error) {
      console.warn(error);
    }
  }

  function showHome() {
    session.view = "home";
    stopReadQueue();
    updateCanvasMode();
    dom.appRoot.classList.add("is-hidden");
    dom.homeScreen.classList.remove("is-hidden");
    dom.homeSessionLabel.textContent = session.joined
      ? `${session.role === "teacher" ? "教师" : "学生"} · ${session.room}`
      : "尚未连接课堂";
    updateHistory();
  }

  function enterModule(moduleName) {
    if (!session.joined || !MODULES[moduleName]) return;
    session.view = moduleName;
    dom.homeScreen.classList.add("is-hidden");
    dom.appRoot.classList.remove("is-hidden");
    document.body.classList.remove("module-read", "module-understand", "module-spell");
    document.body.classList.add(`module-${moduleName}`);
    dom.readView.classList.toggle("is-hidden", moduleName !== "read");
    dom.understandView.classList.toggle("is-hidden", moduleName !== "understand");
    dom.spellView.classList.toggle("is-hidden", moduleName !== "spell");
    document.querySelectorAll(".module-button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.module === moduleName);
      button.disabled = false;
    });
    dom.homeButton.classList.toggle("is-hidden", session.role === "student");
    const meta = MODULES[moduleName];
    dom.moduleEyebrow.textContent = `${meta.eyebrow} · ${session.room}`;
    dom.moduleTitle.textContent = meta.title;
    renderAll();
    requestAnimationFrame(resizeCanvas);
    updateHistory();
  }

  function phaseToModule(phase) {
    return Object.keys(MODULES).find((key) => MODULES[key].phase === Number(phase)) || "read";
  }

  function startPolling() {
    if (session.offline || session.pollingTimer) return;
    session.pollingTimer = setInterval(refreshState, 1000);
  }

  async function refreshState() {
    if (session.offline || !session.joined || session.pollingBusy || document.visibilityState === "hidden") return;
    session.pollingBusy = true;
    try {
      const state = await requestState(session.state?.version);
      if (!state) return;
      session.state = state;
      session.connected = true;
      setConnectionStatus("在线同步", true);
      renderAll();
    } catch (error) {
      session.connected = false;
      setConnectionStatus("同步中断", false);
    } finally {
      session.pollingBusy = false;
    }
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    if (!text.trim()) {
      throw new Error(`服务器返回为空（HTTP ${response.status}），Codespace 可能正在重启，请稍后重试。`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`服务器返回异常（HTTP ${response.status}），请稍后重试。`);
    }
  }

  function isRetryableRequestError(error) {
    return error?.name === "TypeError" || /为空|Failed to fetch|NetworkError|network|超时|JSON input|response/i.test(String(error?.message || ""));
  }

  async function fetchJson(url, options = {}, retries = 0) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, options);
        const result = await readJsonResponse(response);
        if (!response.ok || result?.ok === false) {
          throw new Error(result?.error || `请求失败：${response.status}`);
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isRetryableRequestError(error)) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
    throw lastError || new Error("请求失败");
  }

  async function requestState(sinceVersion = null) {
    let url = `/api/state?room=${encodeURIComponent(session.room)}`;
    if (Number.isInteger(sinceVersion)) url += `&since=${encodeURIComponent(sinceVersion)}`;
    const payload = await fetchJson(url, { cache: "no-store" });
    if (Number.isInteger(sinceVersion) && payload.changed === false) return null;
    return payload.state || payload;
  }

  async function sendAction(action, payload, rerender = true, options = {}) {
    if (session.offline) {
      applyOfflineAction(action, payload);
      if (rerender) renderAll();
      return { ok: true };
    }
    const result = await fetchJson("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: session.room, role: session.role, clientId: session.clientId, action, payload: payload || {} })
    }, options.retries || 0);
    session.state = result.state;
    if (rerender) renderAll();
    return result;
  }

  function applyOfflineAction(action, payload) {
    const state = session.state;
    if (action === "join") return;
    if (action === "setPhase") state.phase = Number(payload.phase) || 1;
    if (action === "setWord") state.activeWordId = payload.wordId;
    if (action === "setDay") state.activeDay = Number(payload.day) || 1;
    if (action === "addStroke") {
      const key = payload.strokeKey || annotationKey();
      state.strokes[key] = state.strokes[key] || [];
      state.strokes[key].push(payload.stroke);
    }
    if (action === "clearStrokes") state.strokes[payload.strokeKey || annotationKey()] = [];
    if (action === "eraseStrokes") {
      const key = payload.strokeKey || annotationKey();
      const ids = new Set(payload.strokeIds || []);
      state.strokes[key] = (state.strokes[key] || []).filter((stroke) => !ids.has(String(stroke.id)));
    }
    if (action === "replaceWords") {
      state.words = payload.words;
      state.activeWordId = state.words[0] ? state.words[0].id : null;
      state.activeDay = state.words[0] ? state.words[0].day : 1;
      state.strokes = {};
      state.batchName = payload.batchName || "导入词库";
      state.batchDate = new Date().toISOString().slice(0, 10);
      state.newWordIds = state.words.map((word) => word.id);
      state.spellTask = null;
      state.showSpellAnswers = false;
      state.wordBanks = state.wordBanks || [];
      if (payload.recordBank !== false) {
        const bankId = `bank-${Date.now()}`;
        state.wordBanks.push({ id: bankId, name: state.batchName, date: state.batchDate, words: structuredClone(state.words) });
        state.wordBanks = state.wordBanks.slice(-50);
        state.activeBankId = bankId;
      }
      writeJson(UPLOAD_KEY, state.words);
    }
    if (action === "loadWordBank") {
      const bank = (state.wordBanks || []).find((item) => item.id === payload.bankId);
      if (bank && Array.isArray(bank.words) && bank.words.length) {
        state.words = structuredClone(bank.words);
        state.activeWordId = state.words[0].id;
        state.activeDay = state.words[0].day || 1;
        state.batchName = bank.name;
        state.batchDate = bank.date;
        state.newWordIds = state.words.map((word) => word.id);
        state.activeBankId = bank.id;
        state.spellTask = null;
        state.showSpellAnswers = false;
      }
    }
    if (action === "deleteWordBank") {
      const banks = state.wordBanks || [];
      const bank = banks.find((item) => item.id === payload.bankId);
      if (bank && bank.id !== "seed" && bank.name !== "种子词库") {
        const remaining = banks.filter((item) => item.id !== bank.id);
        if (remaining.length) {
          state.wordBanks = remaining;
          if (state.activeBankId === bank.id) {
            const replacement = remaining[remaining.length - 1];
            state.words = structuredClone(replacement.words);
            state.activeWordId = state.words[0]?.id || null;
            state.activeDay = state.words[0]?.day || 1;
            state.batchName = replacement.name;
            state.batchDate = replacement.date;
            state.newWordIds = state.words.map((word) => word.id);
            state.activeBankId = replacement.id;
            state.spellTask = null;
            state.showSpellAnswers = false;
          }
        }
      }
    }
    if (action === "publishSpellTask") {
      state.spellTask = payload.task;
      state.showSpellAnswers = false;
      Object.values(state.students || {}).forEach((student) => {
        student.answer = "";
        student.answers = [];
        student.submittedAt = null;
        student.status = "idle";
        student.correct = null;
        student.feedback = "";
      });
    }
    if (action === "gradeItem") {
      const student = state.students[payload.studentId];
      if (student) {
        student.itemResults = student.itemResults || {};
        student.itemResults[payload.itemId] = Boolean(payload.correct);
        student.status = "reviewing";
      }
    }
    if (action === "publishGrades") {
      const student = state.students[payload.studentId];
      const task = state.spellTask;
      if (student && task) {
        const checked = task.items.filter((item) => item.id in (student.itemResults || {})).map((item) => Boolean(student.itemResults[item.id]));
        student.correct = checked.length > 0 && checked.every(Boolean);
        student.status = "checked";
        student.feedback = payload.feedback || "";
      }
    }
    if (action === "setSpellAnswerVisibility") state.showSpellAnswers = Boolean(payload.visible);
    if (action === "submitAnswer") {
      state.students[session.clientId] = {
        ...(state.students[session.clientId] || { clientId: session.clientId, name: session.name }),
        answer: payload.answer || "",
        answers: Array.isArray(payload.answers) ? payload.answers : [],
        submittedAt: new Date().toISOString(),
        status: "pending",
        correct: null,
        feedback: ""
      };
    }
    if (action === "teacherFeedback") {
      const student = state.students[payload.studentId];
      if (student) {
        student.correct = Boolean(payload.correct);
        student.status = "checked";
        student.feedback = payload.feedback || "";
        session.progress[state.activeWordId] = student.correct;
        writeJson(PROGRESS_KEY, session.progress);
      }
    }
    state.version = Number(state.version || 0) + 1;
    writeJson(OFFLINE_KEY, state);
  }

  async function performAction(action, payload) {
    try {
      await sendAction(action, payload, true);
      setConnectionStatus(session.offline ? "单机模式" : "在线同步", !session.offline);
    } catch (error) {
      console.error(error);
      setConnectionStatus("操作失败", false);
    }
  }

  function setConnectionStatus(text, online) {
    dom.connectionStatus.textContent = text;
    dom.connectionStatus.classList.toggle("online", Boolean(online));
    dom.connectionStatus.classList.toggle("offline", !online);
  }

  function leaveClassroom() {
    stopReadQueue();
    if (session.pollingTimer) clearInterval(session.pollingTimer);
    session.pollingTimer = null;
    session.state = null;
    session.joined = false;
    session.connected = false;
    session.offline = false;
    showHome();
  }

  function renderAll() {
    if (!session.state || !session.joined || session.view === "home") return;
    renderDayNav();
    renderWordList();
    if (session.view === "read") renderReadGrid();
    if (session.view === "understand") renderUnderstandingList();
    if (session.view === "spell") renderSpellView();
    renderSubmissions();
    updateHeaderStats();
    updateCanvasMode();
  }

  function visibleWords() {
    const words = session.state.words || [];
    const day = Number(session.state.activeDay || words[0]?.day || 1);
    const filtered = words.filter((word) => Number(word.day || 1) === day);
    return filtered.length ? filtered : words;
  }

  function currentWord() {
    const words = session.state?.words || [];
    return words.find((word) => word.id === session.state.activeWordId) || words[0] || null;
  }

  function renderDayNav() {
    const words = session.state.words || [];
    const days = [...new Set(words.map((word) => Number(word.day || 1)))].sort((a,b) => a-b);
    dom.dayNav.innerHTML = days.map((day) => {
      const dayWords = words.filter((word) => Number(word.day || 1) === day);
      const done = dayWords.filter((word) => session.progress[word.id]).length;
      const active = Number(session.state.activeDay) === day;
      return `<button class="day-button${active ? " is-active" : ""}" data-day="${day}" type="button" ${session.role === "student" ? "disabled" : ""}>
        <strong>DAY ${day}</strong><span>${done} / ${dayWords.length} 已收获</span>
      </button>`;
    }).join("");
    const total = words.length;
    const done = words.filter((word) => session.progress[word.id]).length;
    dom.weekProgressText.textContent = `${done} / ${total}`;
    dom.wordListCount.textContent = `${total} 个`;
    const bankEntries = bankDisplayEntries(session.state.wordBanks || []);
    const activeBankEntry = bankEntries.find((entry) => entry.bank.id === session.state.activeBankId);
    dom.wordBankLabel.textContent = activeBankEntry?.label || session.state.batchName || (session.offline ? "本地词库" : "房间词库");
    dom.activeDayLabel.textContent = session.state.activeDay || 1;
    renderWordBanks();
  }

  function isSeedBank(bank) {
    return bank?.id === "seed" || String(bank?.name || "") === "种子词库";
  }

  function formatBankDate(value) {
    const raw = String(value || "").trim();
    const fullMatch = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (fullMatch) return `${fullMatch[2].padStart(2, "0")}-${fullMatch[3].padStart(2, "0")}`;
    const shortMatch = raw.match(/(\d{1,2})[\/-](\d{1,2})/);
    if (shortMatch) return `${shortMatch[1].padStart(2, "0")}-${shortMatch[2].padStart(2, "0")}`;
    return raw || "日期未知";
  }

  function bankDisplayEntries(banks) {
    let dayNumber = 0;
    return (banks || []).map((bank, index) => {
      const count = Array.isArray(bank.words) ? bank.words.length : 0;
      if (isSeedBank(bank)) {
        return { bank, index, dayNumber: 0, label: `种子词库 · ${formatBankDate(bank.date)} · ${count} 词` };
      }
      dayNumber += 1;
      return { bank, index, dayNumber, label: `Day${dayNumber} · ${formatBankDate(bank.date)} · ${count} 词` };
    });
  }

  function renderWordBanks() {
    const banks = Array.isArray(session.state.wordBanks) ? session.state.wordBanks : [];
    const entries = bankDisplayEntries(banks);
    const activeId = session.state.activeBankId || (banks.length ? banks[banks.length - 1].id : "");
    dom.wordBankSelect.innerHTML = entries.slice().reverse().map(({ bank, label }) => {
      return `<option value="${escapeHtml(bank.id)}" ${bank.id === activeId ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
    dom.wordBankSelect.disabled = session.role !== "teacher" || !banks.length;
    dom.loadWordBankButton.disabled = session.role !== "teacher" || !banks.length;
    dom.manageWordBanksButton.disabled = session.role !== "teacher" || !banks.length;
    if (dom.bankManagerDialog?.open) renderBankManager();
  }

  function renderBankManager() {
    const banks = Array.isArray(session.state?.wordBanks) ? session.state.wordBanks : [];
    const entries = bankDisplayEntries(banks).slice().reverse();
    if (!entries.length) {
      dom.bankManagerList.innerHTML = `<div class="bank-manager-empty">暂无历史词库</div>`;
      return;
    }
    dom.bankManagerList.innerHTML = entries.map(({ bank, label }) => {
      const isActive = bank.id === session.state.activeBankId;
      const canDelete = !isSeedBank(bank);
      return `<article class="bank-manager-row${isActive ? " is-active" : ""}">
        <div class="bank-manager-copy">
          <strong>${escapeHtml(label)}</strong>
          <small>${isActive ? "当前正在使用" : "点击“加载”切换到这个词库"}</small>
        </div>
        <div class="bank-manager-actions">
          <button class="pixel-button" type="button" data-bank-load="${escapeHtml(bank.id)}" ${isActive ? "disabled" : ""}>${isActive ? "当前" : "加载"}</button>
          <button class="pixel-button danger" type="button" data-bank-delete="${escapeHtml(bank.id)}" ${canDelete ? "" : "disabled"}>删除</button>
        </div>
      </article>`;
    }).join("");
  }

  function openBankManager() {
    if (session.role !== "teacher" || !session.state) return;
    renderBankManager();
    if (!dom.bankManagerDialog.open) dom.bankManagerDialog.showModal();
  }

  async function loadWordBankById(bankId) {
    if (session.role !== "teacher" || !bankId || bankId === session.state.activeBankId) return;
    session.enrichmentToken += 1;
    dom.enrichCurrentWordsButton.disabled = false;
    dom.enrichCurrentWordsButton.textContent = "智能补全当前词库";
    try {
      await sendAction("loadWordBank", { bankId });
      renderBankManager();
    } catch (error) {
      alert(`加载历史词库失败：${error.message}`);
    }
  }

  async function loadSelectedWordBank() {
    await loadWordBankById(dom.wordBankSelect.value);
  }

  async function handleBankManagerClick(event) {
    const loadButton = event.target.closest("[data-bank-load]");
    if (loadButton) {
      await loadWordBankById(loadButton.dataset.bankLoad);
      return;
    }
    const deleteButton = event.target.closest("[data-bank-delete]");
    if (!deleteButton) return;
    const bankId = deleteButton.dataset.bankDelete;
    const bank = (session.state.wordBanks || []).find((item) => item.id === bankId);
    if (!bank || isSeedBank(bank)) return;
    const entry = bankDisplayEntries(session.state.wordBanks || []).find((item) => item.bank.id === bankId);
    if (!confirm(`确定删除 ${entry?.label || "这个历史词库"}？删除后无法恢复。`)) return;
    try {
      await sendAction("deleteWordBank", { bankId }, true);
      renderBankManager();
    } catch (error) {
      alert(`删除历史词库失败：${error.message}`);
    }
  }

  function cleanStudentWord(word) {
    return {
      id: word.id,
      word: word.word,
      phonetic: word.phonetic || "",
      part: word.part || "",
      meaning: word.meaning || "",
      segments: word.segments || [],
      mnemonic: word.mnemonic || word.hook || "",
      derivatives: word.derivatives || [],
      phrases: word.phrases || [],
      phraseExamples: word.phraseExamples || [],
      example: word.example || "",
      exampleTranslation: word.exampleTranslation || ""
    };
  }

  function buildStudentPayload() {
    const entries = bankDisplayEntries(session.state?.wordBanks || []).filter((entry) => !isSeedBank(entry.bank));
    const source = entries.length
      ? entries
      : [{ bank: { id: session.state?.activeBankId || "current", name: session.state?.batchName || "当前词库", date: session.state?.batchDate || "", words: session.state?.words || [] }, label: "当前词库" }];
    const banks = source.map(({ bank, label }) => ({
      id: bank.id || "current",
      label,
      date: formatBankDate(bank.date || session.state?.batchDate),
      words: (bank.words || session.state?.words || []).map(cleanStudentWord).filter((word) => word.word)
    })).filter((bank) => bank.words.length);
    if (!banks.length) throw new Error("当前没有可发布的学生词库");
    return {
      version: 1,
      title: "像素词汇农场",
      updatedAt: new Date().toISOString(),
      activeBankId: banks.some((bank) => bank.id === session.state?.activeBankId) ? session.state.activeBankId : banks[0].id,
      banks
    };
  }

  function studentPageUrlFromRepo(repo) {
    const [owner, repoName] = String(repo || "").split("/");
    return owner && repoName ? `https://${owner.toLowerCase()}.github.io/${repoName}/student.html` : "";
  }

  function setStudentPublishStatus(message, type = "") {
    dom.studentPublishStatus.textContent = message;
    dom.studentPublishStatus.className = `student-publish-status${type ? ` ${type}` : ""}`;
  }

  function openStudentPublishDialog() {
    if (session.role !== "teacher" || !session.state) return;
    const savedRepo = localStorage.getItem("wordMemoryCoach.studentRepo.v1") || "Zhangjiayi-momo/pixel-word-farm-v2";
    const savedBranch = localStorage.getItem("wordMemoryCoach.studentBranch.v1") || "main";
    dom.studentPublishRepo.value = savedRepo;
    dom.studentPublishBranch.value = savedBranch;
    dom.studentPageUrlPreview.textContent = studentPageUrlFromRepo(savedRepo);
    const savedToken = localStorage.getItem("wordMemoryCoach.studentToken.v1") || "";
    if (savedToken) {
      dom.studentPublishToken.value = savedToken;
      dom.studentPublishRememberToken.checked = true;
    }
    setStudentPublishStatus("可以先下载数据文件，或填写 Token 后直接发布。");
    if (!dom.studentPublishDialog.open) dom.studentPublishDialog.showModal();
  }

  function downloadStudentData() {
    try {
      const payload = buildStudentPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "student-data.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStudentPublishStatus("学生数据已下载。将它替换到 GitHub 仓库根目录的 student-data.json 即可。", "success");
    } catch (error) {
      setStudentPublishStatus(`下载失败：${error.message}`, "error");
    }
  }

  function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  async function gitHubJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch (error) { payload = {}; }
    if (!response.ok) throw new Error(payload.message || `GitHub 请求失败：${response.status}`);
    return payload;
  }

  async function publishStudentData() {
    const token = dom.studentPublishToken.value.trim();
    const repo = dom.studentPublishRepo.value.trim();
    const branch = dom.studentPublishBranch.value.trim() || "main";
    if (!token) {
      setStudentPublishStatus("请先填写 GitHub Token，或使用“下载学生数据”手动替换。", "error");
      return;
    }
    if (!/^[^/]+\/[^/]+$/.test(repo)) {
      setStudentPublishStatus("仓库格式应为 owner/repository。", "error");
      return;
    }
    dom.publishStudentDataButton.disabled = true;
    setStudentPublishStatus("正在发布到 GitHub Pages…");
    try {
      const payload = buildStudentPayload();
      const path = "student-data.json";
      const headers = {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      };
      const targetBranches = repo === "Zhangjiayi-momo/pixel-word-farm-v2"
        ? [...new Set([branch, "main", "gh-pages"])]
        : [branch];
      for (const targetBranch of targetBranches) {
        let sha = "";
        const getResponse = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(targetBranch)}`, { headers });
        if (getResponse.status === 200) {
          sha = (await getResponse.json()).sha || "";
        } else if (getResponse.status !== 404) {
          const errorBody = await getResponse.json().catch(() => ({}));
          throw new Error(errorBody.message || `读取 ${targetBranch} 分支文件失败：${getResponse.status}`);
        }
        await gitHubJson(`https://api.github.com/repos/${repo}/contents/${path}`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `发布学生复习词库 ${new Date().toLocaleString("zh-CN")}`,
            content: encodeBase64Utf8(JSON.stringify(payload, null, 2)),
            branch: targetBranch,
            ...(sha ? { sha } : {})
          })
        });
      }
      localStorage.setItem("wordMemoryCoach.studentRepo.v1", repo);
      localStorage.setItem("wordMemoryCoach.studentBranch.v1", branch);
      if (dom.studentPublishRememberToken.checked) localStorage.setItem("wordMemoryCoach.studentToken.v1", token);
      else localStorage.removeItem("wordMemoryCoach.studentToken.v1");
      const url = studentPageUrlFromRepo(repo);
      dom.studentPageUrlPreview.textContent = url;
      setStudentPublishStatus(`发布成功。已同步 main 和 gh-pages，学生永久链接：${url}`, "success");
    } catch (error) {
      setStudentPublishStatus(`发布失败：${error.message}`, "error");
    } finally {
      dom.publishStudentDataButton.disabled = false;
    }
  }

  function masked(value) {
    return String(value || "").replace(/[A-Za-z]/g, "•");
  }

  function renderWordList() {
    const words = visibleWords();
    const pending = words.filter((word) => !session.progress[word.id]).length;
    dom.dailyPendingCount.textContent = `${pending} 个`;
    dom.dayWordList.innerHTML = words.map((word, index) => {
      const active = word.id === session.state.activeWordId;
      const done = Boolean(session.progress[word.id]);
      const text = session.role === "student" && session.view === "spell" ? masked(word.word) : word.word;
      return `<button class="word-list-button${active ? " is-active" : ""}" data-word-id="${escapeHtml(word.id)}" type="button" ${session.role === "student" ? "disabled" : ""}>
        <span class="word-index">${String(index+1).padStart(2,"0")}</span><b>${escapeHtml(text)}</b><span>${done ? "🌾" : "🌱"}</span>
      </button>`;
    }).join("");
  }

  function renderReadGrid() {
    const words = visibleWords();
    dom.readWordGrid.innerHTML = words.map((word) => {
      const active = word.id === session.state.activeWordId;
      return `<article class="read-word-tile${active ? " is-active" : ""}" data-word-id="${escapeHtml(word.id)}">
        <strong>${escapeHtml(word.word)}</strong>
        <small>${escapeHtml(word.phonetic || "点击喇叭听发音")}</small>
        <button class="mini-speaker" data-speak-id="${escapeHtml(word.id)}" type="button" aria-label="播放 ${escapeHtml(word.word)} 的发音">🔊</button>
      </article>`;
    }).join("");
    scheduleAudioPrefetch(words);
  }

  function renderUnderstandingList() {
    dom.understandingList.innerHTML = visibleWords().map((word) => {
      const active = word.id === session.state.activeWordId;
      const derivatives = (word.derivatives || []).map((item) => {
        const name = Array.isArray(item) ? item[0] : item;
        const meaning = Array.isArray(item) ? item[1] : "";
        return `<li><b>${escapeHtml(name)}</b><span>${escapeHtml(meaning || "待教师复核")}</span></li>`;
      }).join("") || "<li><span>暂无派生词</span></li>";
      const phraseExamples = Array.isArray(word.phraseExamples) ? word.phraseExamples : [];
      const phrases = phraseExamples.length
        ? phraseExamples.map((item) => `<li class="phrase-example-item">
            <div><b>${escapeHtml(item.phrase)}</b><span>${escapeHtml(item.meaning || "")}</span></div>
            <p>${escapeHtml(item.example || "待补充例句")}</p>
            ${item.translation ? `<small>${escapeHtml(item.translation)}</small>` : ""}
            ${item.source ? `<em>${escapeHtml(item.source)}</em>` : ""}
          </li>`).join("")
        : (word.phrases || []).map((item) => `<li><span>${escapeHtml(item)}</span></li>`).join("") || "<li><span>暂无短语</span></li>";
      const segments = (word.segments || []).map((item) => `<span class="segment-chip">${escapeHtml(item)}</span>`).join("");
      const enrichment = word.enrichment || {};
      const reviewClass = enrichment.needsReview ? "needs-review" : "verified";
      const reviewText = enrichment.needsReview ? "待教师复核" : (enrichment.providers?.length ? "已在线核验" : "");
      return `<article class="understand-card${active ? " is-active" : ""}" data-word-id="${escapeHtml(word.id)}">
        <header class="understand-head">
          <h2 lang="en">${escapeHtml(word.word)}</h2>
          <div class="word-head-meta">
            <span>${escapeHtml(word.phonetic || "音标待补充")}</span>
            ${reviewText ? `<em class="enrichment-badge ${reviewClass}">${escapeHtml(reviewText)}</em>` : ""}
          </div>
        </header>
        <div class="meaning-line">${escapeHtml(word.part || "")} ${escapeHtml(word.meaning || "暂无释义")}</div>
        <div class="segment-strip">${segments}</div>
        <div class="understand-grid">
          <section><h3>谐音 / 画面记忆</h3><p>${escapeHtml(word.mnemonic || word.hook || "暂无助记")}</p></section>
          <section><h3>派生词</h3><ul class="pixel-list">${derivatives}</ul></section>
          <section class="phrase-section"><h3>延伸短语与对应例句</h3><ul class="phrase-example-list">${phrases}</ul></section>
          <section><h3>单词例句</h3><p>${escapeHtml(word.example || "暂无例句")}</p>${word.exampleTranslation ? `<small>${escapeHtml(word.exampleTranslation)}</small>` : ""}</section>
        </div>
      </article>`;
    }).join("");
  }

  function todayWords() {
    const all = session.state.words || [];
    const ids = new Set(session.state.newWordIds || []);
    const today = new Date().toISOString().slice(0, 10);
    const isToday = session.state.batchDate === today;
    return isToday && ids.size ? all.filter((word) => ids.has(word.id)) : visibleWords();
  }

  function taskTypeLabel(type) {
    return {
      "meaning-to-word": "看汉写英",
      "word-to-meaning": "看英写汉",
      "listen-to-word": "听音写词",
      "matching": "单词-汉译连线",
      "completion": "拼写补全",
      "cloze": "选词填空",
      "retry": "错词重测"
    }[type] || "默写任务";
  }

  function shuffle(items) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
    }
    return copy;
  }

  function ensureSpellSelection() {
    const words = todayWords();
    const valid = new Set(words.map((word) => word.id));
    session.selectedSpellIds = new Set([...session.selectedSpellIds].filter((id) => valid.has(id)));
    if (!session.selectedSpellIds.size && words.length) {
      words.forEach((word) => session.selectedSpellIds.add(word.id));
    }
  }

  function renderSpellBuilder() {
    const words = todayWords();
    ensureSpellSelection();
    dom.spellSelectedCount.textContent = `已选 ${session.selectedSpellIds.size} 个`;
    dom.spellWordChecklist.innerHTML = words.map((word) => `
      <label class="spell-check-row">
        <input type="checkbox" data-spell-word="${escapeHtml(word.id)}" ${session.selectedSpellIds.has(word.id) ? "checked" : ""}>
        <strong lang="en">${escapeHtml(word.word)}</strong>
        <small>${escapeHtml(word.meaning || "")}</small>
      </label>
    `).join("") || `<div class="empty-basket">当前没有可布置的单词。教师可以点击右上角“导入词库”，或在左侧加载历史词库。</div>`;
  }

  function setAllSpellSelection(checked) {
    session.selectedSpellIds = checked
      ? new Set(todayWords().map((word) => word.id))
      : new Set();
    renderSpellBuilder();
  }

  function invertSpellSelection() {
    const next = new Set();
    todayWords().forEach((word) => {
      if (!session.selectedSpellIds.has(word.id)) next.add(word.id);
    });
    session.selectedSpellIds = next;
    renderSpellBuilder();
  }

  function handleSpellCheckChange(event) {
    const checkbox = event.target.closest("[data-spell-word]");
    if (!checkbox) return;
    if (checkbox.checked) session.selectedSpellIds.add(checkbox.dataset.spellWord);
    else session.selectedSpellIds.delete(checkbox.dataset.spellWord);
    dom.spellSelectedCount.textContent = `已选 ${session.selectedSpellIds.size} 个`;
  }


  function formatSequenceNumber(number) {
    return String(Math.max(1, Number(number) || 1));
  }

  function createMaskedWord(value) {
    const chars = [...String(value || "")];
    if (chars.length <= 1) return { masked: "_", missing: chars.join("") };
    const candidates = [];
    for (let index = 0; index < chars.length; index += 1) {
      if (/[A-Za-z]/.test(chars[index])) candidates.push(index);
    }
    if (!candidates.length) return { masked: chars.join(""), missing: "" };
    const interior = candidates.filter((index) => index > 0 && index < chars.length - 1);
    const available = interior.length ? interior : candidates;
    const blankCount = Math.min(available.length, chars.length <= 8 ? 1 : chars.length <= 12 ? 2 : 3);
    const selected = shuffle(available).slice(0, blankCount).sort((a, b) => a - b);
    const selectedSet = new Set(selected);
    return {
      masked: chars.map((char, index) => selectedSet.has(index) ? "_" : char).join(""),
      missing: selected.map((index) => chars[index]).join("")
    };
  }  function buildSpellTaskData(type, words) {
    const source = type === "retry"
      ? words.filter((word) => !session.progress[word.id])
      : words;
    const usable = source.length ? source : words;
    let matching = [];
    let baseItems = [];

    if (type === "matching") {
      const rightOrder = shuffle(usable);
      const rightByWordId = new Map(rightOrder.map((word, index) => [word.id, {
        letter: String.fromCharCode(65 + index),
        meaning: word.meaning || ""
      }]));
      const leftOrder = shuffle(usable);
      matching = {
        left: leftOrder.map((word, index) => ({ roman: formatSequenceNumber(index + 1), wordId: word.id, word: word.word })),
        right: rightOrder.map((word, index) => ({ letter: String.fromCharCode(65 + index), wordId: word.id, meaning: word.meaning || "" }))
      };
      baseItems = leftOrder.map((word, index) => {
        const right = rightByWordId.get(word.id);
        return {
          id: `task-${index}-${word.id}`,
          wordId: word.id,
          type,
          prompt: word.word,
          subPrompt: "",
          answer: right?.letter || "",
          audioText: "",
          hint: "",
          roman: formatSequenceNumber(index + 1),
          leftWord: word.word,
          rightLetter: right?.letter || "",
          rightMeaning: right?.meaning || ""
        };
      });
      return { items: baseItems, matching };
    }

    baseItems = shuffle(usable.map((word, index) => {
      const first = word.word.slice(0, 1);
      const last = word.word.slice(-1);
      if (type === "word-to-meaning") {
        return { id: `task-${index}-${word.id}`, wordId: word.id, type, prompt: word.word, subPrompt: word.phonetic || "", answer: word.meaning || "", audioText: word.word, hint: "" };
      }
      if (type === "listen-to-word") {
        return { id: `task-${index}-${word.id}`, wordId: word.id, type, prompt: "听音写词", subPrompt: "点击喇叭播放发音，再填写英文单词。", answer: word.word, audioText: word.word, hint: "" };
      }
      if (type === "completion") {
        const maskedWord = createMaskedWord(word.word);
        return {
          id: `task-${index}-${word.id}`,
          wordId: word.id,
          type,
          prompt: maskedWord.masked,
          subPrompt: `${word.part ? `${word.part} ` : ""}${word.meaning || ""}`,
          answer: word.word,
          audioText: "",
          hint: "补全缺失字母后提交完整单词",
          maskedWord: maskedWord.masked,
          missingLetters: maskedWord.missing
        };
      }
      if (type === "cloze") {
        const phraseExample = (word.phraseExamples || []).find((item) => item.example);
        const example = (phraseExample && phraseExample.example) || word.example || word.meaning || "";
        const escaped = word.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const prompt = example ? example.replace(new RegExp(escaped, "i"), "_____") : word.meaning;
        return { id: `task-${index}-${word.id}`, wordId: word.id, type, prompt, subPrompt: "根据语境填写英文单词。", answer: word.word, audioText: "", hint: "" };
      }
      return { id: `task-${index}-${word.id}`, wordId: word.id, type: "meaning-to-word", prompt: word.meaning || "", subPrompt: "请写出对应的英文单词。", answer: word.word, audioText: "", hint: "" };
    }));
    return { items: baseItems, matching: [] };
  }

  async function generateSpellTask(publish) {
    ensureSpellSelection();
    const selected = todayWords().filter((word) => session.selectedSpellIds.has(word.id));
    if (!selected.length) {
      alert("请至少勾选一个今日单词。");
      return;
    }
    const type = dom.spellTaskType.value;
    let taskWords = selected;
    if (type === "matching" && selected.length > 26) {
      alert("单词-汉译连线一次最多支持 26 个单词，本次先使用前 26 个。");
      taskWords = selected.slice(0, 26);
    }
    const built = buildSpellTaskData(type, taskWords);
    const task = {
      id: `task-${Date.now()}`,
      type,
      title: `${taskTypeLabel(type)} · 乱序任务`,
      wordIds: taskWords.map((word) => word.id),
      items: built.items,
      matching: built.matching
    };
    if (!publish) {
      session.previewTask = task;
      renderSpellView();
      return;
    }
    session.previewTask = null;
    await performAction("publishSpellTask", { task });
  }

  function renderSpellView() {
    if (session.role === "teacher") renderSpellBuilder();
    const task = session.previewTask || session.state.spellTask;
    if (!task) {
      dom.spellTaskTitle.textContent = "等待教师发布";
      dom.spellTaskCount.textContent = "0 题";
      const emptyMessage = session.role === "teacher"
        ? "词库已经准备好。请先在上方勾选单词，点击“生成乱序任务”，确认顺序后点击“发布给学生”。"
        : "老师暂时还没有发布默写任务，你可以先进入读音浇灌或理解施肥继续学习。";
      dom.spellTaskList.innerHTML = `<div class="empty-basket actionable-empty">${emptyMessage}</div>`;
      dom.submitSpellTask.classList.toggle("is-hidden", session.role !== "student");
      dom.toggleTeacherAnswer.classList.add("is-hidden");
      dom.toggleStudentAnswer.classList.add("is-hidden");
      dom.answerKeyPanel.classList.add("is-hidden");
      dom.studentTaskResult.textContent = "等待教师发布任务";
      return;
    }
    dom.spellTaskTitle.textContent = task.title || taskTypeLabel(task.type);
    dom.spellTaskCount.textContent = `${task.items.length} 题`;
    dom.toggleTeacherAnswer.classList.remove("is-hidden");
    dom.toggleStudentAnswer.classList.remove("is-hidden");
    dom.toggleTeacherAnswer.textContent = session.teacherShowAnswer ? "隐藏标准答案" : "查看标准答案";
    dom.toggleStudentAnswer.textContent = session.state.showSpellAnswers ? "停止向学生展示答案" : "向学生展示答案";
    dom.submitSpellTask.classList.toggle("is-hidden", session.role !== "student");
    if (task.type === "matching" && task.matching) {
      renderMatchingTask(task);
    } else {
      renderStandardTask(task);
    }
    scheduleAudioPrefetch((task.items || []).map((item) => ({ word: item.audioText })).filter((item) => item.word));
    renderAnswerKeyPanel(task);
    renderStudentTaskResult();
  }

  function renderStandardTask(task) {
    dom.spellTaskList.innerHTML = task.items.map((item, index) => `
      <article class="spell-task-row${item.type === "completion" ? " completion-task-row" : ""}" data-task-id="${escapeHtml(item.id)}">
        <span class="task-number">${String(index + 1).padStart(2, "0")}</span>
        <div class="task-prompt">
          <strong class="${item.type === "completion" ? "masked-word" : ""}">${escapeHtml(item.prompt)}</strong>
          <small>${escapeHtml(item.subPrompt || "")} ${item.hint ? `· ${escapeHtml(item.hint)}` : ""}</small>
          ${item.audioText ? `<button class="pixel-button task-listening" data-task-audio="${escapeHtml(item.audioText)}" type="button">🔊 播放发音</button>` : ""}
        </div>
        <div class="task-answer">
          ${session.role === "student"
            ? `<input data-task-index="${index}" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${item.type === "completion" ? "填写完整单词" : "填写答案"}">`
            : `<span class="task-answer-key">${session.teacherShowAnswer ? escapeHtml(item.answer) : "答案已隐藏"}</span>`}
        </div>
      </article>
    `).join("");
  }

  function renderMatchingTask(task) {
    const left = Array.isArray(task.matching.left) ? task.matching.left : [];
    const right = Array.isArray(task.matching.right) ? task.matching.right : [];
    const answerRows = task.items.map((item, index) => {
      const value = session.role === "teacher" && session.teacherShowAnswer ? item.answer : "";
      return `<label class="matching-answer-row">
        <b>${escapeHtml(item.roman || formatSequenceNumber(index + 1))}.</b>
        <input data-task-index="${index}" type="text" maxlength="2" value="${escapeHtml(value)}" placeholder="_" ${session.role === "teacher" ? "disabled" : ""} autocomplete="off">
      </label>`;
    }).join("");
    dom.spellTaskList.innerHTML = `
      <div class="matching-board">
        <section class="matching-column matching-left">
          <h3>英文单词</h3>
          ${left.map((item) => `<div class="matching-item"><b>${escapeHtml(item.roman)}</b><strong>${escapeHtml(item.word)}</strong></div>`).join("")}
        </section>
        <section class="matching-column matching-right">
          <h3>中文释义（已打乱）</h3>
          ${right.map((item) => `<div class="matching-item"><b>${escapeHtml(item.letter)}</b><span>${escapeHtml(item.meaning)}</span></div>`).join("")}
        </section>
      </div>
      <div class="matching-answer-sheet">
        <h3>答题卡</h3>
        <div class="matching-answer-grid">${answerRows}</div>
      </div>
    `;
  }

  function renderAnswerKeyPanel(task) {
    const visible = session.teacherShowAnswer && session.role === "teacher";
    dom.answerKeyPanel.classList.toggle("is-hidden", !visible);
    if (!visible) return;
    if (task.type === "matching" && task.matching) {
      dom.answerKeyPanel.innerHTML = `<h3>连线标准答案</h3><ul class="answer-key-list">${task.items.map((item) => `<li><b>${escapeHtml(item.roman)} — ${escapeHtml(item.answer)}</b> ${escapeHtml(item.leftWord)} — ${escapeHtml(item.rightMeaning)}</li>`).join("")}</ul>`;
      return;
    }
    dom.answerKeyPanel.innerHTML = `<h3>标准答案</h3><ul class="answer-key-list">${task.items.map((item, index) => `<li><b>${index + 1}. ${escapeHtml(item.answer)}</b></li>`).join("")}</ul>`;
  }
  function updateHeaderStats() {
    const words = visibleWords();
    const index = Math.max(0, words.findIndex((word) => word.id === session.state.activeWordId));
    dom.wordPosition.textContent = `${words.length ? index + 1 : 0} / ${words.length}`;
    dom.studentCount.textContent = `${Object.keys(session.state.students || {}).length} 位学生在线`;
    dom.submissionCounter.textContent = `${Object.keys(session.state.students || {}).length} 份`;
  }

  async function selectDay(day) {
    if (session.role !== "teacher") return;
    const first = (session.state.words || []).find((word) => Number(word.day || 1) === day);
    if (!first) return;
    session.state.activeDay = day;
    session.state.activeWordId = first.id;
    await performAction("setDay", { day });
  }

  async function selectWord(wordId) {
    if (session.role !== "teacher") return;
    const word = (session.state.words || []).find((item) => item.id === wordId);
    if (word) scheduleAudioPrefetch([word]);
    await performAction("setWord", { wordId });
  }

  async function moveWord(delta) {
    const words = visibleWords();
    if (!words.length || session.role !== "teacher") return null;
    const index = words.findIndex((word) => word.id === session.state.activeWordId);
    const next = words[(index + delta + words.length) % words.length];
    if (!next) return null;
    session.state.activeWordId = next.id;
    renderAll();
    scheduleAudioPrefetch([next]);
    try {
      await sendAction("setWord", { wordId: next.id }, false);
    } catch (error) {
      console.warn("单词切换同步失败", error);
    }
    return next;
  }

  async function handleReadGridClick(event) {
    const speaker = event.target.closest("[data-speak-id]");
    if (speaker) {
      event.preventDefault();
      event.stopPropagation();
      const word = (session.state.words || []).find((item) => item.id === speaker.dataset.speakId);
      if (!word) return;
      speaker.classList.add("is-loading");
      speaker.disabled = true;
      speaker.textContent = "…";
      try {
        const started = await speakWord(word, { waitForEnd: false });
        speaker.dataset.lastResult = started ? "playing" : "failed";
      } catch (error) {
        speaker.dataset.lastResult = "failed";
      } finally {
        speaker.classList.remove("is-loading");
        speaker.disabled = false;
        speaker.textContent = "🔊";
      }
      return;
    }
    const tile = event.target.closest("[data-word-id]");
    if (tile && session.role === "teacher") selectWord(tile.dataset.wordId);
  }

  function wordAudioSource(text) {
    return location.protocol === "file:"
      ? `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`
      : `/api/audio?word=${encodeURIComponent(text)}`;
  }

  function cachedWordAudio(text) {
    const normalized = String(text || "").trim();
    const key = normalized.toLowerCase();
    if (!key) return null;
    let entry = session.audioCache.get(key);
    if (entry) return entry;
    const audio = new Audio(wordAudioSource(normalized));
    audio.preload = "auto";
    audio.volume = 1;
    audio.muted = false;
    audio.playsInline = true;
    entry = { audio, ready: false, failed: false };
    const markReady = () => {
      entry.ready = true;
      entry.failed = false;
    };
    audio.addEventListener("loadeddata", markReady, { once: true });
    audio.addEventListener("canplaythrough", markReady, { once: true });
    audio.addEventListener("error", () => {
      entry.ready = false;
      entry.failed = true;
    });
    session.audioCache.set(key, entry);
    audio.load();
    return entry;
  }

  function scheduleAudioPrefetch(words) {
    const unique = [];
    const seen = new Set();
    (words || []).forEach((item) => {
      const text = String(typeof item === "string" ? item : item?.word || "").trim();
      const key = text.toLowerCase();
      if (!text || seen.has(key)) return;
      seen.add(key);
      unique.push(text);
    });
    if (!unique.length) return;
    const activeText = String(currentWord()?.word || "").trim().toLowerCase();
    const activeIndex = unique.findIndex((text) => text.toLowerCase() === activeText);
    if (activeIndex > 0) unique.unshift(unique.splice(activeIndex, 1)[0]);
    if (session.audioPrefetchTimer) window.clearTimeout(session.audioPrefetchTimer);
    const runId = session.audioPrefetchRun + 1;
    session.audioPrefetchRun = runId;
    session.audioPrefetchTimer = window.setTimeout(() => {
      session.audioPrefetchTimer = null;
      warmAudioCache(unique, runId);
    }, 80);
  }

  function warmAudioCache(words, runId) {
    let index = 0;
    let active = 0;
    const pump = () => {
      if (runId !== session.audioPrefetchRun) return;
      while (active < 4 && index < words.length) {
        const entry = cachedWordAudio(words[index]);
        index += 1;
        if (!entry) continue;
        if (entry.ready) continue;
        active += 1;
        let done = false;
        const next = () => {
          if (done) return;
          done = true;
          active = Math.max(0, active - 1);
          pump();
        };
        entry.audio.addEventListener("canplaythrough", next, { once: true });
        entry.audio.addEventListener("error", next, { once: true });
        window.setTimeout(next, 4000);
      }
    };
    pump();
  }

  function playRemoteAudio(text, { waitForEnd = true, onStart } = {}) {
    return new Promise((resolve, reject) => {
      const entry = cachedWordAudio(text);
      if (!entry) {
        reject(new Error("单词无效"));
        return;
      }
      if (entry.failed) {
        entry.failed = false;
        entry.audio.src = wordAudioSource(text);
        entry.audio.load();
      }
      const audio = entry.audio;
      audio.preload = "auto";
      audio.volume = 1;
      audio.muted = false;
      audio.playsInline = true;
      session.activeAudio = audio;
      let started = false;
      let settled = false;
      let startTimer = null;
      const clearStartTimer = () => { if (startTimer) clearTimeout(startTimer); startTimer = null; };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearStartTimer();
        if (session.activeAudio === audio) session.activeAudio = null;
        reject(error);
      };
      const start = () => {
        if (started) return;
        started = true;
        entry.ready = true;
        entry.failed = false;
        clearStartTimer();
        if (typeof onStart === "function") onStart();
        if (!waitForEnd) {
          settled = true;
          resolve(true);
        }
      };
      audio.onplaying = start;
      audio.onended = () => {
        start();
        if (settled) return;
        settled = true;
        clearStartTimer();
        if (session.activeAudio === audio) session.activeAudio = null;
        resolve(true);
      };
      audio.onerror = () => {
        entry.ready = false;
        entry.failed = true;
        fail(new Error("音频播放失败"));
      };
      try { audio.currentTime = 0; } catch (error) { console.warn(error); }
      startTimer = setTimeout(() => fail(new Error("音频加载超时")), 2500);
      audio.play().catch(fail);
    });
  }

  function speechVoices() {
    if (!("speechSynthesis" in window)) return [];
    return window.speechSynthesis.getVoices().filter((voice) => /^en(-|_|$)/i.test(voice.lang));
  }

  function playBrowserSpeech(text, { waitForEnd = true, onStart } = {}) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        resolve(false);
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 0.8;
      const voices = speechVoices();
      if (voices.length) utterance.voice = voices.find((voice) => /US|United States/i.test(voice.name)) || voices[0];
      let settled = false;
      const finish = (ok = true) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      utterance.onstart = () => {
        if (typeof onStart === "function") onStart();
        if (!waitForEnd) finish(true);
      };
      utterance.onend = () => finish(true);
      utterance.onerror = () => finish(false);
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
      setTimeout(() => finish(true), waitForEnd ? 4500 : 1400);
    });
  }

  async function speakWord(word, options = {}) {
    const text = String(word?.word || "").trim();
    if (!text) return false;
    if (session.activeAudio) {
      session.activeAudio.pause();
      session.activeAudio = null;
    }
    const entry = cachedWordAudio(text);
    if (entry?.ready) {
      try {
        return await playRemoteAudio(text, options);
      } catch (error) {
        console.warn("缓存发音播放失败，改用浏览器语音", error);
      }
    }
    if ("speechSynthesis" in window) {
      const spoken = await playBrowserSpeech(text, options);
      if (spoken) return true;
    }
    try {
      return await playRemoteAudio(text, options);
    } catch (error) {
      console.warn("在线发音不可用", error);
      return false;
    }
  }

  async function runReadQueue() {
    while (session.readQueueRunning) {
      const word = currentWord();
      if (!word) break;
      await speakWord(word);
      if (!session.readQueueRunning) break;
      await delay(650);
      await moveWord(1);
      await delay(300);
    }
    if (session.readQueueRunning) stopReadQueue();
  }

  async function toggleReadQueue() {
    if (session.role !== "teacher") return;
    if (session.readQueueRunning) {
      stopReadQueue();
      return;
    }
    if (session.view !== "read") await requestModule("read");
    session.readQueueRunning = true;
    dom.readQueueButton.textContent = "■ 停止连续跟读";
    dom.readQueueButton.classList.remove("success");
    dom.readQueueButton.classList.add("danger");
    runReadQueue();
  }

  function stopReadQueue() {
    session.readQueueRunning = false;
    if (session.activeAudio) {
      session.activeAudio.pause();
      session.activeAudio = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (dom.readQueueButton) {
      dom.readQueueButton.textContent = "▶ 开始连续跟读";
      dom.readQueueButton.classList.add("success");
      dom.readQueueButton.classList.remove("danger");
    }
  }

  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function handleSpellTaskListClick(event) {
    const button = event.target.closest("[data-task-audio]");
    if (!button) return;
    speakWord({ word: button.dataset.taskAudio || "" });
  }

  async function submitSpellTask() {
    if (session.role !== "student") return;
    const task = session.state.spellTask;
    if (!task) return;
    const answers = [...dom.spellTaskList.querySelectorAll("[data-task-index]")]
      .sort((a, b) => Number(a.dataset.taskIndex) - Number(b.dataset.taskIndex))
      .map((input) => input.value.trim());
    if (!answers.some(Boolean)) {
      alert("请至少填写一个答案。");
      return;
    }
    dom.submitSpellTask.disabled = true;
    try {
      await sendAction("submitAnswer", { answers, answer: answers.join(" | ") }, false);
      dom.studentTaskResult.textContent = "已提交，等待老师验收……";
      dom.studentTaskResult.className = "student-result";
    } catch (error) {
      dom.studentTaskResult.textContent = "提交失败，请检查连接";
      dom.studentTaskResult.className = "student-result wrong";
    } finally {
      dom.submitSpellTask.disabled = false;
    }
  }

  function renderStudentTaskResult() {
    const student = (session.state.students || {})[session.clientId];
    if (session.role === "teacher") {
      dom.studentTaskResult.textContent = "学生提交后，整份答卷会进入右侧“收获框”。";
      dom.studentTaskResult.className = "student-result";
      return;
    }
    if (!student || !student.submittedAt) {
      dom.studentTaskResult.textContent = "尚未提交";
      dom.studentTaskResult.className = "student-result";
      return;
    }
    if (student.status === "pending" || student.status === "reviewing") {
      dom.studentTaskResult.textContent = "已提交，等待老师逐题验收……";
      dom.studentTaskResult.className = "student-result";
      return;
    }
    const task = session.state.spellTask;
    const results = student.itemResults || {};
    const details = task?.items?.map((item, index) => {
      const result = results[item.id];
      const mark = result === true ? "✓" : result === false ? "✕" : "…";
      const answer = session.state.showSpellAnswers ? ` · ${escapeHtml(item.answer)}` : "";
      return `<li class="${result === true ? "correct" : result === false ? "wrong" : ""}"><b>${index + 1}.</b> ${mark}${answer}</li>`;
    }).join("") || "";
    dom.studentTaskResult.innerHTML = `
      <strong>${student.correct ? "批改完成：整卷通过" : "批改完成：请订正错题"}</strong>
      ${student.feedback ? `<p>老师：${escapeHtml(student.feedback)}</p>` : ""}
      <ul class="student-grade-list">${details}</ul>
    `;
    dom.studentTaskResult.className = `student-result ${student.correct ? "correct" : "wrong"}`;
  }

  function renderSubmissions() {
    const students = Object.values(session.state.students || {});
    const visible = session.role === "teacher" ? students : students.filter((student) => student.clientId === session.clientId);
    if (!visible.length) {
      dom.studentSubmissions.innerHTML = `<div class="empty-basket">学生加入并提交后，答卷会出现在这里。</div>`;
      return;
    }
    const task = session.state.spellTask;
    dom.studentSubmissions.innerHTML = visible.map((student) => {
      const submitted = Boolean(student.submittedAt);
      const results = student.itemResults || {};
      const statusClass = student.status === "checked" ? (student.correct ? "status-correct" : "status-wrong") : "status-pending";
      const statusText = !submitted ? "未提交" : student.status === "checked" ? (student.correct ? "整卷正确" : "需要重写") : "待逐题验收";
      const items = task?.items || [];
      const rows = items.map((item, index) => {
        const value = student.answers?.[index] || "—";
        const result = results[item.id];
        return `<li class="grading-row">
          <span class="grading-number">${index + 1}</span>
          <b>${escapeHtml(value)}</b>
          ${session.role === "teacher" && submitted ? `<span class="grading-actions">
            <button class="${result === true ? "is-active" : ""}" type="button" data-grade-item="${escapeHtml(item.id)}" data-grade-student="${escapeHtml(student.clientId)}" data-grade-correct="true">✓</button>
            <button class="${result === false ? "is-active wrong" : ""}" type="button" data-grade-item="${escapeHtml(item.id)}" data-grade-student="${escapeHtml(student.clientId)}" data-grade-correct="false">✕</button>
          </span>` : `<span class="grading-mark ${result === true ? "correct" : result === false ? "wrong" : ""}">${result === true ? "✓" : result === false ? "✕" : "…"}</span>`}
        </li>`;
      }).join("");
      return `<article class="submission-card" data-student-id="${escapeHtml(student.clientId)}">
        <header><span>${escapeHtml(student.name || "学生")}</span><small class="${statusClass}">${statusText}</small></header>
        <ul class="submission-answer-list grading-list">${rows || `<li>${escapeHtml(student.answer || "—")}</li>`}</ul>
        ${session.role === "teacher" && submitted ? `<div class="feedback-actions">
          <button class="pixel-button success" type="button" data-publish-grades="${escapeHtml(student.clientId)}">发布批改结果</button>
        </div>` : ""}
      </article>`;
    }).join("");
  }

  async function handleFeedbackClick(event) {
    if (session.role !== "teacher") return;
    const gradeButton = event.target.closest("[data-grade-item]");
    if (gradeButton) {
      await sendAction("gradeItem", {
        studentId: gradeButton.dataset.gradeStudent,
        itemId: gradeButton.dataset.gradeItem,
        correct: gradeButton.dataset.gradeCorrect === "true"
      }, false);
      renderSubmissions();
      return;
    }
    const publishButton = event.target.closest("[data-publish-grades]");
    if (!publishButton) return;
    const feedback = window.prompt("可选反馈（留空即可）", "") || "";
    await sendAction("publishGrades", { studentId: publishButton.dataset.publishGrades, feedback }, false);
    renderSubmissions();
    renderStudentTaskResult();
  }

  async function copyInvite() {
    if (location.protocol === "file:") {
      alert("请先运行 server.py，再复制学生链接。");
      return;
    }
    const invite = `${location.origin}/#auto=1&role=student&room=${encodeURIComponent(session.room)}&name=学生&module=spell`;
    try {
      await navigator.clipboard.writeText(invite);
      dom.copyInviteButton.textContent = "已复制";
      setTimeout(() => { dom.copyInviteButton.textContent = "复制学生链接"; }, 1500);
    } catch (error) {
      window.prompt("请复制学生链接", invite);
    }
  }

  async function loadWordFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    let text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    if (text.includes("\uFFFD") || /[\u0080-\u00FF]{2,}/.test(text)) {
      try {
        const fallback = new TextDecoder("gb18030", { fatal: false }).decode(buffer);
        if (!fallback.includes("\uFFFD")) text = fallback;
      } catch (error) {
        console.warn("GB18030 解码不可用", error);
      }
    }
    dom.uploadText.value = text.replace(/^\uFEFF/, "");
    updateUploadPreview();
  }

  function updateUploadPreview() {
    try {
      const words = parseVocabularyText(dom.uploadText.value);
      dom.uploadPreview.textContent = words.length ? `已解析 ${words.length} 个单词` : "尚未解析";
    } catch (error) {
      dom.uploadPreview.textContent = `解析失败：${error.message}`;
    }
  }

  function splitList(value) {
    return String(value || "").split(/[;；]/).map((item) => item.trim()).filter(Boolean);
  }

  function parsePairs(value) {
    return splitList(value).map((item) => {
      const parts = item.split(/[=＝:：]/);
      return [parts[0].trim(), parts.slice(1).join(":").trim()];
    }).filter((item) => item[0]);
  }

  function cleanImportLine(value) {
    return String(value || "")
      .replace(/^\uFEFF/, "")
      .replace(/^[\s\uF0B7\u2022•·※\-–—]+/, "")
      .trim();
  }

  function parsePlainWordLine(line, day) {
    let cleaned = cleanImportLine(line);
    if (!cleaned || /^DAY\s*\d+/i.test(cleaned)) return null;
    cleaned = cleaned.replace(/^\d+\s*[.、):：\-]\s*/, "");
    const wordMatch = cleaned.match(/^([A-Za-z][A-Za-z'’\-]*)/);
    if (!wordMatch) return null;
    const word = wordMatch[1];
    let rest = cleaned.slice(wordMatch[0].length).trim();
    let phonetic = "";
    const phoneticMatch = rest.match(/^\/([^/]+)\/\s*/);
    if (phoneticMatch) {
      phonetic = `/${phoneticMatch[1]}/`;
      rest = rest.slice(phoneticMatch[0].length).trim();
    }
    let part = "";
    const posPattern = /^(?:\(|\（)?((?:n|v|adj|adv|prep|conj|pron|num|art|modal|interj)\.(?:\s*&\s*(?:n|v|adj|adv|prep|conj|pron|num|art|modal|interj)\.)?)(?:\)|\）)?\s*/i;
    const posMatch = rest.match(posPattern);
    if (posMatch) {
      part = posMatch[1].replace(/\s+/g, " ");
      rest = rest.slice(posMatch[0].length).trim();
    }
    return {
      day, word, phonetic, part,
      meaning: rest.replace(/^[-–—:：|]+\s*/, "").trim(),
      segments: [], mnemonic: "", derivatives: [], phrases: [],
      phraseExamples: [], example: "", exampleTranslation: ""
    };
  }

  function parseDerivativeLine(value) {
    return splitList(value).map((item) => {
      const text = cleanImportLine(item);
      const match = text.match(/^([A-Za-z][A-Za-z'’\-]*)\s+(.+)$/);
      return match ? [match[1].trim(), match[2].trim()] : [text, ""];
    }).filter((item) => item[0]);
  }

  function parsePhraseLine(value) {
    return splitList(value).map((item) => {
      const text = cleanImportLine(item).replace(/[…]+$/, "").trim();
      const match = text.match(/^(.+?)([\u4e00-\u9fff].*)$/);
      return match
        ? { phrase: match[1].replace(/[…]+$/, "").trim(), meaning: match[2].trim(), example: "", translation: "", source: "教师上传" }
        : { phrase: text, meaning: "", example: "", translation: "", source: "教师上传" };
    }).filter((item) => item.phrase);
  }

  function parseExampleLine(value) {
    const text = cleanImportLine(value);
    const match = text.match(/^(.+?)([\u4e00-\u9fff].*)$/);
    return match
      ? { example: match[1].trim(), translation: match[2].trim() }
      : { example: text, translation: "" };
  }

  function parseVocabularyText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    }

    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const words = [];
    let currentDay = 1;
    let currentWord = null;

    const commitCurrent = () => {
      if (!currentWord) return;
      if (!currentWord.phraseExamples?.length && currentWord.phrases?.length) {
        currentWord.phraseExamples = currentWord.phrases.map((phrase) => {
          const exampleRecord = currentWord.example && currentWord.example.toLowerCase().includes(phrase.toLowerCase())
            ? { example: currentWord.example, translation: currentWord.exampleTranslation || "", source: "教师上传" }
            : { example: "", translation: "", source: "教师上传" };
          return {
            phrase,
            meaning: "",
            example: exampleRecord.example,
            translation: exampleRecord.translation,
            source: exampleRecord.source
          };
        });
      }
      words.push(currentWord);
      currentWord = null;
    };

    lines.forEach((line) => {
      const dayMatch = line.match(/^DAY\s*(\d+)/i);
      if (dayMatch) {
        commitCurrent();
        currentDay = Number(dayMatch[1]) || currentDay;
        return;
      }

      const cleaned = cleanImportLine(line);
      const detailMatch = cleaned.match(/^(派生词|短语|例句)\s*[:：]\s*(.+)$/);
      if (detailMatch && currentWord) {
        const [, label, value] = detailMatch;
        if (label === "派生词") currentWord.derivatives = parseDerivativeLine(value);
        if (label === "短语") {
          const phraseItems = parsePhraseLine(value);
          currentWord.phrases = phraseItems.map((item) => item.phrase);
          currentWord.phraseExamples = phraseItems;
        }
        if (label === "例句") {
          const example = parseExampleLine(value);
          if (!currentWord.example) currentWord.example = example.example;
          if (!currentWord.exampleTranslation) currentWord.exampleTranslation = example.translation;
          (currentWord.phraseExamples || []).forEach((phraseItem, index) => {
            const exact = phraseItem.phrase && example.example.toLowerCase().includes(phraseItem.phrase.toLowerCase());
            const approximate = index === 0 && phraseItem.phrase && example.example.toLowerCase().includes(phraseItem.phrase.split(/\s+/)[0].replace(/e$/, "").toLowerCase());
            if (exact || approximate) {
              phraseItem.example = example.example;
              phraseItem.translation = example.translation;
            }
          });
        }
        return;
      }

      const parts = cleaned.includes("|")
        ? cleaned.split("|").map((item) => item.trim())
        : cleaned.split("\t").map((item) => item.trim());
      if (parts.length >= 5) {
        commitCurrent();
        words.push({
          day: Number(parts[0]) || currentDay,
          word: parts[1],
          phonetic: parts[2] || "",
          part: parts[3] || "",
          meaning: parts[4] || "",
          segments: String(parts[5] || "").split(/[，,\-\s]+/).map((item) => item.trim()).filter(Boolean),
          mnemonic: parts[6] || "",
          derivatives: parsePairs(parts[7] || ""),
          phrases: splitList(parts[8] || ""),
          phraseExamples: [],
          example: parts[9] || "",
          exampleTranslation: ""
        });
        return;
      }

      if (parts.length === 2 && /^[A-Za-z]/.test(parts[0])) {
        commitCurrent();
        words.push({
          day: currentDay,
          word: parts[0],
          phonetic: "", part: "", meaning: parts[1],
          segments: [], mnemonic: "", derivatives: [], phrases: [], phraseExamples: [],
          example: "", exampleTranslation: ""
        });
        return;
      }

      const parsed = parsePlainWordLine(cleaned, currentDay);
      if (parsed) {
        commitCurrent();
        currentWord = parsed;
      }
    });

    commitCurrent();
    if (!words.length) {
      throw new Error("未识别到单词，请确保每行至少包含“单词 + 词性/中文释义”");
    }
    return words;
  }

  async function enrichCurrentWordBank() {
    if (session.role !== "teacher" || !session.state) return;
    const token = session.enrichmentToken + 1;
    session.enrichmentToken = token;
    const originalText = dom.enrichCurrentWordsButton.textContent;
    const batchName = session.state.batchName || "智能补全词库";
    dom.enrichCurrentWordsButton.disabled = true;
    dom.enrichCurrentWordsButton.textContent = "智能补全中…";
    try {
      const enriched = await enrichVocabulary(session.state.words || [], true, (start, end, total) => {
        if (token === session.enrichmentToken) dom.enrichCurrentWordsButton.textContent = `智能补全 ${end}/${total}`;
      });
      if (token !== session.enrichmentToken || session.state?.batchName !== batchName) return;
      await sendAction("mergeEnrichment", { words: enriched, batchName }, false, { retries: 1 });
      if (token !== session.enrichmentToken) return;
      renderAll();
      dom.enrichCurrentWordsButton.textContent = "补全完成";
    } catch (error) {
      console.error(error);
      alert(`智能补全失败：${error.message}`);
      dom.enrichCurrentWordsButton.textContent = "补全失败，请重试";
    } finally {
      setTimeout(() => {
        if (token !== session.enrichmentToken) return;
        dom.enrichCurrentWordsButton.disabled = false;
        dom.enrichCurrentWordsButton.textContent = originalText;
      }, 1800);
    }
  }

  async function enrichVocabulary(words, force = false, onProgress = null) {
    if (!force && (!dom.autoEnrich || !dom.autoEnrich.checked)) return words;
    if (location.protocol === "file:") {
      dom.uploadPreview.textContent = "单机模式跳过联网补全，仍会导入基础词汇。";
      return words;
    }
    const enriched = [];
    const chunkSize = 6;
    for (let start = 0; start < words.length; start += chunkSize) {
      const chunk = words.slice(start, start + chunkSize);
      const end = Math.min(start + chunk.length, words.length);
      dom.uploadPreview.textContent = `正在联网补充 ${start + 1}–${end} / ${words.length}……`;
      if (typeof onProgress === "function") onProgress(start + 1, end, words.length);
      const result = await fetchJson("/api/enrich-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "teacher", clientId: session.clientId, words: chunk })
      }, 1);
      if (!Array.isArray(result.words)) throw new Error(result.error || "在线补全失败");
      enriched.push(...result.words);
    }
    const reviewCount = enriched.filter((word) => word.enrichment && word.enrichment.needsReview).length;
    dom.uploadPreview.textContent = `联网补全完成：${enriched.length} 个单词${reviewCount ? `，${reviewCount} 个待教师复核` : "，全部已核验"}`;
    return enriched;
  }

  async function enrichWordsInBackground(words, batchName, token, originalText) {
    try {
      const enriched = await enrichVocabulary(words, true, (start, end, total) => {
        if (token === session.enrichmentToken) dom.enrichCurrentWordsButton.textContent = `后台补全 ${end}/${total}`;
      });
      if (token !== session.enrichmentToken || session.state?.batchName !== batchName) return;
      await sendAction("mergeEnrichment", { words: enriched, batchName }, false, { retries: 1 });
      if (token !== session.enrichmentToken) return;
      renderAll();
      dom.enrichCurrentWordsButton.textContent = "智能补全完成";
    } catch (error) {
      console.warn("后台智能补全失败", error);
      if (token === session.enrichmentToken) dom.enrichCurrentWordsButton.textContent = "补全失败，可重试";
    } finally {
      if (token === session.enrichmentToken) {
        dom.enrichCurrentWordsButton.disabled = false;
        setTimeout(() => {
          if (token === session.enrichmentToken) dom.enrichCurrentWordsButton.textContent = originalText;
        }, 2200);
      }
    }
  }

  async function confirmUpload() {
    if (!dom.confirmUpload) return;
    dom.confirmUpload.disabled = true;
    try {
      const words = parseVocabularyText(dom.uploadText.value);
      if (!words.length) throw new Error("没有可导入的单词");
      const batchName = `今日词库 ${new Date().toLocaleDateString("zh-CN")}`;
      const shouldEnrich = !session.offline && location.protocol !== "file:" && Boolean(dom.autoEnrich?.checked);
      const token = session.enrichmentToken + 1;
      session.enrichmentToken = token;
      const originalText = "智能补全当前词库";
      await sendAction("replaceWords", { words, batchName }, false, { retries: 1 });
      dom.uploadDialog.close();
      renderAll();
      if (shouldEnrich) {
        dom.enrichCurrentWordsButton.disabled = true;
        dom.enrichCurrentWordsButton.textContent = "后台补全中…";
        void enrichWordsInBackground(words, batchName, token, originalText);
      } else {
        dom.enrichCurrentWordsButton.disabled = false;
        dom.enrichCurrentWordsButton.textContent = originalText;
      }
    } catch (error) {
      alert(`导入失败：${error.message}`);
    } finally {
      dom.confirmUpload.disabled = false;
    }
  }

  function annotationKey() {
    if (!session.state) return "global";
    if (session.view === "read") return `read:day:${session.state.activeDay || 1}`;
    if (session.view === "understand") return `understand:word:${session.state.activeWordId || "none"}`;
    if (session.view === "spell") return `spell:word:${session.state.activeWordId || "none"}`;
    return "home";
  }

  function handleToolClick(event) {
    const button = event.target.closest("[data-tool]");
    if (!button) return;
    session.activeTool = session.activeTool === button.dataset.tool ? "pointer" : button.dataset.tool;
    document.querySelectorAll("[data-tool]").forEach((item) => item.classList.toggle("is-active", item.dataset.tool === session.activeTool));
    updateCanvasMode();
  }

  function handleColorClick(event) {
    const button = event.target.closest("[data-color]");
    if (!button) return;
    session.activeColor = button.dataset.color;
    document.querySelectorAll("[data-color]").forEach((item) => item.classList.toggle("is-active", item === button));
  }

  function updateCanvasMode() {
    const active = session.joined && session.role === "teacher" && session.view !== "home" && session.activeTool !== "pointer";
    dom.pageAnnotationCanvas.classList.toggle("is-drawing", active);
    document.body.classList.toggle("paper-overlay", active);
    if (!active) session.currentStroke = null;
  }

  function resizeCanvas() {
    const canvas = dom.pageAnnotationCanvas;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawCanvas();
  }

  function redrawCanvas(previewStroke) {
    const canvas = dom.pageAnnotationCanvas;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const all = [...((session.state?.strokes || {})[annotationKey()] || [])];
    if (previewStroke) all.push(previewStroke);
    all.forEach((stroke) => drawStroke(ctx, stroke));
  }

  function drawStroke(ctx, stroke) {
    if (!stroke.points || stroke.points.length < 2) return;
    ctx.save();
    ctx.lineCap = stroke.mode === "highlighter" ? "butt" : "round";
    ctx.lineJoin = stroke.mode === "highlighter" ? "bevel" : "round";
    ctx.globalAlpha = stroke.mode === "highlighter" ? 0.32 : 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color || "#b83b35";
    ctx.lineWidth = stroke.mode === "highlighter" ? 22 : Number(stroke.width || 3);
    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * window.innerWidth;
      const y = point.y * window.innerHeight;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  function canvasPoint(event) {
    return {
      x: Math.max(0, Math.min(1, event.clientX / window.innerWidth)),
      y: Math.max(0, Math.min(1, event.clientY / window.innerHeight))
    };
  }

  function startStroke(event) {
    if (!dom.pageAnnotationCanvas.classList.contains("is-drawing")) return;
    event.preventDefault();
    dom.pageAnnotationCanvas.setPointerCapture(event.pointerId);
    if (session.activeTool === "eraser") {
      session.erasing = true;
      session.erasedStrokeIds = new Set();
      eraseAt(event);
      return;
    }
    session.currentStroke = {
      id: `stroke-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      mode: session.activeTool,
      color: session.activeColor,
      width: session.activeTool === "highlighter" ? 22 : 3,
      points: [canvasPoint(event)]
    };
  }

  function extendStroke(event) {
    if (session.erasing) {
      event.preventDefault();
      eraseAt(event);
      return;
    }
    if (!session.currentStroke) return;
    event.preventDefault();
    session.currentStroke.points.push(canvasPoint(event));
    redrawCanvas(session.currentStroke);
  }

  async function finishStroke(event) {
    if (session.erasing) {
      session.erasing = false;
      const strokeIds = [...session.erasedStrokeIds];
      session.erasedStrokeIds = new Set();
      if (strokeIds.length) {
        await performAction("eraseStrokes", { strokeKey: annotationKey(), strokeIds });
      }
      return;
    }
    if (!session.currentStroke) return;
    event.preventDefault();
    const stroke = session.currentStroke;
    session.currentStroke = null;
    if (stroke.points.length < 2) return;
    await performAction("addStroke", { stroke, strokeKey: annotationKey() });
  }

  function eraseAt(event) {
    const point = canvasPoint(event);
    const key = annotationKey();
    const strokes = (session.state?.strokes || {})[key] || [];
    const radius = 0.025;
    const survivors = strokes.filter((stroke) => {
      const hit = (stroke.points || []).some((candidate) => {
        const dx = candidate.x - point.x;
        const dy = candidate.y - point.y;
        return Math.sqrt(dx * dx + dy * dy) < radius;
      });
      if (hit) session.erasedStrokeIds.add(String(stroke.id));
      return !hit;
    });
    if (session.state && session.state.strokes) session.state.strokes[key] = survivors;
    redrawCanvas();
  }

  async function clearStrokes() {
    if (session.role !== "teacher") return;
    const key = annotationKey();
    if (session.state?.strokes) session.state.strokes[key] = [];
    redrawCanvas();
    await performAction("clearStrokes", { strokeKey: key });
  }

  async function init() {
    cacheDom();
    bindEvents();
    applySavedCover();

    try {
      await preloadApplicationResources();
    } catch (error) {
      console.error("静态资源预加载失败，继续进入页面", error);
      updateBootProgress(2, 2, "资源");
    }

    const params = new URLSearchParams(location.search);
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
    const getParam = (key) => params.get(key) || hashParams.get(key);
    if (getParam("room")) dom.roomInput.value = getParam("room").toUpperCase();
    if (getParam("role") === "student") {
      session.role = "student";
      document.querySelectorAll(".role-card").forEach((item) => item.classList.toggle("is-active", item.dataset.role === "student"));
      dom.nameInput.value = getParam("name") || "学生";
    } else if (getParam("name")) {
      dom.nameInput.value = getParam("name");
    }
    session.pendingModule = getParam("module") || "read";
    resizeCanvas();
    document.body.classList.remove("resources-loading");
    document.body.classList.add("app-ready");
    if (getParam("auto") === "1") setTimeout(joinClassroom, 0);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
































































