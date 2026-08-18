/* =========================================================
   WordCheck — script.js
   Простая архитектура с состояниями: DICTIONARIES, HOME (= внутри
   выбранного словаря), TEST, RESULT.
   ========================================================= */

(function () {
  "use strict";

  // ---------- Состояние приложения ----------
  let currentScreen = "dictionaries";
  let sessionWords = [];      // [{ id, word }] перемешанный список слов текущей сессии
  let currentIndex = 0;       // индекс текущего слова
  let answers = [];           // [{ wordId, word, answer }]
  let testInProgress = false; // флаг незавершённой проверки (для подтверждения выхода)

  let currentDictionaryId = null;
  let currentDictionaryName = "";
  let lastTestWords = [];     // сохраняем набор слов для "Пройти снова"

  // Отвечает UI-значению ответа ("known"/"maybe"/"unknown") результат в БД
  // (в схеме БД второй вариант называется "probably_known").
  const DB_RESULT_MAP = { known: "known", maybe: "probably_known", unknown: "unknown" };

  // ---------- DOM-элементы ----------
  const screens = {
    dictionaries: document.getElementById("screen-dictionaries"),
    home: document.getElementById("screen-home"),
    test: document.getElementById("screen-test"),
    result: document.getElementById("screen-result"),
  };

  const btnBack = document.getElementById("btn-back");
  const testHeaderDictionaryNameEl = document.getElementById("test-header-dictionary-name");

  const progressCountEl = document.getElementById("progress-count");
  const progressTrackEl = document.getElementById("progress-track");
  const progressFillEl = document.getElementById("progress-fill");
  const wordCardEl = document.getElementById("word-card");
  const wordTextEl = document.getElementById("word-text");
  const answerButtons = document.querySelectorAll(".answer-btn");

  const resultPercentEl = document.getElementById("result-percent");
  const resultCaptionEl = document.getElementById("result-caption");
  const statTotalEl = document.getElementById("stat-total");

  const btnRestart = document.getElementById("btn-restart");
  const btnHome = document.getElementById("btn-home");

  const modal = document.getElementById("confirm-modal");
  const modalBackdrop = document.getElementById("modal-backdrop");
  const modalCancel = document.getElementById("modal-cancel");
  const modalConfirm = document.getElementById("modal-confirm");

  // ---------- Утилиты ----------

  // Перемешивание массива (алгоритм Фишера — Йетса)
  function shuffle(array) {
    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      const isActive = key === name;
      el.hidden = !isActive;
      el.setAttribute("aria-hidden", String(!isActive));
    });
    currentScreen = name;
  }

  // ---------- Логика проверки ----------
  // words: [{ id, word }] — слова конкретного словаря, полученные из БД.
  function startTest(words, dictionaryId, dictionaryName) {
    if (!Array.isArray(words) || words.length === 0) return;

    currentDictionaryId = dictionaryId;
    currentDictionaryName = dictionaryName || "";
    lastTestWords = words;

    sessionWords = shuffle(words);
    currentIndex = 0;
    answers = [];
    testInProgress = true;

    testHeaderDictionaryNameEl.textContent = currentDictionaryName || "WordCheck";

    showScreen("test");
    renderCurrentWord();
  }

  function renderCurrentWord() {
    const total = sessionWords.length;
    const position = currentIndex + 1;

    // Счётчик и progress bar
    progressCountEl.textContent = `${position} / ${total}`;
    const percent = Math.round((position / total) * 100);
    progressFillEl.style.width = `${percent}%`;
    progressTrackEl.setAttribute("aria-valuenow", String(percent));
    progressTrackEl.setAttribute("aria-valuemax", "100");

    // Слово
    wordTextEl.textContent = sessionWords[currentIndex].word;

    // Небольшая анимация смены слова
    wordCardEl.classList.remove("is-entering");
    // Форсируем reflow, чтобы анимация перезапустилась
    void wordCardEl.offsetWidth;
    wordCardEl.classList.add("is-entering");
  }

  function handleAnswer(answerType) {
    const current = sessionWords[currentIndex];
    answers.push({ wordId: current.id, word: current.word, answer: answerType });

    // Запись результата в БД — не блокирует переход к следующему слову;
    // ошибка записи не должна ломать сам процесс проверки.
    if (window.wordCheckDB && currentDictionaryId) {
      window.wordCheckDB
        .recordTestResult(currentDictionaryId, current.id, DB_RESULT_MAP[answerType])
        .catch((err) => console.error("Не удалось сохранить результат теста:", err));
    }

    if (currentIndex < sessionWords.length - 1) {
      currentIndex += 1;
      renderCurrentWord();
    } else {
      finishTest();
    }
  }

  function finishTest() {
    testInProgress = false;
    showResults();
  }

  function showResults() {
    const total = answers.length;
    const knownCount = answers.filter((a) => a.answer === "known").length;
    const maybeCount = answers.filter((a) => a.answer === "maybe").length;
    const unknownCount = answers.filter((a) => a.answer === "unknown").length;

    const knownPercent = total > 0 ? Math.round((knownCount / total) * 100) : 0;
    const maybePercent = total > 0 ? Math.round((maybeCount / total) * 100) : 0;
    const unknownPercent = total > 0 ? Math.round((unknownCount / total) * 100) : 0;

    resultPercentEl.textContent = `${knownPercent}%`;
    resultCaptionEl.textContent = "слов ты знаешь";
    statTotalEl.textContent = String(total);

    document.getElementById("stat-known-count").textContent = String(knownCount);
    document.getElementById("stat-maybe-count").textContent = String(maybeCount);
    document.getElementById("stat-unknown-count").textContent = String(unknownCount);

    document.getElementById("stat-known-percent").textContent = `${knownPercent}%`;
    document.getElementById("stat-maybe-percent").textContent = `${maybePercent}%`;
    document.getElementById("stat-unknown-percent").textContent = `${unknownPercent}%`;

    showScreen("result");

    // Анимация заполнения полос запускается после отрисовки экрана
    requestAnimationFrame(() => {
      document.getElementById("bar-known").style.width = `${knownPercent}%`;
      document.getElementById("bar-maybe").style.width = `${maybePercent}%`;
      document.getElementById("bar-unknown").style.width = `${unknownPercent}%`;
    });

    resultPercentEl.classList.remove("is-counting");
    void resultPercentEl.offsetWidth;
    resultPercentEl.classList.add("is-counting");
  }

  function restartTest() {
    // Сбросить полосы прогресса перед новым запуском, чтобы анимация была видна заново
    document.getElementById("bar-known").style.width = "0%";
    document.getElementById("bar-maybe").style.width = "0%";
    document.getElementById("bar-unknown").style.width = "0%";
    startTest(lastTestWords, currentDictionaryId, currentDictionaryName);
  }

  function goHome() {
    testInProgress = false;
    showScreen("home"); // "home" = меню текущего словаря, не общий главный экран
  }

  // ---------- Модальное подтверждение выхода ----------

  function openConfirmModal() {
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    modalCancel.focus();
  }

  function closeConfirmModal() {
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  function handleBackFromTest() {
    if (testInProgress) {
      openConfirmModal();
    } else {
      goHome();
    }
  }

  // ---------- Инициализация ----------

  function init() {
    btnBack.addEventListener("click", handleBackFromTest);

    answerButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.classList.add("is-pressed");
        setTimeout(() => btn.classList.remove("is-pressed"), 150);
        handleAnswer(btn.dataset.answer);
      });
    });

    btnRestart.addEventListener("click", restartTest);
    btnHome.addEventListener("click", goHome);

    modalCancel.addEventListener("click", closeConfirmModal);
    modalBackdrop.addEventListener("click", closeConfirmModal);
    modalConfirm.addEventListener("click", () => {
      closeConfirmModal();
      goHome();
    });

    // Клавиатурная доступность: Escape закрывает модалку
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) {
        closeConfirmModal();
      }
      // Быстрые ответы с клавиатуры во время проверки: 1 / 2 / 3
      if (currentScreen === "test" && modal.hidden) {
        if (e.key === "1") handleAnswer("known");
        if (e.key === "2") handleAnswer("maybe");
        if (e.key === "3") handleAnswer("unknown");
      }
    });

    showScreen("dictionaries");
  }

  document.addEventListener("DOMContentLoaded", init);

  // Публичный хук для внешних модулей (setup.js):
  // - startTest(words, dictionaryId, dictionaryName) — запускает проверку;
  // - showScreen(name) — верхнеуровневая навигация между "dictionaries" и "home",
  //   которой управляет setup.js при входе/выходе из конкретного словаря.
  window.WordCheckApp = {
    startTest: function (words, dictionaryId, dictionaryName) {
      startTest(words, dictionaryId, dictionaryName);
    },
    showScreen: function (name) {
      showScreen(name);
    },
  };
})();
