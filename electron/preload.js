const { contextBridge, ipcRenderer } = require("electron");

// Безопасный мост: рендерер (setup.js/script.js) вызывает window.wordCheckDB.*,
// не имея прямого доступа к Node/ipcRenderer — только к этим конкретным методам.
contextBridge.exposeInMainWorld("wordCheckDB", {
  listDictionaries: () => ipcRenderer.invoke("db:listDictionaries"),
  createDictionary: (payload) => ipcRenderer.invoke("db:createDictionary", payload),
  deleteDictionary: (id) => ipcRenderer.invoke("db:deleteDictionary", id),

  listWords: (dictionaryId) => ipcRenderer.invoke("db:listWords", dictionaryId),
  addWord: (dictionaryId, word, translation) =>
    ipcRenderer.invoke("db:addWord", { dictionaryId, word, translation }),
  updateWord: (id, word, translation) => ipcRenderer.invoke("db:updateWord", { id, word, translation }),
  deleteWord: (id) => ipcRenderer.invoke("db:deleteWord", id),
  bulkImportWords: (dictionaryId, items) => ipcRenderer.invoke("db:bulkImportWords", { dictionaryId, items }),

  recordTestResult: (dictionaryId, wordId, result) =>
    ipcRenderer.invoke("db:recordTestResult", { dictionaryId, wordId, result }),

  exportDictionary: (dictionaryId) => ipcRenderer.invoke("db:exportDictionary", dictionaryId),
});
