const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("anti_recall", {
    clearDb: () => ipcRenderer.invoke("LiteLoader.anti_recall.clearDb"),
    getNowConfig: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getNowConfig"),
    saveConfig: (config) =>
        ipcRenderer.invoke("LiteLoader.anti_recall.saveConfig", config),
    repatchCss: (callback) =>
        ipcRenderer.on(
            "LiteLoader.anti_recall.mainWindow.repatchCss",
            callback
        ),
    recallTip: (callback) =>
        ipcRenderer.on("LiteLoader.anti_recall.mainWindow.recallTip", callback),
    recallTipList: (callback) =>
        ipcRenderer.on(
            "LiteLoader.anti_recall.mainWindow.recallTipList",
            callback
        ),
    requestRecallList: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getRecallList"),
    exportRecalled: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.exportRecalled"),
    getRecallStats: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getRecallStats"),
    getAntiRiskStatus: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getAntiRiskStatus"),
    openArchiveDir: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.openArchiveDir"),
    getRecalledMsgs: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getRecalledMsgs"),
    getHistoryStatus: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.getHistoryStatus"),
    testHistoryConnection: () =>
        ipcRenderer.invoke("LiteLoader.anti_recall.testHistoryConnection")
});
