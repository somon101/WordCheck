/* =========================================================
   WordCheck — setup.js
   Мультисловарная архитектура: главный экран со списком словарей
   (языковых блоков), внутри каждого — создание/список/тестирование.

   Все данные — через window.wordCheckDB (IPC-мост к SQLite в главном
   процессе Electron, см. electron/db.js и electron/preload.js).
   Ничего не хранится в JS-переменных как единственном источнике данных —
   они лишь кеш текущего экрана, каждая мутация уходит в БД.
   ========================================================= */

(function () {
  "use strict";

  // ============================================================
  // Ссылки на элементы
  // ============================================================

  const dictionariesGridEl = document.getElementById("dictionaries-grid");
  const dictionariesCountLabelEl = document.getElementById("dictionaries-count-label");
  const dictionariesEmptyStateEl = document.getElementById("dictionaries-empty-state");
  const btnCreateDictionary = document.getElementById("btn-create-dictionary");

  const screenHome = document.getElementById("screen-home");
  const viewChoice = document.getElementById("setup-view-choice");
  const viewQuickCreate = document.getElementById("setup-view-quick-create");
  const viewList = document.getElementById("setup-view-list");

  const dictionaryBackBtn = document.getElementById("dictionary-back-btn");
  const dictionaryDetailTitleEl = document.getElementById("dictionary-detail-title");
  const dictionaryDetailLangsEl = document.getElementById("dictionary-detail-langs");

  const optionCreate = document.getElementById("setup-option-create");
  const optionList = document.getElementById("setup-option-list");
  const optionStartTest = document.getElementById("setup-option-start-test");
  const backFromQuickCreate = document.getElementById("setup-quick-back-choice");
  const backFromList = document.getElementById("setup-list-back");

  // ============================================================
  // Состояние (кеш текущего экрана; источник истины — БД)
  // ============================================================

  let currentDictionary = null; // { id, name, source_language, target_language }
  let words = [];               // слова текущего словаря: [{id, word, translation, ...}]

  let editingWordId = null;
  let deletingWordId = null;
  let deletingDictionaryId = null;

  let openDropdownId = null;
  let openDropdownEl = null;
  let openCardEl = null;
  let exportMenuOpen = false;

  let quickSessionStartLen = 0;
  let quickIndex = 0;

  // ============================================================
  // Общие утилиты (флаги языков, dropdown-меню, скачивание файла)
  // ============================================================

  const LANGUAGE_FLAGS = {
    "english": "🇬🇧", "английский": "🇬🇧",
    "russian": "🇷🇺", "русский": "🇷🇺",
    "chinese": "🇨🇳", "китайский": "🇨🇳",
    "german": "🇩🇪", "немецкий": "🇩🇪",
    "japanese": "🇯🇵", "японский": "🇯🇵",
    "french": "🇫🇷", "французский": "🇫🇷",
    "spanish": "🇪🇸", "испанский": "🇪🇸",
    "italian": "🇮🇹", "итальянский": "🇮🇹",
    "tajik": "🇹🇯", "таджикский": "🇹🇯",
    "korean": "🇰🇷", "корейский": "🇰🇷",
    "arabic": "🇸🇦", "арабский": "🇸🇦",
    "turkish": "🇹🇷", "турецкий": "🇹🇷",
    "portuguese": "🇵🇹", "португальский": "🇵🇹",
    "polish": "🇵🇱", "польский": "🇵🇱",
    "ukrainian": "🇺🇦", "украинский": "🇺🇦",
    "uzbek": "🇺🇿", "узбекский": "🇺🇿",
    "kazakh": "🇰🇿", "казахский": "🇰🇿",
    "hindi": "🇮🇳", "хинди": "🇮🇳",
  };

  function flagForLanguage(name) {
    const key = String(name || "").trim().toLowerCase();
    return LANGUAGE_FLAGS[key] || "🌐";
  }

  function positionDropdown(dropdown, anchorBtn, width) {
    const rect = anchorBtn.getBoundingClientRect();
    const dropdownWidth = width || 150;
    let left = rect.right - dropdownWidth;
    left = Math.max(8, Math.min(left, window.innerWidth - dropdownWidth - 8));
    const top = rect.bottom + 6;
    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${top}px`;
  }

  // Причина, по которой меню переносится в document.body на время показа:
  // .word-card-item — это .glass-card с backdrop-filter, который в этом
  // браузере одновременно (а) создаёт свой stacking context — следующая
  // карточка красится поверх предыдущей вместе с её меню, и (б) становится
  // containing block для position:fixed внутри себя, из-за чего "fixed"
  // координаты считались бы не от вьюпорта, а от самой карточки. Перенос в
  // body — единственный способ убрать оба эффекта разом.
  function closeOpenDropdown() {
    if (openDropdownEl) {
      openDropdownEl.hidden = true;
      if (openDropdownEl.parentNode) openDropdownEl.parentNode.removeChild(openDropdownEl);
    }
    if (openCardEl) openCardEl.classList.remove("menu-open");
    openDropdownId = null;
    openDropdownEl = null;
    openCardEl = null;
  }

  function closeExportMenu() {
    if (!exportMenuOpen) return;
    exportDropdown.hidden = true;
    if (exportDropdown.parentNode) exportDropdown.parentNode.removeChild(exportDropdown);
    exportMenuOpen = false;
  }

  document.addEventListener("click", (e) => {
    if (
      openDropdownId !== null &&
      !e.target.closest(".word-card-item__menu-wrap") &&
      !e.target.closest(".word-card-item__dropdown")
    ) {
      closeOpenDropdown();
    }
    if (exportMenuOpen && e.target.id !== "btn-panel-export" && !e.target.closest("#export-dropdown")) {
      closeExportMenu();
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      closeOpenDropdown();
      closeExportMenu();
    },
    true
  );

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function safeFilename(name) {
    const safe = String(name || "")
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "");
    return safe || "wordcheck";
  }

  // Небольшая обёртка: не даём ошибке похода в БД уронить приложение,
  // показываем понятное сообщение в переданный элемент вместо этого.
  async function withErrorMessage(promise, errorEl, fallbackMessage) {
    try {
      return { ok: true, value: await promise };
    } catch (err) {
      console.error(fallbackMessage, err);
      if (errorEl) {
        errorEl.textContent = fallbackMessage;
        errorEl.hidden = false;
      }
      return { ok: false, value: null };
    }
  }

  // ============================================================
  // Экран "Мои словари"
  // ============================================================

  async function renderDictionariesList() {
    closeOpenDropdown();
    const result = await withErrorMessage(
      window.wordCheckDB.listDictionaries(),
      null,
      "Не удалось загрузить список словарей."
    );
    const dictionaries = result.ok ? result.value : [];

    dictionariesGridEl.innerHTML = "";
    dictionariesCountLabelEl.textContent = `Словарей: ${dictionaries.length}`;

    if (dictionaries.length === 0) {
      dictionariesEmptyStateEl.hidden = false;
    } else {
      dictionariesEmptyStateEl.hidden = true;
      const fragment = document.createDocumentFragment();
      dictionaries.forEach((dict) => fragment.appendChild(buildDictionaryCard(dict)));
      dictionariesGridEl.appendChild(fragment);
    }
  }

  function buildDictionaryCard(dict) {
    const item = document.createElement("div");
    item.className = "glass-card word-card-item dictionary-card";
    item.dataset.dictionaryId = String(dict.id);

    const menuWrap = document.createElement("div");
    menuWrap.className = "word-card-item__menu-wrap";

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "word-card-item__menu-btn";
    menuBtn.setAttribute("aria-label", "Действия со словарём");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.textContent = "⋮";

    const dropdown = document.createElement("div");
    dropdown.className = "word-card-item__dropdown";
    dropdown.hidden = true;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Удалить словарь";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeOpenDropdown();
      openDictionaryDeleteModal(dict);
    });
    dropdown.appendChild(deleteBtn);

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = openDropdownId === dict.id;
      closeOpenDropdown();
      if (!isOpen) {
        document.body.appendChild(dropdown);
        positionDropdown(dropdown, menuBtn);
        dropdown.hidden = false;
        item.classList.add("menu-open");
        openDropdownId = dict.id;
        openDropdownEl = dropdown;
        openCardEl = item;
      }
    });

    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(dropdown);

    const flagEl = document.createElement("div");
    flagEl.className = "dictionary-card__flag";
    flagEl.textContent = flagForLanguage(dict.source_language);

    const nameEl = document.createElement("div");
    nameEl.className = "word-card-item__word dictionary-card__name";
    nameEl.textContent = dict.name;

    const langsEl = document.createElement("div");
    langsEl.className = "word-card-item__translation dictionary-card__langs";
    langsEl.textContent = `${dict.source_language} → ${dict.target_language}`;

    const statsEl = document.createElement("div");
    statsEl.className = "dictionary-card__stats";
    const s = dict.stats || { total: 0, known: 0, unknown: 0 };
    statsEl.innerHTML = `
      <span>Слов: ${s.total}</span>
      <span class="is-known">Знаю: ${s.known}</span>
      <span class="is-unknown">Не знаю: ${s.unknown}</span>
    `;

    item.appendChild(menuWrap);
    item.appendChild(flagEl);
    item.appendChild(nameEl);
    item.appendChild(langsEl);
    item.appendChild(statsEl);

    item.addEventListener("click", () => enterDictionary(dict));

    return item;
  }

  async function enterDictionary(dict) {
    currentDictionary = dict;
    dictionaryDetailTitleEl.textContent = dict.name;
    dictionaryDetailLangsEl.textContent = `${dict.source_language} → ${dict.target_language}`;
    showDictionaryView(viewChoice);
    await refreshWordsCache();
    window.WordCheckApp.showScreen("home");
  }

  dictionaryBackBtn.addEventListener("click", () => {
    window.WordCheckApp.showScreen("dictionaries");
    renderDictionariesList();
  });

  // ---- Создание словаря (модалка) ----

  const dictCreateModal = document.getElementById("dictionary-create-modal");
  const dictCreateBackdrop = document.getElementById("dictionary-create-modal-backdrop");
  const dictCreateNameInput = document.getElementById("dict-create-name");
  const dictCreateSourceInput = document.getElementById("dict-create-source");
  const dictCreateTargetInput = document.getElementById("dict-create-target");
  const dictCreateError = document.getElementById("dict-create-error");
  const dictCreateCancel = document.getElementById("dict-create-cancel");
  const dictCreateSave = document.getElementById("dict-create-save");

  function openDictionaryCreateModal() {
    dictCreateNameInput.value = "";
    dictCreateSourceInput.value = "";
    dictCreateTargetInput.value = "";
    dictCreateError.hidden = true;
    dictCreateModal.hidden = false;
    dictCreateModal.setAttribute("aria-hidden", "false");
    dictCreateNameInput.focus();
  }

  function closeDictionaryCreateModal() {
    dictCreateModal.hidden = true;
    dictCreateModal.setAttribute("aria-hidden", "true");
  }

  btnCreateDictionary.addEventListener("click", openDictionaryCreateModal);
  dictCreateCancel.addEventListener("click", closeDictionaryCreateModal);
  dictCreateBackdrop.addEventListener("click", closeDictionaryCreateModal);

  dictCreateSave.addEventListener("click", async () => {
    const name = dictCreateNameInput.value.trim();
    const sourceLanguage = dictCreateSourceInput.value.trim();
    const targetLanguage = dictCreateTargetInput.value.trim();

    if (!name || !sourceLanguage || !targetLanguage) {
      dictCreateError.textContent = "Заполните название, исходный язык и язык перевода.";
      dictCreateError.hidden = false;
      return;
    }
    dictCreateError.hidden = true;

    const result = await withErrorMessage(
      window.wordCheckDB.createDictionary({ name, sourceLanguage, targetLanguage }),
      dictCreateError,
      "Не удалось создать словарь. Попробуйте ещё раз."
    );
    if (!result.ok) return;

    closeDictionaryCreateModal();
    const newDict = { ...result.value, stats: { total: 0, known: 0, probablyKnown: 0, unknown: 0, untested: 0 } };
    await enterDictionary(newDict);
  });

  // ---- Удаление словаря (модалка) ----

  const dictDeleteModal = document.getElementById("dictionary-delete-modal");
  const dictDeleteBackdrop = document.getElementById("dictionary-delete-modal-backdrop");
  const dictDeletePreview = document.getElementById("dictionary-delete-preview");
  const dictDeleteCancel = document.getElementById("dictionary-delete-cancel");
  const dictDeleteConfirm = document.getElementById("dictionary-delete-confirm");

  function openDictionaryDeleteModal(dict) {
    deletingDictionaryId = dict.id;
    dictDeletePreview.innerHTML = "";
    const nameEl = document.createElement("strong");
    nameEl.textContent = dict.name;
    const noteEl = document.createElement("span");
    noteEl.textContent = "Все слова и статистика этого словаря будут удалены безвозвратно.";
    dictDeletePreview.appendChild(nameEl);
    dictDeletePreview.appendChild(document.createElement("br"));
    dictDeletePreview.appendChild(noteEl);
    dictDeleteModal.hidden = false;
    dictDeleteModal.setAttribute("aria-hidden", "false");
    dictDeleteCancel.focus();
  }

  function closeDictionaryDeleteModal() {
    dictDeleteModal.hidden = true;
    dictDeleteModal.setAttribute("aria-hidden", "true");
    deletingDictionaryId = null;
  }

  dictDeleteCancel.addEventListener("click", closeDictionaryDeleteModal);
  dictDeleteBackdrop.addEventListener("click", closeDictionaryDeleteModal);
  dictDeleteConfirm.addEventListener("click", async () => {
    if (deletingDictionaryId === null) return;
    const id = deletingDictionaryId;
    closeDictionaryDeleteModal();
    await withErrorMessage(window.wordCheckDB.deleteDictionary(id), null, "Не удалось удалить словарь.");
    renderDictionariesList();
  });

  // ============================================================
  // Внутри словаря: переключение под-экранов
  // ============================================================

  function showDictionaryView(view) {
    [viewChoice, viewQuickCreate, viewList].forEach((el) => {
      const isActive = el === view;
      el.hidden = !isActive;
      el.setAttribute("aria-hidden", String(!isActive));
    });
    screenHome.classList.toggle("setup-active", view !== viewChoice);
    screenHome.classList.toggle("setup-wide", view === viewList);
  }

  function goToDictionaryMenu() {
    showDictionaryView(viewChoice);
    updateStartTestOption();
  }

  optionCreate.addEventListener("click", async () => {
    showDictionaryView(viewQuickCreate);
    await startQuickCreateSession();
  });

  optionList.addEventListener("click", async () => {
    await loadAndRenderCardList();
    showDictionaryView(viewList);
  });

  optionStartTest.addEventListener("click", () => {
    if (words.length === 0) return;
    window.WordCheckApp.startTest(
      words.map((w) => ({ id: w.id, word: w.word })),
      currentDictionary.id,
      currentDictionary.name
    );
  });

  function updateStartTestOption() {
    optionStartTest.disabled = words.length === 0;
  }

  backFromQuickCreate.addEventListener("click", goToDictionaryMenu);
  backFromList.addEventListener("click", goToDictionaryMenu);

  // ============================================================
  // Список карточек (слов) текущего словаря
  // ============================================================

  const cardCountLabelEl = document.getElementById("card-count-label");
  const cardSearchInputEl = document.getElementById("card-search-input");
  const cardGridEl = document.getElementById("card-grid");
  const cardEmptyStateEl = document.getElementById("card-empty-state");
  const btnAddCard = document.getElementById("btn-add-card");
  const btnStartCreate = document.getElementById("btn-start-create");

  const btnPanelImport = document.getElementById("btn-panel-import");
  const btnPanelExport = document.getElementById("btn-panel-export");
  const panelImportFileInput = document.getElementById("panel-import-file-input");
  const panelImportReportEl = document.getElementById("panel-import-report");
  const panelImportReportSummaryEl = document.getElementById("panel-import-report-summary");
  const panelImportReportErrorsEl = document.getElementById("panel-import-report-errors");
  const exportDropdown = document.getElementById("export-dropdown");
  const exportAsTxtBtn = document.getElementById("export-as-txt");
  const exportAsJsonBtn = document.getElementById("export-as-json");

  const cardEditModal = document.getElementById("card-edit-modal");
  const cardEditModalBackdrop = document.getElementById("card-edit-modal-backdrop");
  const cardEditTitle = document.getElementById("card-edit-title");
  const cardEditWordInput = document.getElementById("card-edit-word");
  const cardEditTranslationInput = document.getElementById("card-edit-translation");
  const cardEditError = document.getElementById("card-edit-error");
  const cardEditCancel = document.getElementById("card-edit-cancel");
  const cardEditSave = document.getElementById("card-edit-save");

  const cardDeleteModal = document.getElementById("card-delete-modal");
  const cardDeleteModalBackdrop = document.getElementById("card-delete-modal-backdrop");
  const cardDeletePreview = document.getElementById("card-delete-preview");
  const cardDeleteCancel = document.getElementById("card-delete-cancel");
  const cardDeleteConfirm = document.getElementById("card-delete-confirm");

  async function refreshWordsCache() {
    const result = await withErrorMessage(
      window.wordCheckDB.listWords(currentDictionary.id),
      null,
      "Не удалось загрузить слова словаря."
    );
    words = result.ok ? result.value : [];
    updateStartTestOption();
  }

  function getFilteredWords() {
    const query = cardSearchInputEl.value.trim().toLowerCase();
    if (!query) return { list: words, query: "" };
    const list = words.filter(
      (w) => w.word.toLowerCase().includes(query) || w.translation.toLowerCase().includes(query)
    );
    return { list, query };
  }

  function updateCardCountLabel(filteredCount, query) {
    cardCountLabelEl.textContent = query
      ? `Найдено: ${filteredCount} из ${words.length}`
      : `Всего слов: ${words.length}`;
  }

  function buildCardItem(word) {
    const item = document.createElement("div");
    item.className = "glass-card word-card-item";
    item.dataset.wordId = String(word.id);

    const menuWrap = document.createElement("div");
    menuWrap.className = "word-card-item__menu-wrap";

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "word-card-item__menu-btn";
    menuBtn.setAttribute("aria-label", "Действия с карточкой");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.textContent = "⋮";

    const dropdown = document.createElement("div");
    dropdown.className = "word-card-item__dropdown";
    dropdown.hidden = true;

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Редактировать";
    editBtn.addEventListener("click", () => {
      closeOpenDropdown();
      openEditModal(word.id);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Удалить";
    deleteBtn.addEventListener("click", () => {
      closeOpenDropdown();
      openDeleteModal(word.id);
    });

    dropdown.appendChild(editBtn);
    dropdown.appendChild(deleteBtn);

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = openDropdownId === word.id;
      closeOpenDropdown();
      if (!isOpen) {
        document.body.appendChild(dropdown);
        positionDropdown(dropdown, menuBtn);
        dropdown.hidden = false;
        item.classList.add("menu-open");
        openDropdownId = word.id;
        openDropdownEl = dropdown;
        openCardEl = item;
      }
    });

    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(dropdown);

    const wordEl = document.createElement("div");
    wordEl.className = "word-card-item__word";
    wordEl.textContent = word.word;

    const translationEl = document.createElement("div");
    translationEl.className = "word-card-item__translation";
    translationEl.textContent = word.translation;

    item.appendChild(menuWrap);
    item.appendChild(wordEl);
    item.appendChild(translationEl);

    return item;
  }

  function renderFilteredList() {
    const { list, query } = getFilteredWords();

    cardGridEl.innerHTML = "";

    if (list.length === 0) {
      cardEmptyStateEl.hidden = false;
      cardEmptyStateEl.textContent = query
        ? "Ничего не найдено"
        : "Пока нет карточек. Нажмите «+ Добавить карточку».";
    } else {
      cardEmptyStateEl.hidden = true;
      const fragment = document.createDocumentFragment();
      list.forEach((word) => fragment.appendChild(buildCardItem(word)));
      cardGridEl.appendChild(fragment);
    }

    updateCardCountLabel(list.length, query);
    btnStartCreate.disabled = words.length === 0;
    btnPanelExport.disabled = words.length === 0;
  }

  async function loadAndRenderCardList() {
    closeOpenDropdown();
    closeExportMenu();
    await refreshWordsCache();
    renderFilteredList();
  }

  cardSearchInputEl.addEventListener("input", renderFilteredList);

  // ---- Добавление / редактирование карточки ----

  function openEditModal(wordId) {
    editingWordId = wordId;
    const word = wordId !== null ? words.find((w) => w.id === wordId) : null;
    cardEditTitle.textContent = word ? "Редактировать карточку" : "Добавить карточку";
    cardEditWordInput.value = word ? word.word : "";
    cardEditTranslationInput.value = word ? word.translation : "";
    cardEditError.hidden = true;
    cardEditError.textContent = "";
    cardEditModal.hidden = false;
    cardEditModal.setAttribute("aria-hidden", "false");
    cardEditWordInput.focus();
  }

  function closeEditModal() {
    cardEditModal.hidden = true;
    cardEditModal.setAttribute("aria-hidden", "true");
    editingWordId = null;
  }

  btnAddCard.addEventListener("click", () => openEditModal(null));
  cardEditCancel.addEventListener("click", closeEditModal);
  cardEditModalBackdrop.addEventListener("click", closeEditModal);

  cardEditSave.addEventListener("click", async () => {
    const word = cardEditWordInput.value.trim();
    const translation = cardEditTranslationInput.value.trim();

    if (!word || !translation) {
      cardEditError.textContent = "Заполните оба поля — Слово и Перевод.";
      cardEditError.hidden = false;
      return;
    }

    const promise =
      editingWordId !== null
        ? window.wordCheckDB.updateWord(editingWordId, word, translation)
        : window.wordCheckDB.addWord(currentDictionary.id, word, translation);

    const result = await withErrorMessage(promise, cardEditError, "Не удалось сохранить карточку.");
    if (!result.ok) return;

    if (result.value && result.value.duplicate) {
      cardEditError.textContent = "Такая карточка (слово + перевод) уже есть в этом словаре.";
      cardEditError.hidden = false;
      return;
    }

    closeEditModal();
    await loadAndRenderCardList();
  });

  // ---- Удаление карточки ----

  function openDeleteModal(wordId) {
    const word = words.find((w) => w.id === wordId);
    if (!word) return;
    deletingWordId = wordId;

    cardDeletePreview.innerHTML = "";
    const wordEl = document.createElement("strong");
    wordEl.textContent = word.word;
    const translationEl = document.createElement("span");
    translationEl.textContent = word.translation;
    cardDeletePreview.appendChild(wordEl);
    cardDeletePreview.appendChild(document.createElement("br"));
    cardDeletePreview.appendChild(translationEl);

    cardDeleteModal.hidden = false;
    cardDeleteModal.setAttribute("aria-hidden", "false");
    cardDeleteCancel.focus();
  }

  function closeDeleteModal() {
    cardDeleteModal.hidden = true;
    cardDeleteModal.setAttribute("aria-hidden", "true");
    deletingWordId = null;
  }

  cardDeleteCancel.addEventListener("click", closeDeleteModal);
  cardDeleteModalBackdrop.addEventListener("click", closeDeleteModal);
  cardDeleteConfirm.addEventListener("click", async () => {
    if (deletingWordId === null) return;
    const id = deletingWordId;
    closeDeleteModal();
    await withErrorMessage(window.wordCheckDB.deleteWord(id), null, "Не удалось удалить карточку.");
    await loadAndRenderCardList();
  });

  // ============================================================
  // Импорт (формат определяется автоматически: TXT или JSON)
  // ============================================================

  // Разделитель TXT: основной — ";" (формат, уже использовавшийся в проекте),
  // дополнительно понимаем "|" (формат из примеров TXT), чтобы старые и новые
  // файлы одинаково корректно читались.
  function splitLine(line) {
    if (line.includes(";")) return line.split(";");
    if (line.includes("|")) return line.split("|");
    return [line];
  }

  function parseTxtContent(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const errors = [];
    const parsedCards = [];

    lines.forEach((rawLine, i) => {
      const lineNumber = i + 1;
      const line = rawLine.trim();
      if (line === "") return;

      const parts = splitLine(line).map((p) => p.trim());

      if (parts.length < 2) {
        errors.push({ line: lineNumber, message: "отсутствует разделитель «;» (или «|») и перевод." });
        return;
      }
      if (parts.length > 2) {
        errors.push({
          line: lineNumber,
          message: "найдено больше двух значений. Используйте формат: слово;перевод.",
        });
        return;
      }

      const [word, translation] = parts;
      if (!word && !translation) {
        errors.push({ line: lineNumber, message: "отсутствует слово и перевод." });
        return;
      }
      if (!word) {
        errors.push({ line: lineNumber, message: "отсутствует слово." });
        return;
      }
      if (!translation) {
        errors.push({ line: lineNumber, message: "отсутствует перевод." });
        return;
      }
      parsedCards.push({ word, translation });
    });

    return { cards: parsedCards, errors };
  }

  // Формат JSON: { version, dictionary?: {...}, cards: [{front, back}] }
  // или просто массив [{front, back}]. dictionary (если есть) сейчас
  // игнорируется при импорте внутрь конкретного словаря — слова всегда
  // уходят в тот словарь, где нажали "Импорт" (как явно описано в задаче).
  function parseJsonContent(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { cards: [], errors: [{ line: 0, message: "файл повреждён или не является корректным JSON." }] };
    }

    const rawList = Array.isArray(data) ? data : data && Array.isArray(data.cards) ? data.cards : null;

    if (rawList === null) {
      return {
        cards: [],
        errors: [{ line: 0, message: 'ожидается массив карточек или объект с полем "cards".' }],
      };
    }

    const errors = [];
    const parsedCards = [];

    rawList.forEach((item, i) => {
      const itemNumber = i + 1;
      if (!item || typeof item !== "object") {
        errors.push({ line: itemNumber, message: "запись не является объектом с полями front/back." });
        return;
      }
      const word = typeof item.front === "string" ? item.front.trim() : "";
      const translation = typeof item.back === "string" ? item.back.trim() : "";

      if (!word && !translation) {
        errors.push({ line: itemNumber, message: "отсутствует слово (front) и перевод (back)." });
        return;
      }
      if (!word) {
        errors.push({ line: itemNumber, message: "отсутствует слово (front)." });
        return;
      }
      if (!translation) {
        errors.push({ line: itemNumber, message: "отсутствует перевод (back)." });
        return;
      }
      parsedCards.push({ word, translation });
    });

    return { cards: parsedCards, errors };
  }

  // Автоопределение формата: сначала по расширению файла, а если оно не
  // .txt/.json (или отсутствует) — по содержимому (валидный JSON -> JSON).
  function detectFormatAndParse(filename, text) {
    const isJsonExt = /\.json$/i.test(filename);
    const isTxtExt = /\.txt$/i.test(filename);

    if (isJsonExt) return { format: "json", ...parseJsonContent(text) };
    if (isTxtExt) return { format: "txt", ...parseTxtContent(text) };

    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed);
        return { format: "json", ...parseJsonContent(text) };
      } catch (e) {
        // не похоже на валидный JSON — пробуем как TXT
      }
    }
    return { format: "txt", ...parseTxtContent(text) };
  }

  function renderPanelImportReport(insertedCount, duplicatesCount, errors) {
    panelImportReportEl.hidden = false;
    panelImportReportSummaryEl.innerHTML = "";

    const okSpan = document.createElement("span");
    okSpan.className = "is-ok";
    okSpan.textContent = `✓ Добавлено: ${insertedCount}`;
    panelImportReportSummaryEl.appendChild(okSpan);

    if (duplicatesCount > 0) {
      const dupSpan = document.createElement("span");
      dupSpan.textContent = `⚠ Пропущено дублей: ${duplicatesCount}`;
      panelImportReportSummaryEl.appendChild(dupSpan);
    }

    const badSpan = document.createElement("span");
    badSpan.className = "is-bad";
    badSpan.textContent = `✕ Ошибок: ${errors.length}`;
    panelImportReportSummaryEl.appendChild(badSpan);

    panelImportReportErrorsEl.innerHTML = "";
    errors.forEach((err) => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = err.line > 0 ? `Запись ${err.line}` : "Файл";
      li.appendChild(strong);
      li.appendChild(document.createTextNode(` — ${err.message}`));
      panelImportReportErrorsEl.appendChild(li);
    });
  }

  btnPanelImport.addEventListener("click", () => {
    panelImportFileInput.click();
  });

  panelImportFileInput.addEventListener("change", () => {
    const file = panelImportFileInput.files && panelImportFileInput.files[0];
    panelImportFileInput.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = String(ev.target.result || "");
      const { cards: parsedCards, errors } = detectFormatAndParse(file.name, text);

      let inserted = 0;
      let duplicates = 0;
      if (parsedCards.length > 0) {
        const result = await withErrorMessage(
          window.wordCheckDB.bulkImportWords(currentDictionary.id, parsedCards),
          null,
          "Не удалось сохранить импортированные карточки."
        );
        if (result.ok) {
          inserted = result.value.inserted;
          duplicates = result.value.duplicates;
        }
      }

      renderPanelImportReport(inserted, duplicates, errors);

      if (inserted > 0) {
        await loadAndRenderCardList();
      }
    };
    reader.onerror = () => {
      renderPanelImportReport(0, 0, [{ line: 0, message: "не удалось прочитать файл." }]);
    };
    reader.readAsText(file, "UTF-8");
  });

  // ============================================================
  // Экспорт: выбор формата TXT/JSON через меню у кнопки "Экспорт"
  // ============================================================

  btnPanelExport.addEventListener("click", (e) => {
    e.stopPropagation();
    if (words.length === 0) return;
    const wasOpen = exportMenuOpen;
    closeOpenDropdown();
    closeExportMenu();
    if (!wasOpen) {
      document.body.appendChild(exportDropdown);
      positionDropdown(exportDropdown, btnPanelExport, 200);
      exportDropdown.hidden = false;
      exportMenuOpen = true;
    }
  });

  exportAsTxtBtn.addEventListener("click", () => {
    closeExportMenu();
    if (words.length === 0) return;
    const text = words.map((w) => `${w.word};${w.translation}`).join("\n");
    downloadTextFile(`${safeFilename(currentDictionary.name)}.txt`, text);
  });

  exportAsJsonBtn.addEventListener("click", () => {
    closeExportMenu();
    if (words.length === 0) return;
    const json = JSON.stringify(
      {
        version: 2,
        dictionary: {
          name: currentDictionary.name,
          source_language: currentDictionary.source_language,
          target_language: currentDictionary.target_language,
        },
        cards: words.map((w) => ({ front: w.word, back: w.translation })),
      },
      null,
      2
    );
    downloadTextFile(`${safeFilename(currentDictionary.name)}.json`, json);
  });

  btnStartCreate.addEventListener("click", () => {
    if (words.length === 0) return;
    window.WordCheckApp.startTest(
      words.map((w) => ({ id: w.id, word: w.word })),
      currentDictionary.id,
      currentDictionary.name
    );
  });

  // ============================================================
  // Быстрое последовательное создание карточек
  // ============================================================

  const quickCounterEl = document.getElementById("quick-create-counter");
  const quickWordInput = document.getElementById("quick-word");
  const quickTranslationInput = document.getElementById("quick-translation");
  const quickErrorEl = document.getElementById("quick-create-error");
  const btnQuickBack = document.getElementById("btn-quick-back");
  const btnQuickNext = document.getElementById("btn-quick-next");
  const quickFinishEl = document.getElementById("quick-create-finish");
  const btnQuickToList = document.getElementById("btn-quick-to-list");
  const btnQuickToHome = document.getElementById("btn-quick-to-home");

  async function startQuickCreateSession() {
    await refreshWordsCache();
    quickSessionStartLen = words.length;
    quickIndex = words.length;
    quickErrorEl.hidden = true;
    quickErrorEl.textContent = "";
    renderQuickCreateStep();
  }

  function renderQuickCreateStep() {
    const existing = words[quickIndex];
    quickWordInput.value = existing ? existing.word : "";
    quickTranslationInput.value = existing ? existing.translation : "";
    quickCounterEl.textContent = `Карточка №${quickIndex - quickSessionStartLen + 1}`;
    btnQuickBack.disabled = quickIndex <= quickSessionStartLen;
    quickFinishEl.hidden = words.length <= quickSessionStartLen;
    quickWordInput.focus();
  }

  btnQuickNext.addEventListener("click", async () => {
    const word = quickWordInput.value.trim();
    const translation = quickTranslationInput.value.trim();

    if (!word || !translation) {
      quickErrorEl.textContent = "Заполните оба поля — Слово и Перевод.";
      quickErrorEl.hidden = false;
      return;
    }
    quickErrorEl.hidden = true;

    const promise =
      quickIndex < words.length
        ? window.wordCheckDB.updateWord(words[quickIndex].id, word, translation)
        : window.wordCheckDB.addWord(currentDictionary.id, word, translation);

    const result = await withErrorMessage(promise, quickErrorEl, "Не удалось сохранить карточку.");
    if (!result.ok) return;

    if (result.value && result.value.duplicate) {
      quickErrorEl.textContent = "Такая карточка (слово + перевод) уже есть в этом словаре.";
      quickErrorEl.hidden = false;
      return;
    }

    if (quickIndex < words.length) {
      words[quickIndex] = result.value;
    } else {
      words.push(result.value);
    }

    quickIndex += 1;
    renderQuickCreateStep();
    updateStartTestOption();
  });

  btnQuickBack.addEventListener("click", () => {
    if (quickIndex <= quickSessionStartLen) return;
    quickIndex -= 1;
    quickErrorEl.hidden = true;
    renderQuickCreateStep();
  });

  btnQuickToList.addEventListener("click", async () => {
    await loadAndRenderCardList();
    showDictionaryView(viewList);
  });

  btnQuickToHome.addEventListener("click", goToDictionaryMenu);

  // ============================================================
  // Инициализация
  // ============================================================

  renderDictionariesList();
})();
