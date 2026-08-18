const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const db = require("./db");

let mainWindow = null;

async function createWindow() {
  await db.init(app.getPath("userData"));

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 480,
    minHeight: 640,
    backgroundColor: "#0b0e1c",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------- IPC: тонкий мост между рендерером и db.js ----------
// Каждый обработчик — прямой проброс к db.js, без доп. логики здесь,
// чтобы вся бизнес-логика хранения оставалась в одном месте (db.js).

ipcMain.handle("db:listDictionaries", () => db.listDictionaries());
ipcMain.handle("db:createDictionary", (e, payload) => db.createDictionary(payload));
ipcMain.handle("db:deleteDictionary", (e, id) => db.deleteDictionary(id));

ipcMain.handle("db:listWords", (e, dictionaryId) => db.listWords(dictionaryId));
ipcMain.handle("db:addWord", (e, { dictionaryId, word, translation }) =>
  db.addWord(dictionaryId, word, translation)
);
ipcMain.handle("db:updateWord", (e, { id, word, translation }) => db.updateWord(id, word, translation));
ipcMain.handle("db:deleteWord", (e, id) => db.deleteWord(id));
ipcMain.handle("db:bulkImportWords", (e, { dictionaryId, items }) => db.bulkImportWords(dictionaryId, items));

ipcMain.handle("db:recordTestResult", (e, { dictionaryId, wordId, result }) =>
  db.recordTestResult(dictionaryId, wordId, result)
);

ipcMain.handle("db:exportDictionary", (e, dictionaryId) => db.exportDictionary(dictionaryId));
