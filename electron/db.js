// WordCheck — слой базы данных.
// SQLite через sql.js (тот же движок SQLite, скомпилированный в WebAssembly) —
// выбрано вместо better-sqlite3, потому что на машине нет рабочего Python и
// Visual Studio Build Tools, необходимых для сборки нативных модулей.
// sql.js не требует компиляции вообще, при этом это тот же SQL/та же схема.
//
// sql.js держит базу в памяти и не пишет на диск сама — поэтому после каждой
// изменяющей операции мы явно экспортируем базу и атомарно перезаписываем файл
// (пишем во временный файл и переименовываем — переименование в пределах одного
// диска на Windows атомарно, поэтому крах посреди записи не испортит файл).

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

let SQL = null;
let db = null;
let dbFilePath = null;

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS dictionaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_language TEXT NOT NULL,
    target_language TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id) ON DELETE CASCADE,
    word TEXT NOT NULL,
    translation TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_words_dictionary ON words(dictionary_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_words_unique ON words(dictionary_id, word, translation);

  CREATE TABLE IF NOT EXISTS test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
    dictionary_id INTEGER NOT NULL REFERENCES dictionaries(id) ON DELETE CASCADE,
    result TEXT NOT NULL CHECK (result IN ('known','probably_known','unknown')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_results_word ON test_results(word_id);
`;

async function init(userDataDir) {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, "..", "node_modules", "sql.js", "dist", file),
  });

  dbFilePath = path.join(userDataDir, "wordcheck.sqlite");

  if (fs.existsSync(dbFilePath)) {
    const fileBuffer = fs.readFileSync(dbFilePath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // exec() (не run()) — надёжно выполняет несколько ";"-разделённых
  // выражений в одной строке, что и нужно для DDL-схемы из нескольких таблиц.
  db.exec(SCHEMA);
  persist();
}

// Атомарная запись: сначала во временный файл, потом переименование поверх основного.
function persist() {
  const data = db.export();
  const tmpPath = `${dbFilePath}.tmp`;
  fs.writeFileSync(tmpPath, Buffer.from(data));
  fs.renameSync(tmpPath, dbFilePath);
}

function run(sql, params = []) {
  db.run(sql, params);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function one(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

function lastInsertId() {
  const row = one("SELECT last_insert_rowid() AS id");
  return row.id;
}

// ---------- Словари ----------

function listDictionaries() {
  const dictionaries = all(
    "SELECT id, name, source_language, target_language, created_at FROM dictionaries ORDER BY created_at ASC, id ASC"
  );
  return dictionaries.map((dict) => ({ ...dict, stats: computeStats(dict.id) }));
}

function computeStats(dictionaryId) {
  const total = one("SELECT COUNT(*) AS c FROM words WHERE dictionary_id = ?", [dictionaryId]).c;

  // Последний результат по каждому слову словаря (для статистики "Знаю/Не знаю").
  const latestResults = all(
    `SELECT w.id AS word_id,
            (SELECT tr.result FROM test_results tr
              WHERE tr.word_id = w.id
              ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1) AS result
     FROM words w WHERE w.dictionary_id = ?`,
    [dictionaryId]
  );

  let known = 0;
  let probablyKnown = 0;
  let unknown = 0;
  latestResults.forEach((row) => {
    if (row.result === "known") known += 1;
    else if (row.result === "probably_known") probablyKnown += 1;
    else if (row.result === "unknown") unknown += 1;
  });

  return { total, known, probablyKnown, unknown, untested: total - known - probablyKnown - unknown };
}

function createDictionary({ name, sourceLanguage, targetLanguage }) {
  run("INSERT INTO dictionaries (name, source_language, target_language) VALUES (?, ?, ?)", [
    name,
    sourceLanguage,
    targetLanguage,
  ]);
  const id = lastInsertId();
  persist();
  return one("SELECT id, name, source_language, target_language, created_at FROM dictionaries WHERE id = ?", [id]);
}

function deleteDictionary(id) {
  run("DELETE FROM dictionaries WHERE id = ?", [id]);
  persist();
}

// ---------- Слова ----------

function listWords(dictionaryId) {
  return all(
    "SELECT id, word, translation, created_at, updated_at FROM words WHERE dictionary_id = ? ORDER BY created_at ASC, id ASC",
    [dictionaryId]
  );
}

function addWord(dictionaryId, word, translation) {
  try {
    run("INSERT INTO words (dictionary_id, word, translation) VALUES (?, ?, ?)", [
      dictionaryId,
      word,
      translation,
    ]);
  } catch (e) {
    if (String(e.message || e).includes("UNIQUE")) {
      return { duplicate: true };
    }
    throw e;
  }
  const id = lastInsertId();
  persist();
  return one("SELECT id, word, translation, created_at, updated_at FROM words WHERE id = ?", [id]);
}

function updateWord(id, word, translation) {
  try {
    run("UPDATE words SET word = ?, translation = ?, updated_at = datetime('now') WHERE id = ?", [
      word,
      translation,
      id,
    ]);
  } catch (e) {
    if (String(e.message || e).includes("UNIQUE")) {
      return { duplicate: true };
    }
    throw e;
  }
  persist();
  return one("SELECT id, word, translation, created_at, updated_at FROM words WHERE id = ?", [id]);
}

function deleteWord(id) {
  run("DELETE FROM words WHERE id = ?", [id]);
  persist();
}

// Массовый импорт с защитой от дублей: пары (слово, перевод), которые уже есть
// в этом словаре, тихо пропускаются (не создают копий), остальные добавляются.
function bulkImportWords(dictionaryId, items) {
  let inserted = 0;
  let duplicates = 0;
  items.forEach(({ word, translation }) => {
    try {
      run("INSERT INTO words (dictionary_id, word, translation) VALUES (?, ?, ?)", [
        dictionaryId,
        word,
        translation,
      ]);
      inserted += 1;
    } catch (e) {
      if (String(e.message || e).includes("UNIQUE")) {
        duplicates += 1;
      } else {
        throw e;
      }
    }
  });
  if (inserted > 0) persist();
  return { inserted, duplicates };
}

// ---------- Результаты тестирования ----------

function recordTestResult(dictionaryId, wordId, result) {
  run("INSERT INTO test_results (word_id, dictionary_id, result) VALUES (?, ?, ?)", [
    wordId,
    dictionaryId,
    result,
  ]);
  persist();
}

// ---------- Экспорт ----------

function exportDictionary(dictionaryId) {
  const dictionary = one(
    "SELECT id, name, source_language, target_language, created_at FROM dictionaries WHERE id = ?",
    [dictionaryId]
  );
  const words = listWords(dictionaryId);
  return { dictionary, words };
}

module.exports = {
  init,
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
  computeStats,
};
