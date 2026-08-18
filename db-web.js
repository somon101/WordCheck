/* =========================================================
   WordCheck — db-web.js
   IndexedDB-реализация того же самого интерфейса window.wordCheckDB,
   который в Electron-версии даёт preload.js (SQLite через IPC).

   Это позволяет setup.js и script.js оставаться ПОЛНОСТЬЮ одинаковыми
   в обеих версиях — desktop (Electron/SQLite) и web/Android (PWA/IndexedDB).
   Если window.wordCheckDB уже определён (значит, мы внутри Electron
   и preload.js уже отработал) — этот файл ничего не делает.
   ========================================================= */

(function () {
  "use strict";

  if (window.wordCheckDB) return; // уже есть настоящая (Electron/SQLite) реализация

  const DB_NAME = "wordcheck";
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        db.createObjectStore("dictionaries", { keyPath: "id", autoIncrement: true });

        const wordStore = db.createObjectStore("words", { keyPath: "id", autoIncrement: true });
        wordStore.createIndex("by_dictionary", "dictionary_id");
        wordStore.createIndex("unique_word", ["dictionary_id", "word", "translation"], { unique: true });

        const resultStore = db.createObjectStore("test_results", { keyPath: "id", autoIncrement: true });
        resultStore.createIndex("by_word", "word_id");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function promisifyTx(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  // Как add(), так и put() бросают ConstraintError при нарушении уникального
  // индекса (dictionary_id, word, translation) — по умолчанию это ЗАКРЫВАЕТ
  // всю транзакцию. preventDefault() на событии ошибки не даёт транзакции
  // упасть, чтобы можно было просто сообщить "уже есть такая карточка"
  // и продолжить (важно для массового импорта — одна дублирующаяся строка
  // не должна обрывать весь остальной импорт).
  function requestWithDuplicateGuard(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve({ duplicate: false, value: request.result });
      request.onerror = (event) => {
        if (request.error && request.error.name === "ConstraintError") {
          event.preventDefault();
          event.stopPropagation();
          resolve({ duplicate: true, value: null });
        } else {
          reject(request.error);
        }
      };
    });
  }

  async function getAllFromStore(storeName) {
    const db = await openDb();
    return promisifyRequest(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
  }

  function sortByCreatedThenId(a, b) {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.id - b.id;
  }

  // ---------- Словари ----------

  async function listDictionaries() {
    const [dicts, words, results] = await Promise.all([
      getAllFromStore("dictionaries"),
      getAllFromStore("words"),
      getAllFromStore("test_results"),
    ]);

    const latestByWord = new Map();
    results.forEach((r) => {
      const prev = latestByWord.get(r.word_id);
      if (!prev || r.created_at > prev.created_at || (r.created_at === prev.created_at && r.id > prev.id)) {
        latestByWord.set(r.word_id, r);
      }
    });

    return dicts
      .map((dict) => {
        const dictWords = words.filter((w) => w.dictionary_id === dict.id);
        let known = 0;
        let probablyKnown = 0;
        let unknown = 0;
        dictWords.forEach((w) => {
          const latest = latestByWord.get(w.id);
          if (!latest) return;
          if (latest.result === "known") known += 1;
          else if (latest.result === "probably_known") probablyKnown += 1;
          else if (latest.result === "unknown") unknown += 1;
        });
        const total = dictWords.length;
        return {
          ...dict,
          stats: { total, known, probablyKnown, unknown, untested: total - known - probablyKnown - unknown },
        };
      })
      .sort(sortByCreatedThenId);
  }

  async function createDictionary({ name, sourceLanguage, targetLanguage }) {
    const db = await openDb();
    const t = db.transaction("dictionaries", "readwrite");
    const now = nowStamp();
    const record = { name, source_language: sourceLanguage, target_language: targetLanguage, created_at: now };
    const id = await promisifyRequest(t.objectStore("dictionaries").add(record));
    await promisifyTx(t);
    return { id, ...record };
  }

  async function deleteDictionary(id) {
    const [words, results] = await Promise.all([getAllFromStore("words"), getAllFromStore("test_results")]);
    const wordIds = new Set(words.filter((w) => w.dictionary_id === id).map((w) => w.id));
    const resultIds = results.filter((r) => wordIds.has(r.word_id)).map((r) => r.id);

    const db = await openDb();
    const t = db.transaction(["dictionaries", "words", "test_results"], "readwrite");
    t.objectStore("dictionaries").delete(id);
    wordIds.forEach((wid) => t.objectStore("words").delete(wid));
    resultIds.forEach((rid) => t.objectStore("test_results").delete(rid));
    await promisifyTx(t);
  }

  // ---------- Слова ----------

  async function listWords(dictionaryId) {
    const words = await getAllFromStore("words");
    return words.filter((w) => w.dictionary_id === dictionaryId).sort(sortByCreatedThenId);
  }

  async function addWord(dictionaryId, word, translation) {
    const db = await openDb();
    const t = db.transaction("words", "readwrite");
    const now = nowStamp();
    const record = { dictionary_id: dictionaryId, word, translation, created_at: now, updated_at: now };
    const result = await requestWithDuplicateGuard(t.objectStore("words").add(record));
    await promisifyTx(t);
    if (result.duplicate) return { duplicate: true };
    return { id: result.value, ...record };
  }

  async function updateWord(id, word, translation) {
    const db = await openDb();
    const t = db.transaction("words", "readwrite");
    const store = t.objectStore("words");
    const existing = await promisifyRequest(store.get(id));
    const now = nowStamp();
    const updated = { ...existing, word, translation, updated_at: now };
    const result = await requestWithDuplicateGuard(store.put(updated));
    await promisifyTx(t);
    if (result.duplicate) return { duplicate: true };
    return updated;
  }

  async function deleteWord(id) {
    const results = await getAllFromStore("test_results");
    const resultIds = results.filter((r) => r.word_id === id).map((r) => r.id);

    const db = await openDb();
    const t = db.transaction(["words", "test_results"], "readwrite");
    t.objectStore("words").delete(id);
    resultIds.forEach((rid) => t.objectStore("test_results").delete(rid));
    await promisifyTx(t);
  }

  // Массовый импорт: дубликаты (по dictionary_id+word+translation) тихо
  // пропускаются, не обрывая остальной импорт — тот же контракт, что у
  // SQLite-версии (electron/db.js -> bulkImportWords).
  async function bulkImportWords(dictionaryId, items) {
    const db = await openDb();
    const t = db.transaction("words", "readwrite");
    const store = t.objectStore("words");
    const now = nowStamp();
    let inserted = 0;
    let duplicates = 0;

    for (const item of items) {
      const result = await requestWithDuplicateGuard(
        store.add({ dictionary_id: dictionaryId, word: item.word, translation: item.translation, created_at: now, updated_at: now })
      );
      if (result.duplicate) duplicates += 1;
      else inserted += 1;
    }

    await promisifyTx(t);
    return { inserted, duplicates };
  }

  // ---------- Результаты тестирования ----------

  async function recordTestResult(dictionaryId, wordId, result) {
    const db = await openDb();
    const t = db.transaction("test_results", "readwrite");
    await promisifyRequest(
      t.objectStore("test_results").add({ word_id: wordId, dictionary_id: dictionaryId, result, created_at: nowStamp() })
    );
    await promisifyTx(t);
  }

  // ---------- Экспорт ----------

  async function exportDictionary(dictionaryId) {
    const db = await openDb();
    const dictionary = await promisifyRequest(
      db.transaction("dictionaries", "readonly").objectStore("dictionaries").get(dictionaryId)
    );
    const words = await listWords(dictionaryId);
    return { dictionary, words };
  }

  window.wordCheckDB = {
    listDictionaries,
    createDictionary,
    deleteDictionary,
    listWords,
    addWord,
    updateWord,
    deleteWord,
    bulkImportWords,
    recordTestResult,
    exportDictionary,
  };
})();
