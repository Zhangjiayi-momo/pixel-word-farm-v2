(function () {
  "use strict";
  const state = { data: null, activeBankId: "", view: "read", query: "" };
  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function currentBank() {
    if (!state.data) return null;
    return state.data.banks?.find((bank) => bank.id === state.activeBankId) || state.data.banks?.[0] || null;
  }

  function visibleWords() {
    const words = currentBank()?.words || [];
    const query = state.query.trim().toLowerCase();
    if (!query) return words;
    return words.filter((word) => `${word.word || ""} ${word.meaning || ""} ${word.part || ""}`.toLowerCase().includes(query));
  }

  function formatUpdated(value) {
    if (!value) return "词库已发布";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? `更新于 ${value}` : `更新于 ${date.toLocaleString("zh-CN", { hour12: false })}`;
  }

  function playWord(text) {
    if (!text) return;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 0.8;
      window.speechSynthesis.speak(utterance);
      return;
    }
    const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`);
    audio.play().catch(() => {});
  }

  function renderDayTabs() {
    const banks = state.data?.banks || [];
    $("dayTabs").innerHTML = banks.map((bank) => `<button type="button" class="${bank.id === state.activeBankId ? "is-active" : ""}" data-bank-id="${escapeHtml(bank.id)}">${escapeHtml(bank.label || bank.id)}</button>`).join("");
  }

  function renderRead() {
    const words = visibleWords();
    $("studentWordGrid").innerHTML = words.map((word) => `
      <article class="student-word-card">
        <strong>${escapeHtml(word.word)}</strong>
        <small>${escapeHtml(word.phonetic || "点击喇叭听发音")}</small>
        <p>${escapeHtml(word.part || "")} ${escapeHtml(word.meaning || "")}</p>
        <button class="student-speaker" type="button" data-speak="${escapeHtml(word.word)}" aria-label="播放 ${escapeHtml(word.word)}">🔊</button>
      </article>
    `).join("");
  }

  function renderUnderstand() {
    const words = visibleWords();
    $("studentUnderstandingList").innerHTML = words.map((word) => {
      const derivatives = (word.derivatives || []).map((item) => {
        const name = Array.isArray(item) ? item[0] : item;
        const meaning = Array.isArray(item) ? item[1] : "";
        return `<li><b>${escapeHtml(name)}</b><span>${escapeHtml(meaning || "")}</span></li>`;
      }).join("") || "<li><span>暂无派生词</span></li>";
      const phraseItems = Array.isArray(word.phraseExamples) ? word.phraseExamples : [];
      const phrases = phraseItems.length
        ? phraseItems.map((item) => `<div class="student-phrase"><strong>${escapeHtml(item.phrase)}</strong><span>${escapeHtml(item.meaning || "")}</span><p>${escapeHtml(item.example || "待补充例句")}</p>${item.translation ? `<small>${escapeHtml(item.translation)}</small>` : ""}</div>`).join("")
        : (word.phrases || []).map((item) => `<div class="student-phrase"><strong>${escapeHtml(item)}</strong></div>`).join("") || "<p>暂无延伸短语</p>";
      return `<article class="student-understand-card">
        <header class="student-understand-head"><h2>${escapeHtml(word.word)}</h2><span>${escapeHtml(word.phonetic || "")}</span></header>
        <div class="student-meaning">${escapeHtml(word.part || "")} ${escapeHtml(word.meaning || "")}</div>
        <div class="student-grid">
          <section><h3>谐音 / 画面记忆</h3><p>${escapeHtml(word.mnemonic || word.hook || "暂无助记")}</p></section>
          <section><h3>派生词</h3><ul class="student-list">${derivatives}</ul></section>
          <section><h3>延伸短语与例句</h3>${phrases}</section>
          <section><h3>单词例句</h3><p>${escapeHtml(word.example || "暂无例句")}</p>${word.exampleTranslation ? `<span>${escapeHtml(word.exampleTranslation)}</span>` : ""}</section>
        </div>
      </article>`;
    }).join("");
  }

  function render() {
    const empty = $("studentEmpty");
    const hasData = Boolean(currentBank()?.words?.length);
    empty.classList.toggle("is-hidden", hasData);
    if (!hasData) {
      $("studentWordGrid").innerHTML = "";
      $("studentUnderstandingList").innerHTML = "";
      empty.textContent = "老师还没有发布学生版词库，请稍后再打开。";
      return;
    }
    $("readView").classList.toggle("is-hidden", state.view !== "read");
    $("understandView").classList.toggle("is-hidden", state.view !== "understand");
    renderDayTabs();
    renderRead();
    renderUnderstand();
  }

  document.addEventListener("click", (event) => {
    const speaker = event.target.closest("[data-speak]");
    if (speaker) {
      event.preventDefault();
      playWord(speaker.dataset.speak);
      return;
    }
    const bankButton = event.target.closest("[data-bank-id]");
    if (bankButton) {
      state.activeBankId = bankButton.dataset.bankId;
      render();
      return;
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      state.view = viewButton.dataset.view;
      document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button === viewButton));
      render();
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id !== "studentSearch") return;
    state.query = event.target.value;
    render();
  });

  fetch(`student-data.json?ts=${Date.now()}`, { cache: "no-store" })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("尚未发布")))
    .then((data) => {
      state.data = data;
      state.activeBankId = data.activeBankId || data.banks?.[0]?.id || "";
      $("studentUpdated").textContent = formatUpdated(data.updatedAt);
      render();
    })
    .catch(() => {
      $("studentUpdated").textContent = "尚未发布";
      render();
    });
})();