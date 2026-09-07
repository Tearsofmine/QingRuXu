const STORAGE_KEY = "qingruxu-library-v1";
const SETTINGS_KEY = "qingruxu-settings-v1";
const LIBRARY_DB_NAME = "qingruxu-library-db";
const LIBRARY_DB_VERSION = 2;
const LIBRARY_RECORD_KEY = "library";
const BOOK_ORDER_KEY = "book-order";
const IMPORT_MAX_BYTES = 100 * 1024 * 1024;
const IMPORT_SAMPLE_BYTES = 96 * 1024;
const IMPORT_CHUNK_BYTES = 1024 * 1024;
const BACKUP_FORMAT = "qingruxu-backup";
const BACKUP_VERSION = 1;
const BACKUP_MAX_BYTES = 250 * 1024 * 1024;

const sampleBooks = [
  {
    id: "sample-spring",
    title: "春山有信",
    author: "清如许原型",
    source: "原型示例",
    progress: 0.34,
    chapters: [
      { title: "第一章  雨后", text: "雨停的时候，山脚下的雾还没有散尽。\n\n沈遥推开旧书铺的木门，门铃轻轻响了一声。柜台后的人抬起头，指尖仍压在一页微黄的纸上。\n\n“找书吗？”他问。\n\n沈遥点头。她只记得那本书的开头有一句：山很远，灯很近。\n\n书铺里静了片刻。窗外的水珠从檐角落下，一下一下，像有人在很远的地方翻页。" },
      { title: "第二章  灯下", text: "天色暗下来，书铺里的灯一盏盏亮起。\n\n他从最里面的书架取下一册薄书，封面没有名字，只印着一枝淡青色的竹。\n\n“也许是这本。”\n\n沈遥接过书，纸页带着极浅的草木香。她翻到第一页，看见那行熟悉的字：山很远，灯很近。" },
      { title: "第三章  归途", text: "离开书铺时，街上的雾已经散了。\n\n沈遥把书抱在怀里，忽然觉得整座城都安静下来。远处的路灯亮着，像故事还没说完的逗号。\n\n她知道，明天还会再来。" }
    ]
  },
  {
    id: "sample-north",
    title: "北窗记事",
    author: "清如许原型",
    source: "原型示例",
    progress: 0,
    chapters: [{ title: "第一章", text: "这是一册用于展示书架的原型文本。\n\n正式版将由你导入自己的 TXT，或从已接入的合规书源加入书架。" }]
  },
  {
    id: "sample-river",
    title: "江湖夜话",
    author: "清如许原型",
    source: "原型示例",
    progress: 0,
    chapters: [{ title: "第一章", text: "山河遥远，故事正要开始。" }]
  }
];

const sourceSamples = [
  { id: "source-1", title: "公版作品示例", author: "已授权 / 公版书源", status: "可读 · 完结", source: "合规书源演示" },
  { id: "source-2", title: "连载作品示例", author: "已授权内容", status: "连载至第 128 章", source: "合规书源演示" },
  { id: "source-3", title: "中文经典示例", author: "公版整理", status: "可读 · 完结", source: "合规书源演示" }
];

let library = loadLibrary();
let settings = loadSettings();
let view = "shelf";
let reader = { bookId: null, chapter: 0, page: 0, anchorOffset: null, menuOpen: false, transitionDirection: "" };
let toastTimer;
let libraryReady = false;
let libraryReadyPromise = Promise.resolve();
let libraryWriteQueue = Promise.resolve();
let importSession = emptyImportSession();
let shelfAction = emptyShelfAction();
let progressPersistTimer;
let readerClockTimer;
let batteryManager;
let readerBatteryLevel = null;
let readerBatteryCharging = false;
let shelfQuery = "";
let backupSession = emptyBackupSession();
const paginationCache = [];
let readerViewportHeight = window.innerHeight;

const app = document.querySelector("#app");
const picker = document.querySelector("#file-picker");
const backupPicker = document.querySelector("#backup-picker");

function loadLibrary() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) && saved.length ? saved : sampleBooks;
  } catch { return sampleBooks; }
}

function loadSettings() {
  const defaults = { theme: "bamboo", fontSize: 19, fontFamily: "sans", fontWeight: "strong", lineHeight: "comfortable", pageTurn: "slide", shelfSort: "recent" };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    const next = { ...defaults, ...(saved && typeof saved === "object" ? saved : {}) };
    next.fontSize = clamp(Number(next.fontSize) || defaults.fontSize, 16, 40);
    if (!["recent", "imported", "title"].includes(next.shelfSort)) next.shelfSort = defaults.shelfSort;
    if (!["slide", "cover", "fade"].includes(next.pageTurn)) next.pageTurn = defaults.pageTurn;
    delete next.pageWidth;
    return next;
  }
  catch { return defaults; }
}

function openLibraryDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(createImportError("database-blocked"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("records")) database.createObjectStore("records");
      if (!database.objectStoreNames.contains("books")) database.createObjectStore("books", { keyPath: "id" });
      if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function readLibraryFromDatabase() {
  const database = await openLibraryDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(["books", "meta", "records"], "readonly");
      const orderRequest = transaction.objectStore("meta").get(BOOK_ORDER_KEY);
      const booksRequest = transaction.objectStore("books").getAll();
      const legacyRequest = transaction.objectStore("records").get(LIBRARY_RECORD_KEY);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("database-aborted"));
      transaction.oncomplete = () => {
        const books = Array.isArray(booksRequest.result) ? booksRequest.result : [];
        const order = Array.isArray(orderRequest.result) ? orderRequest.result : [];
        const initialized = Array.isArray(orderRequest.result);
        if (books.length || initialized) {
          const positions = new Map(order.map((id, index) => [id, index]));
          books.sort((left, right) => (positions.get(left.id) ?? Infinity) - (positions.get(right.id) ?? Infinity));
          resolve({ books, migratedFromLegacy: false, initialized: true });
          return;
        }
        const legacy = legacyRequest.result;
        resolve({ books: Array.isArray(legacy) ? legacy : [], migratedFromLegacy: Array.isArray(legacy) && legacy.length > 0, initialized: Array.isArray(legacy) && legacy.length > 0 });
      };
    });
  } finally {
    database.close();
  }
}

async function saveLibraryToDatabase(books) {
  const database = await openLibraryDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(["books", "meta", "records"], "readwrite");
      const booksStore = transaction.objectStore("books");
      const requestedIds = new Set(books.map((book) => book.id));
      const existingKeys = booksStore.getAllKeys();
      existingKeys.onsuccess = () => {
        existingKeys.result.forEach((id) => {
          if (!requestedIds.has(id)) booksStore.delete(id);
        });
        books.forEach((book) => booksStore.put(book));
        transaction.objectStore("meta").put(books.map((book) => book.id), BOOK_ORDER_KEY);
        transaction.objectStore("records").delete(LIBRARY_RECORD_KEY);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("database-aborted"));
      transaction.oncomplete = () => resolve();
    });
  } finally {
    database.close();
  }
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* Legacy cache cleanup is optional. */ }
}

function persistSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; }
  catch { return false; }
}

function persist() {
  persistSettings();
  const write = libraryWriteQueue.then(() => saveLibraryToDatabase(library));
  // A later save must still be allowed after an earlier quota or browser error.
  libraryWriteQueue = write.catch(() => {});
  return write.then(() => true).catch(() => {
    // Never report a successful large-book save when IndexedDB failed. An old
    // localStorage snapshot is still read during migration, but new imports
    // must either reach the database atomically or remain out of the shelf.
    return false;
  });
}

async function hydrateLibrary() {
  try {
    const saved = await readLibraryFromDatabase();
    if (saved.initialized) {
      library = saved.books;
      if (saved.migratedFromLegacy) await persist();
      render();
      return;
    }
    await persist();
  } catch {
    // Older or private browser sessions keep using the small legacy cache.
  } finally {
    libraryReady = true;
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"': "&quot;" }[char]));
}

function currentBook() { return library.find((book) => book.id === reader.bookId); }
function lastBook() {
  const started = library.filter((book) => book.lastReadAt || book.progress > 0).sort((left, right) => (right.lastReadAt || 0) - (left.lastReadAt || 0));
  return started[0] || library[0];
}

function render() {
  syncReaderViewportHeight();
  const transitionDirection = reader.transitionDirection;
  let content;
  if (view === "reader") content = readerScreen();
  else if (view === "search") content = searchScreen();
  else if (view === "settings") content = settingsScreen();
  else content = shelfScreen();
  app.innerHTML = `${content}${importOverlay()}${shelfActionOverlay()}${backupOverlay()}`;
  document.body.classList.toggle("reader-active", view === "reader");
  if (transitionDirection && reader.transitionDirection === transitionDirection) reader.transitionDirection = "";
  bindEvents();
  syncReaderStatus();
}

function syncReaderViewportHeight() {
  const browserHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  let targetHeight = browserHeight;
  if (standalone && window.screen) {
    const portrait = window.matchMedia?.("(orientation: portrait)").matches !== false;
    const screenHeight = portrait ? Math.max(window.screen.width, window.screen.height) : Math.min(window.screen.width, window.screen.height);
    targetHeight = Math.max(targetHeight, screenHeight || 0);
  }
  readerViewportHeight = Math.max(320, Math.round(targetHeight));
  document.documentElement.style.setProperty("--reader-viewport-height", `${readerViewportHeight}px`);
}

function shell(content, active) {
  return `<section class="screen">${content}</section>${tabbar(active)}`;
}

function emptyImportSession() {
  return {
    visible: false,
    phase: "idle",
    file: null,
    encoding: "auto",
    detectedEncoding: "",
    progress: 0,
    message: "",
    detail: "",
    errorCode: "",
    pendingBook: null,
    existingBookId: null,
    title: "",
    author: "",
    chapterCount: 0,
    wordCount: 0,
    preview: "",
    sameTitle: false,
    cleanedPromotionBlocks: 0,
    cleanedPromotionCharacters: 0
  };
}

function emptyBackupSession() {
  return { visible: false, phase: "idle", operation: "", file: null, payload: null, bookCount: 0, bookmarkCount: 0, exportedAt: "", message: "", detail: "" };
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function encodingName(encoding) {
  return ({ auto: "自动识别", "utf-8": "UTF-8", gb18030: "GB18030 / GBK", big5: "Big5", "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE" })[encoding] || encoding;
}

function importOverlay() {
  if (!importSession.visible) return "";
  const file = importSession.file;
  const fileLabel = file ? `${escapeHTML(file.name)} · ${formatFileSize(file.size)}` : "";
  const progress = Math.max(0, Math.min(100, Math.round(importSession.progress || 0)));
  const canReparse = file && !["file-type", "file-empty", "file-too-large", "storage"].includes(importSession.errorCode);
  const closeButton = `<button class="import-close" data-import-action="close" aria-label="关闭">×</button>`;

  if (importSession.phase === "choose") {
    return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <button class="import-backdrop" data-import-action="close" aria-label="关闭导入面板"></button>
      <section class="import-card import-choose-card"><div class="sheet-grab" aria-hidden="true"></div>${closeButton}
        <span class="import-symbol">＋</span><h2 id="import-title">导入到清如许</h2>
        <p class="subtle">支持 TXT（UTF-8、GB18030 / GBK、UTF-16）。书籍只保存在这台设备，不会移动或删除原文件。</p>
        <button class="primary-button import-main-action" data-import-action="choose-file">从“文件”选择 TXT</button>
        <p class="import-footnote">大文件会显示处理进度；遇到乱码时可更换编码重新解析。</p>
      </section>
    </aside>`;
  }

  if (importSession.phase === "working") {
    return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <section class="import-card import-working-card" aria-busy="true"><div class="sheet-grab" aria-hidden="true"></div>
        <span class="import-symbol import-symbol-working">◌</span><h2 id="import-title">正在导入</h2>
        <p class="import-file">${fileLabel}</p>
        <div class="import-progress" aria-label="导入进度 ${progress}%"><span style="width:${progress}%"></span></div>
        <p class="import-stage">${escapeHTML(importSession.message || "正在准备文件")}</p>
        <p class="import-footnote">${escapeHTML(importSession.detail || "文件较大时，请保持页面开启")}</p>
      </section>
    </aside>`;
  }

  if (importSession.phase === "preview") {
    return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <button class="import-backdrop" data-import-action="close" aria-label="放弃本次导入"></button>
      <section class="import-card"><div class="sheet-grab" aria-hidden="true"></div>${closeButton}
        <span class="import-symbol">✓</span><h2 id="import-title">检查一下内容</h2>
        <div class="import-metadata-form"><label><span>书名</span><input id="import-book-title" value="${escapeHTML(importSession.title)}" maxlength="80" autocomplete="off" /></label><label><span>作者</span><input id="import-book-author" value="${escapeHTML(importSession.author || "未知作者")}" maxlength="60" autocomplete="off" /></label></div>
        <p class="import-metadata-note">已根据文件名和正文开头自动识别，可在加入书架前修改。</p>
        <div class="import-summary"><span><b>${importSession.chapterCount}</b> 章</span><span><b>${Math.max(1, Math.round(importSession.wordCount / 10000))}</b> 万字</span><span>${encodingName(importSession.detectedEncoding)}</span></div>
        ${importSession.cleanedPromotionBlocks ? `<p class="import-cleaned-note">已自动剔除 ${importSession.cleanedPromotionBlocks} 处站外推广或导流信息；作者话、求票和章节收尾会保留，原始 TXT 不会被修改。</p>` : ""}
        ${importSession.sameTitle ? `<p class="import-notice">书架中已有同名小说；这份内容不同，会作为新副本保存。</p>` : ""}
        <div class="import-preview"><span>正文预览</span><p>${escapeHTML(importSession.preview)}</p></div>
        <div class="import-actions"><button class="secondary-button" data-import-action="reselect">重选文件</button><button class="primary-button" data-import-action="confirm">加入书架</button></div>
      </section>
    </aside>`;
  }

  if (importSession.phase === "duplicate") {
    return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <button class="import-backdrop" data-import-action="close" aria-label="关闭"></button>
      <section class="import-card"><div class="sheet-grab" aria-hidden="true"></div>${closeButton}
        <span class="import-symbol">＝</span><h2 id="import-title">书架中已有这本书</h2>
        <p class="subtle">检测到内容完全相同，因此没有重复保存。</p>
        <p class="import-file">${escapeHTML(importSession.title)}</p>
        <div class="import-actions"><button class="secondary-button" data-import-action="close">返回书架</button><button class="primary-button" data-import-action="open-existing">继续阅读已有书籍</button></div>
      </section>
    </aside>`;
  }

  if (importSession.phase === "success") {
    return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <button class="import-backdrop" data-import-action="close" aria-label="关闭"></button>
      <section class="import-card"><div class="sheet-grab" aria-hidden="true"></div>${closeButton}
        <span class="import-symbol">✓</span><h2 id="import-title">已加入书架</h2>
        <p class="import-file">${escapeHTML(importSession.title)}</p>
        <p class="subtle">已识别 ${importSession.chapterCount} 章 · ${encodingName(importSession.detectedEncoding)} · 文件仍保留在原来的位置。</p>
        <div class="import-actions"><button class="secondary-button" data-import-action="close">留在书架</button><button class="primary-button" data-import-action="read-imported">立即阅读</button></div>
      </section>
    </aside>`;
  }

  return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="import-title">
    <button class="import-backdrop" data-import-action="close" aria-label="关闭"></button>
    <section class="import-card"><div class="sheet-grab" aria-hidden="true"></div>${closeButton}
      <span class="import-symbol import-symbol-error">!</span><h2 id="import-title">没有导入成功</h2>
      <p class="import-error-message">${escapeHTML(importSession.message || "暂时无法读取这个文件")}</p>
      <p class="subtle">${escapeHTML(importSession.detail || "请重新选择一个 TXT 文件。")}</p>
      ${canReparse ? `<label class="encoding-select"><span>重新按此编码解析</span><select data-import-encoding><option value="auto" ${importSession.encoding === "auto" ? "selected" : ""}>自动识别</option><option value="utf-8" ${importSession.encoding === "utf-8" ? "selected" : ""}>UTF-8</option><option value="gb18030" ${importSession.encoding === "gb18030" ? "selected" : ""}>GB18030 / GBK</option><option value="big5" ${importSession.encoding === "big5" ? "selected" : ""}>Big5（繁体）</option><option value="utf-16le" ${importSession.encoding === "utf-16le" ? "selected" : ""}>UTF-16 LE</option><option value="utf-16be" ${importSession.encoding === "utf-16be" ? "selected" : ""}>UTF-16 BE</option></select></label>` : ""}
      <div class="import-actions ${canReparse ? "" : "single"}"><button class="secondary-button" data-import-action="reselect">重选文件</button>${canReparse ? `<button class="primary-button" data-import-action="retry">重新解析</button>` : ""}</div>
    </section>
  </aside>`;
}

function formatBackupDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function backupOverlay() {
  if (!backupSession.visible) return "";
  const fileLabel = backupSession.file ? `${escapeHTML(backupSession.file.name)} · ${formatFileSize(backupSession.file.size)}` : "";
  const retryAction = backupSession.operation === "export" ? "export" : "choose";
  const retryLabel = backupSession.operation === "export" ? "重新导出" : "重新选择";
  if (backupSession.phase === "working") {
    return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="backup-title"><section class="import-card import-working-card" aria-busy="true"><div class="sheet-grab" aria-hidden="true"></div><span class="import-symbol import-symbol-working">◌</span><h2 id="backup-title">${escapeHTML(backupSession.message || "正在读取备份")}</h2><p class="import-file">${fileLabel}</p><p class="import-footnote">${escapeHTML(backupSession.detail || "较大的书架可能需要一些时间")}</p></section></aside>`;
  }
  if (backupSession.phase === "preview") {
    return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="backup-title"><button class="import-backdrop" data-backup-action="close" aria-label="取消恢复"></button><section class="import-card"><div class="sheet-grab" aria-hidden="true"></div><button class="import-close" data-backup-action="close" aria-label="关闭">×</button><span class="import-symbol">✓</span><h2 id="backup-title">确认恢复这份备份？</h2><p class="import-file">${fileLabel}</p><div class="import-summary"><span><b>${backupSession.bookCount}</b> 本书</span><span><b>${backupSession.bookmarkCount}</b> 个书签</span></div><p class="subtle">备份时间：${escapeHTML(formatBackupDate(backupSession.exportedAt))}</p><p class="import-cleaned-note">现有书架不会被清空；相同小说会合并较新的进度和书签，同时恢复阅读外观与排序偏好。</p><div class="import-actions"><button class="secondary-button" data-backup-action="close">取消</button><button class="primary-button" data-backup-action="restore">合并并恢复</button></div></section></aside>`;
  }
  return `<aside class="import-layer" role="dialog" aria-modal="true" aria-labelledby="backup-title"><button class="import-backdrop" data-backup-action="close" aria-label="关闭"></button><section class="import-card"><div class="sheet-grab" aria-hidden="true"></div><button class="import-close" data-backup-action="close" aria-label="关闭">×</button><span class="import-symbol import-symbol-error">!</span><h2 id="backup-title">${backupSession.operation === "export" ? "无法导出这份备份" : "无法恢复这份备份"}</h2><p class="import-error-message">${escapeHTML(backupSession.message || "备份文件格式不正确")}</p><p class="subtle">${escapeHTML(backupSession.detail || "请重新选择由清如许导出的备份文件。")}</p><div class="import-actions"><button class="secondary-button" data-backup-action="close">取消</button><button class="primary-button" data-backup-action="${retryAction}">${retryLabel}</button></div></section></aside>`;
}

function emptyShelfAction() {
  return { visible: false, phase: "menu", bookId: null, title: "", error: "", coverCandidates: [] };
}

function shelfActionOverlay() {
  if (!shelfAction.visible) return "";
  const book = library.find((item) => item.id === shelfAction.bookId);
  const title = book?.title || shelfAction.title;
  if (!title) return "";

  if (["removing", "saving-edit", "matching-cover", "saving-cover"].includes(shelfAction.phase)) {
    const editing = shelfAction.phase === "saving-edit";
    const matching = shelfAction.phase === "matching-cover";
    const savingCover = shelfAction.phase === "saving-cover";
    const heading = editing ? "正在保存书籍信息" : matching ? "正在网上查找封面" : savingCover ? "正在保存封面" : "正在移出书架";
    const detail = editing ? "书名、作者、阅读进度和书签会一起安全保存。" : matching ? "只会发送书名和作者，不会上传小说正文。" : savingCover ? "封面来源和书架信息正在本地保存。" : `《${escapeHTML(title)}》的本地书架记录正在清理。`;
    return `<aside class="shelf-action-layer" role="dialog" aria-modal="true" aria-labelledby="shelf-action-title"><section class="shelf-action-card shelf-action-working" aria-busy="true"><div class="sheet-grab" aria-hidden="true"></div><span class="import-symbol import-symbol-working">◌</span><h2 id="shelf-action-title">${heading}</h2><p class="subtle">${detail}</p></section></aside>`;
  }

  if (shelfAction.phase === "cleaning") {
    return `<aside class="shelf-action-layer" role="dialog" aria-modal="true" aria-labelledby="shelf-action-title"><section class="shelf-action-card shelf-action-working" aria-busy="true"><div class="sheet-grab" aria-hidden="true"></div><span class="import-symbol import-symbol-working">◌</span><h2 id="shelf-action-title">正在清理正文</h2><p class="subtle">只处理高置信度的站外推广与导流；作者话、求票和章节收尾会保留。</p></section></aside>`;
  }

  if (shelfAction.phase === "cover-results") {
    return `<aside class="shelf-action-layer" role="dialog" aria-modal="true" aria-labelledby="shelf-action-title">
      <button class="shelf-action-backdrop" data-shelf-action="close" aria-label="取消选择封面"></button>
      <section class="shelf-action-card cover-match-card"><div class="sheet-grab" aria-hidden="true"></div>
        <p class="shelf-action-kicker">网上匹配封面</p><h2 id="shelf-action-title">选择《${escapeHTML(title)}》的封面</h2>
        <p class="subtle">候选来自 Open Library。请确认书名和作者，避免同名作品配错。</p>
        <div class="cover-candidate-grid">${shelfAction.coverCandidates.map((candidate, index) => `<button data-cover-index="${index}" aria-label="选择 ${escapeHTML(candidate.title)} 的封面"><img src="${onlineCoverUrl(candidate.coverId, "M")}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span><strong>${escapeHTML(candidate.title)}</strong><em>${escapeHTML(candidate.author || "作者未知")}</em></span></button>`).join("")}</div>
        <p class="cover-source-note">封面数据来源：Open Library</p>
        <div class="shelf-action-buttons"><button class="secondary-button" data-shelf-action="close">取消</button><button class="clean-button" data-shelf-action="match-cover">重新查找</button></div>
      </section>
    </aside>`;
  }

  if (shelfAction.phase === "cover-error") {
    return `<aside class="shelf-action-layer" role="dialog" aria-modal="true" aria-labelledby="shelf-action-title">
      <button class="shelf-action-backdrop" data-shelf-action="close" aria-label="关闭"></button>
      <section class="shelf-action-card"><div class="sheet-grab" aria-hidden="true"></div>
        <p class="shelf-action-kicker">网上匹配封面</p><h2 id="shelf-action-title">${escapeHTML(shelfAction.error || "暂时没有找到合适封面")}</h2>
        <p class="subtle">可以重新联网查找，也可以直接生成一张不依赖外部图片的清如许专属封面。</p>
        <div class="shelf-action-buttons"><button class="secondary-button" data-shelf-action="match-cover">重新查找</button><button class="clean-button" data-shelf-action="generate-cover">生成专属封面</button></div>
      </section>
    </aside>`;
  }

  if (shelfAction.phase === "confirm") {
    return `<aside class="shelf-action-layer" role="dialog" aria-modal="true" aria-labelledby="shelf-action-title">
      <button class="shelf-action-backdrop" data-shelf-action="close" aria-label="取消"></button>
      <section class="shelf-action-card"><div class="sheet-grab" aria-hidden="true"></div>
        <h2 id="shelf-action-title">移出《${escapeHTML(title)}》？</h2>
        <p class="subtle">会移除清如许里的正文副本和阅读进度，但不会删除“文件”里的原始 TXT。</p>
        ${shelfAction.error ? `<p class="shelf-action-error">${escapeHTML(shelfAction.error)}</p>` : ""}
        <div class="shelf-action-buttons"><button class="secondary-button" data-shelf-action="close">取消</button><button class="danger-button" data-shelf-action="remove">移出书架</button></div>
      </section>
    </aside>`;
  }

  if (shelfAction.phase === "edit") {
    return `<aside class="shelf-action-layer" role="dialog" aria-modal="true" aria-labelledby="shelf-action-title">
      <button class="shelf-action-backdrop" data-shelf-action="close" aria-label="取消编辑"></button>
      <section class="shelf-action-card"><div class="sheet-grab" aria-hidden="true"></div>
        <p class="shelf-action-kicker">编辑书籍信息</p><h2 id="shelf-action-title">整理书架显示</h2>
        <p class="subtle">只修改清如许里的名称和作者，不改原始 TXT、正文、进度或书签。</p>
        <form class="shelf-edit-form" id="shelf-edit-form">
          <label><span>书名</span><input id="shelf-edit-title" value="${escapeHTML(book.title)}" maxlength="80" autocomplete="off" required /></label>
          <label><span>作者</span><input id="shelf-edit-author" value="${escapeHTML(book.author || "未知作者")}" maxlength="60" autocomplete="off" /></label>
          ${shelfAction.error ? `<p class="shelf-action-error">${escapeHTML(shelfAction.error)}</p>` : ""}
          <div class="shelf-action-buttons"><button class="secondary-button" type="button" data-shelf-action="close">取消</button><button class="clean-button" type="submit">保存修改</button></div>
        </form>
      </section>
    </aside>`;
  }

  if (shelfAction.phase === "clean-confirm") {
    return `<aside class="shelf-action-layer" role="dialog" aria-modal="true" aria-labelledby="shelf-action-title">
      <button class="shelf-action-backdrop" data-shelf-action="close" aria-label="取消"></button>
      <section class="shelf-action-card"><div class="sheet-grab" aria-hidden="true"></div>
        <h2 id="shelf-action-title">清理《${escapeHTML(title)}》？</h2>
        <p class="subtle">会移除站名、网址和明确导流语，并尽量保留同一行前面的正文；作者话、求票及“本章完 / 下一章”会保留。</p>
        ${shelfAction.error ? `<p class="shelf-action-error">${escapeHTML(shelfAction.error)}</p>` : ""}
        <div class="shelf-action-buttons"><button class="secondary-button" data-shelf-action="close">取消</button><button class="clean-button" data-shelf-action="clean">开始清理</button></div>
      </section>
    </aside>`;
  }

  return `<aside class="shelf-action-layer" role="dialog" aria-modal="true" aria-labelledby="shelf-action-title">
    <button class="shelf-action-backdrop" data-shelf-action="close" aria-label="关闭"></button>
    <section class="shelf-action-card"><div class="sheet-grab" aria-hidden="true"></div>
      <p class="shelf-action-kicker">书架管理</p><h2 id="shelf-action-title">${escapeHTML(title)}</h2>
      <p class="subtle">可修改书架显示、清理站外推广与导流，或将这本书移出书架；原始 TXT 不会受到影响。</p>
      <button class="shelf-edit-option" data-shelf-action="edit"><span>✎</span>编辑书名与作者</button>
      <button class="shelf-cover-option" data-shelf-action="match-cover"><span>▧</span>网上匹配封面</button>
      <button class="shelf-generate-option" data-shelf-action="generate-cover"><span>◇</span>${book.coverStyle ? "换一款专属封面" : "生成专属封面"}</button>
      ${book.coverId || book.coverStyle ? `<button class="shelf-cover-reset" data-shelf-action="remove-cover">恢复普通文字封面</button>` : ""}
      <button class="shelf-clean-option" data-shelf-action="confirm-clean"><span>✦</span>清理推广与导流</button>
      <button class="shelf-remove-option" data-shelf-action="confirm-remove"><span>−</span>移出书架</button>
      <button class="secondary-button shelf-action-cancel" data-shelf-action="close">取消</button>
    </section>
  </aside>`;
}

function tabbar(active) {
  return `<nav class="tabbar" aria-label="主导航">
    <button class="tab ${active === "shelf" ? "active" : ""}" data-nav="shelf"><i>▦</i>书架</button>
    <button class="tab ${active === "search" ? "active" : ""}" data-nav="search"><i>⌕</i>找书</button>
    <button class="tab ${active === "settings" ? "active" : ""}" data-nav="settings"><i>◌</i>我的</button>
  </nav>`;
}

function normalizeShelfText(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

function shelfSearchText(book) {
  return normalizeShelfText([book?.title, book?.author, book?.source, book?.fileName].filter(Boolean).join(" "));
}

function shelfBooksInDisplayOrder(books = library) {
  const originalIndex = new Map(library.map((book, index) => [book.id, index]));
  const timestamp = (value) => Number(value) || 0;
  const readingTimestamp = (book) => timestamp(book.lastReadAt) || timestamp(book.importedAt);
  const fallbackOrder = (left, right) => (originalIndex.get(left.id) || 0) - (originalIndex.get(right.id) || 0);
  return [...books].sort((left, right) => {
    if (settings.shelfSort === "imported") {
      const importedDifference = timestamp(right.importedAt) - timestamp(left.importedAt);
      return importedDifference || fallbackOrder(left, right);
    }
    if (settings.shelfSort === "title") {
      return String(left.title || "").localeCompare(String(right.title || ""), "zh-Hans-CN", { numeric: true, sensitivity: "base" }) || fallbackOrder(left, right);
    }
    const readDifference = readingTimestamp(right) - readingTimestamp(left);
    return readDifference || fallbackOrder(left, right);
  });
}

function bookReadingStatus(book) {
  const progress = Math.round(clamp(Number(book?.progress) || 0, 0, 1) * 100);
  const chapterIndex = clamp(Number(book?.readingPosition?.chapter) || 0, 0, Math.max(0, (book?.chapters?.length || 1) - 1));
  const chapterTitle = book?.chapters?.[chapterIndex]?.title || "";
  if (progress >= 100) return { label: "已读完", progress };
  if (progress > 0 || book?.lastReadAt) return { label: chapterTitle ? `已读 ${progress}% · ${chapterTitle}` : `已读 ${progress}%`, progress };
  return { label: "未开始", progress: 0 };
}

function onlineCoverUrl(coverId, size = "M") {
  const id = Math.max(0, Math.trunc(Number(coverId) || 0));
  return id ? `https://covers.openlibrary.org/b/id/${id}-${size}.jpg?default=false` : "";
}

const generatedCoverThemes = [
  ["#183f31", "#4f8c68", "#dcefdc"],
  ["#263c59", "#718dab", "#e2ebf2"],
  ["#51342c", "#ad765f", "#f0dfcf"],
  ["#3d3154", "#8c76a3", "#eee5f1"],
  ["#51441f", "#b09143", "#f1e8c7"],
  ["#23464a", "#59959a", "#d9eeee"]
];

function generatedCoverIndex(book) {
  if (Number.isFinite(Number(book?.coverStyle)) && Number(book.coverStyle) > 0) return (Math.trunc(Number(book.coverStyle)) - 1) % generatedCoverThemes.length;
  let hash = 0;
  for (const character of `${book?.title || ""}${book?.author || ""}`) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return hash % generatedCoverThemes.length;
}

function bookCoverMarkup(book, className = "") {
  const coverUrl = onlineCoverUrl(book?.coverId, "M");
  const generated = !coverUrl && Number(book?.coverStyle) > 0;
  const colors = generatedCoverThemes[generatedCoverIndex(book)];
  const style = generated ? ` style="--cover-deep:${colors[0]};--cover-mid:${colors[1]};--cover-light:${colors[2]}"` : "";
  const author = coverSearchAuthor(book);
  return `<span class="cover ${className} ${coverUrl ? "has-image" : ""} ${generated ? "generated-cover" : ""}"${style}><span class="cover-ornament" aria-hidden="true">清如许</span><span class="cover-title">${escapeHTML(book?.title || "未命名小说")}</span>${generated && author ? `<span class="cover-author">${escapeHTML(author)}</span>` : ""}${coverUrl ? `<img src="${coverUrl}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}</span>`;
}

function shelfScreen() {
  const book = lastBook();
  const progress = Math.round((book?.progress || 0) * 100);
  const currentChapter = book?.chapters?.[Math.max(0, Math.min(book?.readingPosition?.chapter || 0, (book?.chapters?.length || 1) - 1))]?.title || "";
  const continueReading = book ? `<button class="now-reading" data-open-book="${book.id}">
      ${bookCoverMarkup(book, "cover-mini")}
      <span><span class="continue-label">继续阅读</span><strong class="now-title">${escapeHTML(book.title)}</strong><span class="now-meta">${escapeHTML(currentChapter)}</span><span class="progress-track"><span class="progress-fill" style="width:${progress}%"></span></span><span class="now-meta">已读 ${progress}%</span></span>
    </button>` : `<section class="shelf-welcome"><span>书架已经准备好</span><strong>导入第一本小说吧</strong><p>TXT 会保存在这台设备中，不需要注册。</p></section>`;
  const normalizedQuery = normalizeShelfText(shelfQuery);
  const books = shelfBooksInDisplayOrder();
  const matchedBooks = books.filter((item) => !normalizedQuery || shelfSearchText(item).includes(normalizedQuery));
  const sortName = { recent: "最近阅读", imported: "最近导入", title: "书名" }[settings.shelfSort] || "最近阅读";
  const shelfControls = library.length ? `<div class="shelf-controls">
      <div class="shelf-search"><span aria-hidden="true">⌕</span><input id="shelf-query" value="${escapeHTML(shelfQuery)}" placeholder="搜索书名或作者" autocomplete="off" aria-label="搜索本地书架" /><button id="shelf-query-clear" type="button" data-shelf-control="clear-search" aria-label="清除搜索" ${normalizedQuery ? "" : "hidden"}>×</button></div>
      <div class="shelf-sort-row" aria-label="书架排序"><span>排序</span><button class="${settings.shelfSort === "recent" ? "active" : ""}" data-shelf-sort="recent">最近阅读</button><button class="${settings.shelfSort === "imported" ? "active" : ""}" data-shelf-sort="imported">最近导入</button><button class="${settings.shelfSort === "title" ? "active" : ""}" data-shelf-sort="title">书名</button></div>
      <p class="shelf-search-result" id="shelf-search-result" ${normalizedQuery ? "" : "hidden"}>找到 ${matchedBooks.length} 本</p>
    </div>` : "";
  return shell(`
    <header class="topbar"><div class="brand"><span class="brand-mark">清</span>清如许</div><button class="round-button" data-action="import" aria-label="导入小说">+</button></header>
    <p class="eyebrow">书卷多情似故人</p><h1>今天，读到哪里了？</h1>
    ${continueReading}
    <div class="section-heading"><div><h2>我的书架</h2>${library.length ? `<span class="shelf-manage-hint">${library.length} 本 · ${sortName} · 长按书封面可管理</span>` : ""}</div><button class="text-button" data-action="import">导入小说</button></div>
    ${shelfControls}
    ${library.length ? `<div class="shelf-grid" id="shelf-grid">${books.map((item) => bookCard(item, normalizedQuery && !shelfSearchText(item).includes(normalizedQuery))).join("")}</div><section class="shelf-filter-empty" id="shelf-filter-empty" ${matchedBooks.length ? "hidden" : ""}><span>⌕</span><strong>没有找到这本书</strong><p>试试书名、作者，或清除搜索词。</p><button class="secondary-button" data-shelf-control="clear-search">清除搜索</button></section>` : emptyShelf()}
  `, "shelf");
}

function bookCard(book, hidden = false) {
  const reading = bookReadingStatus(book);
  return `<button class="book-card" data-open-book="${book.id}" data-shelf-book data-shelf-search="${escapeHTML(shelfSearchText(book))}" aria-label="打开《${escapeHTML(book.title)}》，长按可管理" ${hidden ? "hidden" : ""}>${bookCoverMarkup(book)}<span class="book-title">${escapeHTML(book.title)}</span><span class="book-author">${escapeHTML(book.author)}</span><span class="book-reading"><span class="book-reading-label">${escapeHTML(reading.label)}</span><span class="book-reading-track"><i style="width:${reading.progress}%"></i></span></span></button>`;
}

function filterShelfBooks(query) {
  const normalizedQuery = normalizeShelfText(query);
  const cards = [...document.querySelectorAll("[data-shelf-book]")];
  let matched = 0;
  cards.forEach((card) => {
    const matches = !normalizedQuery || String(card.dataset.shelfSearch || "").includes(normalizedQuery);
    card.hidden = !matches;
    if (matches) matched += 1;
  });
  const result = document.querySelector("#shelf-search-result");
  if (result) {
    result.hidden = !normalizedQuery;
    result.textContent = `找到 ${matched} 本`;
  }
  const empty = document.querySelector("#shelf-filter-empty");
  if (empty) empty.hidden = matched > 0;
  const clear = document.querySelector("#shelf-query-clear");
  if (clear) clear.hidden = !normalizedQuery;
}

function clearShelfSearch() {
  shelfQuery = "";
  const input = document.querySelector("#shelf-query");
  if (input) input.value = "";
  filterShelfBooks("");
  input?.focus();
}

function emptyShelf() {
  return `<section class="empty-state shelf-empty"><div class="empty-icon">⌁</div><h2>书架还是空的</h2><p>从“文件”导入一本 TXT，清如许会只保存在这台设备中。</p><button class="primary-button" data-action="import">导入第一本小说</button></section>`;
}

function searchScreen() {
  return shell(`
    <header class="topbar"><div class="brand"><span class="brand-mark">清</span>找书</div><button class="icon-button" data-nav="shelf" aria-label="回到书架">⌂</button></header>
    <h1>去找下一本故事</h1><p class="subtle">输入书名或作者，清如许会查询已接入的合规书源。</p>
    <form class="search-box" id="search-form"><span>⌕</span><input id="book-query" placeholder="书名、作者或关键词" autocomplete="off" /><button aria-label="搜索">搜</button></form>
    <div class="filter-row"><button class="chip active">全部</button><button class="chip">可读</button><button class="chip">完结</button><button class="chip">连载</button></div>
    <div class="notice">这是原型搜索结果。正式版只显示已授权或公版内容，不收录未获许可的第三方小说站。</div>
    <div class="result-list" id="result-list">${sourceSamples.map(resultCard).join("")}</div>
  `, "search");
}

function resultCard(item) {
  return `<article class="result-card"><div class="result-cover">${escapeHTML(item.title.slice(0, 6))}</div><div><div class="result-title">${escapeHTML(item.title)}</div><div class="result-meta">${escapeHTML(item.author)} · ${escapeHTML(item.status)}</div><span class="source-tag">${escapeHTML(item.source)}</span></div><button class="add-button" data-add-source="${item.id}">加入</button></article>`;
}

function settingsScreen() {
  const themeName = { bamboo: "竹影绿", paper: "纸本白", night: "松烟夜" }[settings.theme];
  return shell(`
    <header class="topbar"><div class="brand"><span class="brand-mark">清</span>我的</div><button class="icon-button" data-nav="shelf" aria-label="回到书架">⌂</button></header>
    <h1>安静地读</h1><p class="subtle">不登录、不上传书架和阅读记录；它们只保存在这台设备的浏览器中。</p>
    <div class="settings-group">
      <article class="settings-card"><h3>阅读主题</h3><p>当前：${themeName}</p><div class="theme-options"><button class="theme-choice ${settings.theme === "bamboo" ? "selected" : ""}" data-theme="bamboo" aria-label="竹影绿"></button><button class="theme-choice ${settings.theme === "paper" ? "selected" : ""}" data-theme="paper" aria-label="纸本白"></button><button class="theme-choice ${settings.theme === "night" ? "selected" : ""}" data-theme="night" aria-label="松烟夜"></button></div></article>
      <article class="settings-card"><h3>阅读方式</h3><p>默认左右翻页。点击阅读页中央可打开目录、书签和字号调整。</p></article>
      <article class="settings-card"><h3>本地导入</h3><p>支持 UTF-8、GB18030、UTF-16 TXT；会在浏览器本地保存副本，不会移动或删除原文件。EPUB 阅读将在原生 App 阶段支持。</p><button class="primary-button" data-action="import">导入 TXT</button></article>
      <article class="settings-card backup-card"><h3>书架备份</h3><p>把小说、进度、书签和阅读设置保存成一个本地文件。恢复时会安全合并，不清空现有书架。</p><span class="backup-summary">当前 ${library.length} 本书 · 不需要账号</span><div class="backup-actions"><button class="secondary-button" data-backup-action="choose">恢复备份</button><button class="primary-button" data-backup-action="export">导出备份</button></div></article>
      <article class="settings-card"><h3>原型说明</h3><p>这个版本用于确认体验和视觉。联网找书为界面演示，尚未连接真实书源。</p></article>
    </div>
  `, "settings");
}

function readerScreen() {
  const book = currentBook();
  if (!book) { view = "shelf"; return shelfScreen(); }
  const chapter = book.chapters[reader.chapter] || book.chapters[0];
  const pages = paginate(chapter.text, settings.fontSize);
  reader.page = Math.max(0, Math.min(reader.page, pages.length - 1));
  const progress = Math.round(calculateReadingProgress(book, reader.chapter, reader.page, pages) * 100);
  const fontFamily = settings.fontFamily === "song" ? "Songti SC, STSong, serif" : "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif";
  const fontWeight = settings.fontWeight === "regular" ? 520 : 650;
  const lineHeight = ({ compact: 1.72, comfortable: 1.9, relaxed: 2.08 })[settings.lineHeight] || 1.9;
  const bookmarks = getBookBookmarks(book);
  const currentOffset = currentReaderOffset(book, pages);
  const isBookmarked = bookmarks.some((bookmark) => bookmarkMatchesCurrentPosition(book, bookmark, currentOffset));
  const bookmarkLabel = isBookmarked ? "取消书签" : "添加书签";
  const transitionClass = reader.transitionDirection ? `page-turn-${settings.pageTurn}-${reader.transitionDirection}` : "";
  return `<section class="reader theme-${settings.theme} ${reader.menuOpen ? "menu-open" : ""}" style="--reader-font-size:${settings.fontSize}px;--reader-font-family:${fontFamily};--reader-font-weight:${fontWeight};--reader-line-height:${lineHeight}">
    <header class="reader-header"><button class="icon-button" data-reader-action="back" aria-label="返回书架">‹</button><span class="reader-chapter-label">${escapeHTML(chapter.title)}</span>${readerStatusMarkup()}</header>
    <div class="reader-top-menu ${reader.menuOpen ? "open" : ""}"><button class="reader-bookmark-action ${isBookmarked ? "active" : ""}" data-reader-action="toggle-bookmark"><span aria-hidden="true">${isBookmarked ? "◆" : "◇"}</span><strong>${bookmarkLabel}</strong>${bookmarks.length ? `<em>${bookmarks.length}</em>` : ""}</button></div>
    <div class="reader-menu ${reader.menuOpen ? "open" : ""}" id="reader-menu">
      <div class="reader-settings ${reader.settingsOpen ? "open" : ""}">
        <div class="reader-settings-row"><span>字体</span><div class="reader-settings-control"><button class="${settings.fontFamily === "sans" ? "active" : ""}" data-reader-action="font-sans">黑体</button><button class="${settings.fontFamily === "song" ? "active" : ""}" data-reader-action="font-song">宋体</button></div></div>
        <div class="reader-settings-row"><span>字重</span><div class="reader-settings-control"><button class="${settings.fontWeight === "regular" ? "active" : ""}" data-reader-action="weight-regular">标准</button><button class="${settings.fontWeight !== "regular" ? "active" : ""}" data-reader-action="weight-strong">加粗</button></div></div>
        <div class="reader-settings-row"><span>字号</span><div class="reader-settings-control"><button data-reader-action="font-down">A−</button><span class="font-name">${settings.fontSize}px</span><button data-reader-action="font-up">A+</button></div></div>
        <div class="reader-settings-row"><span>行距</span><div class="reader-settings-control"><button class="${settings.lineHeight === "compact" ? "active" : ""}" data-reader-action="line-compact">紧凑</button><button class="${settings.lineHeight === "comfortable" ? "active" : ""}" data-reader-action="line-comfortable">舒适</button><button class="${settings.lineHeight === "relaxed" ? "active" : ""}" data-reader-action="line-relaxed">宽松</button></div></div>
        <div class="reader-settings-row"><span>翻页</span><div class="reader-settings-control"><button class="${settings.pageTurn === "slide" ? "active" : ""}" data-reader-action="turn-slide">平滑</button><button class="${settings.pageTurn === "cover" ? "active" : ""}" data-reader-action="turn-cover">覆盖</button><button class="${settings.pageTurn === "fade" ? "active" : ""}" data-reader-action="turn-fade">淡入</button></div></div>
        <div class="reader-settings-row"><span>背景</span><div class="reader-settings-control"><button class="swatch bamboo ${settings.theme === "bamboo" ? "active" : ""}" data-reader-action="theme-bamboo" aria-label="竹青背景"></button><button class="swatch paper ${settings.theme === "paper" ? "active" : ""}" data-reader-action="theme-paper" aria-label="纸白背景"></button><button class="swatch night ${settings.theme === "night" ? "active" : ""}" data-reader-action="theme-night" aria-label="松烟夜背景"></button></div></div>
      </div>
      <div class="reader-toolbar"><button class="reader-tool chapter-tool" data-reader-action="previous-chapter"><span class="tool-icon">‹</span><span>上一章</span></button><button class="reader-tool" data-reader-action="chapters"><span class="tool-icon">☷</span><span>目录</span></button><button class="reader-tool" data-reader-action="toggle-theme"><span class="tool-icon">${settings.theme === "night" ? "☀" : "☾"}</span><span>${settings.theme === "night" ? "白天" : "夜间"}</span></button><button class="reader-tool" data-reader-action="settings"><span class="tool-icon settings-icon">⚙</span><span>设置</span></button><button class="reader-tool chapter-tool" data-reader-action="next-chapter"><span class="tool-icon">›</span><span>下一章</span></button></div>
    </div>
    <article class="reader-page ${reader.menuOpen ? "with-controls" : ""} ${reader.settingsOpen ? "with-settings" : ""} ${transitionClass}" id="reader-page"><button class="tap-zone prev" aria-label="上一页"></button><button class="tap-zone next" aria-label="下一页"></button>${reader.page === 0 ? `<h1>${escapeHTML(chapter.title)}</h1>` : ""}<div class="reader-text">${escapeHTML(pages[reader.page])}</div></article>
    <footer class="reader-bottom"><div class="reader-progress"><span style="width:${progress}%"></span></div><div class="reader-footer"><span>${reader.page + 1} / ${pages.length}</span><span>${progress}%</span></div></footer>
  </section>${chapterSheet(book)}`;
}

function formatReaderTime() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function formattedBatteryLevel() {
  if (!Number.isFinite(readerBatteryLevel)) return "";
  const level = Math.round(clamp(readerBatteryLevel, 0, 1) * 100);
  return `${readerBatteryCharging ? "⚡" : "▱"} ${level}%`;
}

function readerStatusMarkup() {
  const time = formatReaderTime();
  const battery = formattedBatteryLevel();
  const label = battery ? `当前时间 ${time}，电量 ${battery.replace(/[^0-9%]/g, "")}` : `当前时间 ${time}`;
  return `<span class="reader-device-status" data-reader-status aria-label="${label}"><time data-reader-clock>${time}</time><span class="reader-battery" data-reader-battery ${battery ? "" : "hidden"}>${battery}</span></span>`;
}

function updateReaderStatus() {
  const time = formatReaderTime();
  const battery = formattedBatteryLevel();
  document.querySelectorAll("[data-reader-clock]").forEach((element) => { element.textContent = time; });
  document.querySelectorAll("[data-reader-battery]").forEach((element) => {
    element.hidden = !battery;
    element.textContent = battery;
  });
  document.querySelectorAll("[data-reader-status]").forEach((element) => {
    element.setAttribute("aria-label", battery ? `当前时间 ${time}，电量 ${battery.replace(/[^0-9%]/g, "")}` : `当前时间 ${time}`);
  });
}

function syncReaderStatus() {
  clearTimeout(readerClockTimer);
  if (view !== "reader") return;
  updateReaderStatus();
  const delay = 30000 - (Date.now() % 30000) + 20;
  readerClockTimer = setTimeout(syncReaderStatus, delay);
}

function initializeBatteryStatus() {
  if (!navigator.getBattery || batteryManager) return;
  navigator.getBattery().then((battery) => {
    batteryManager = battery;
    const refresh = () => {
      readerBatteryLevel = battery.level;
      readerBatteryCharging = battery.charging;
      updateReaderStatus();
    };
    battery.addEventListener("levelchange", refresh);
    battery.addEventListener("chargingchange", refresh);
    refresh();
  }).catch(() => {});
}

function chapterSheet(book) {
  const showingBookmarks = reader.sheetTab === "bookmarks";
  const query = reader.chapterQuery || "";
  const bookmarks = getBookBookmarks(book);
  const descending = reader.chapterOrder === "desc";
  const chapterEntries = book.chapters.map((chapter, index) => ({ chapter, index }));
  if (descending) chapterEntries.reverse();
  const content = showingBookmarks ? bookmarkPanel(book, bookmarks) : `<div class="chapter-search"><span aria-hidden="true">⌕</span><input id="chapter-search" value="${escapeHTML(query)}" placeholder="搜索章节" autocomplete="off" enterkeyhint="search" /></div><div class="chapter-directory-meta"><span id="chapter-result-meta">共 ${book.chapters.length} 章 · 当前第 ${reader.chapter + 1} 章</span><button data-reader-action="toggle-chapter-order" aria-label="切换目录顺序">${descending ? "倒序 ↓" : "正序 ↑"}</button></div><p class="chapter-search-empty" id="chapter-search-empty" hidden>没有匹配的章节</p><div class="chapter-list" id="chapter-list">${chapterEntries.map(({ chapter, index }) => `<button class="${index === reader.chapter ? "active" : ""}" data-chapter="${index}"><span>${escapeHTML(chapter.title)}</span>${index === reader.chapter ? `<em>正在读</em>` : ""}</button>`).join("")}</div>`;
  return `<aside class="sheet" id="chapter-sheet" ${reader.sheetOpen ? "" : "hidden"}><button class="sheet-backdrop" data-reader-action="close-chapters" aria-label="关闭目录并返回阅读"></button><div class="sheet-content"><div class="sheet-handle"></div><div class="sheet-head"><div><h2>${escapeHTML(book.title)}</h2><p class="subtle">目录与书签</p></div><button class="close" data-reader-action="close-chapters" aria-label="关闭目录">×</button></div><div class="chapter-tabs"><button class="${showingBookmarks ? "" : "active"}" data-reader-action="show-chapters">目录</button><button class="${showingBookmarks ? "active" : ""}" data-reader-action="show-bookmarks">书签${bookmarks.length ? ` (${bookmarks.length})` : ""}</button></div>${content}</div></aside>`;
}

function getBookBookmarks(book) {
  return Array.isArray(book.bookmarks) ? [...book.bookmarks].sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0)) : [];
}

function bookmarkPanel(book, bookmarks) {
  if (!bookmarks.length) return `<div class="bookmark-empty"><span>⌑</span><strong>还没有书签</strong><p>阅读时点一下页面，再用顶部按钮收藏当前页。</p></div>`;
  return `<div class="bookmark-list">${bookmarks.map((bookmark) => {
    const title = book.chapters[bookmark.chapter]?.title || bookmark.chapterTitle || "章节已变更";
    const location = resolveReadingPage(book, bookmark);
    return `<div class="bookmark-item"><button data-bookmark="${escapeHTML(bookmark.id)}"><strong>${escapeHTML(title)}</strong><span>第 ${Math.max(1, location.page + 1)} 页</span>${bookmark.excerpt ? `<em>${escapeHTML(bookmark.excerpt)}</em>` : ""}</button><button class="bookmark-delete" data-remove-bookmark="${escapeHTML(bookmark.id)}" aria-label="删除书签">×</button></div>`;
  }).join("")}</div>`;
}

function paginate(text, fontSize) {
  const source = String(text || "");
  if (!source.trim()) return ["暂无正文。"]; 
  const normalizedFontSize = clamp(Number(fontSize) || 19, 16, 40);
  const signature = [normalizedFontSize, settings.fontFamily, settings.fontWeight, settings.lineHeight, window.innerWidth, readerViewportHeight].join("|");
  const cachedIndex = paginationCache.findIndex((entry) => entry.text === source && entry.signature === signature);
  if (cachedIndex >= 0) {
    const [cached] = paginationCache.splice(cachedIndex, 1);
    paginationCache.unshift(cached);
    return cached.pages;
  }
  const pages = paginateByVisibleHeight(source, normalizedFontSize);
  paginationCache.unshift({ text: source, signature, pages });
  if (paginationCache.length > 24) paginationCache.pop();
  return pages;
}

function paginateByVisibleHeight(source, fontSize) {
  const fontFamily = settings.fontFamily === "song" ? "Songti SC, STSong, serif" : "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif";
  const fontWeight = settings.fontWeight === "regular" ? 520 : 650;
  const lineHeight = ({ compact: 1.72, comfortable: 1.9, relaxed: 2.08 })[settings.lineHeight] || 1.9;
  const probe = document.createElement("section");
  probe.className = "reader pagination-probe";
  probe.style.cssText = `--reader-font-size:${fontSize}px;--reader-font-family:${fontFamily};--reader-font-weight:${fontWeight};--reader-line-height:${lineHeight}`;
  probe.innerHTML = `<header class="reader-header"></header><article class="reader-page"><h1>章节标题</h1><div class="reader-text"></div></article><footer class="reader-bottom"><div class="reader-progress"><span></span></div><div class="reader-footer"><span>1 / 1</span><span>0%</span></div></footer>`;
  document.body.appendChild(probe);
  const pageBox = probe.querySelector(".reader-page");
  const heading = probe.querySelector("h1");
  const textBox = probe.querySelector(".reader-text");
  if (!pageBox || !heading || !textBox || pageBox.clientHeight < 120) {
    probe.remove();
    return paginateByEstimate(source, fontSize);
  }
  const fits = (value, firstPage) => {
    heading.style.display = firstPage ? "" : "none";
    textBox.textContent = value;
    return pageBox.scrollHeight <= pageBox.clientHeight + 1;
  };
  const pages = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (cursor >= source.length) break;
    let low = cursor + 1;
    let high = source.length;
    let best = cursor;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(source.slice(cursor, middle).trimEnd(), pages.length === 0)) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best <= cursor) best = cursor + 1;
    const end = naturalPageBreak(source, cursor, best);
    const content = source.slice(cursor, end).trim();
    if (content) pages.push(content);
    cursor = Math.max(end, cursor + 1);
  }
  probe.remove();
  return pages.length ? pages : ["暂无正文。"]; 
}

function naturalPageBreak(text, start, fittedEnd) {
  if (fittedEnd >= text.length) return text.length;
  const minimum = start + Math.floor((fittedEnd - start) * .76);
  for (let index = fittedEnd; index > minimum; index -= 1) {
    const character = text[index - 1];
    if (character === "\n" || /[。！？；…]/.test(character)) return index;
  }
  return fittedEnd;
}

function paginateByEstimate(source, fontSize) {
  const baseCapacity = Math.round(180 * Math.pow(19 / fontSize, 1.7));
  const lineFactor = ({ compact: 1.08, comfortable: .92, relaxed: .78 })[settings.lineHeight] || .92;
  const perPage = Math.max(30, Math.round(baseCapacity * lineFactor));
  const pages = [];
  let cursor = 0;
  while (cursor < source.length) {
    const firstPageAllowance = pages.length === 0 ? .76 : 1;
    const fittedEnd = Math.min(source.length, cursor + Math.max(24, Math.floor(perPage * firstPageAllowance)));
    const end = naturalPageBreak(source, cursor, fittedEnd);
    const content = source.slice(cursor, end).trim();
    if (content) pages.push(content);
    cursor = Math.max(end, cursor + 1);
  }
  return pages.length ? pages : ["暂无正文。"]; 
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

function pageStartOffset(text, pages, page) {
  const target = clamp(Number(page) || 0, 0, Math.max(0, pages.length - 1));
  let cursor = 0;
  for (let index = 0; index <= target; index += 1) {
    const content = pages[index] || "";
    const found = text.indexOf(content, cursor);
    const start = found >= 0 ? found : cursor;
    if (index === target) return clamp(start, 0, text.length);
    cursor = clamp(start + content.length, 0, text.length);
  }
  return 0;
}

function pageForCharacterOffset(text, pages, offset) {
  const target = clamp(Number(offset) || 0, 0, text.length);
  let cursor = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const content = pages[index] || "";
    const found = text.indexOf(content, cursor);
    const start = found >= 0 ? found : cursor;
    const end = clamp(start + content.length, start, text.length);
    // At an exact page boundary, resume on the new page rather than showing
    // the final line of the previous one again. The last page still owns the
    // document-end offset.
    if (target < end || index === pages.length - 1) return index;
    cursor = end;
  }
  return 0;
}

function approximateReadingPosition(book) {
  if (!book?.chapters?.length || !(book.progress > 0)) return { chapter: 0, charOffset: 0 };
  const totalLength = book.chapters.reduce((sum, chapter) => sum + chapter.text.length, 0);
  let remaining = Math.floor(totalLength * clamp(book.progress, 0, 1));
  for (let index = 0; index < book.chapters.length; index += 1) {
    const length = book.chapters[index].text.length;
    if (remaining <= length || index === book.chapters.length - 1) return { chapter: index, charOffset: clamp(remaining, 0, length) };
    remaining -= length;
  }
  return { chapter: 0, charOffset: 0 };
}

function resolveReadingPage(book, position) {
  const fallback = approximateReadingPosition(book);
  const requestedChapter = Number(position?.chapter);
  const chapterIndex = clamp(Number.isFinite(requestedChapter) ? requestedChapter : fallback.chapter, 0, Math.max(0, book.chapters.length - 1));
  const chapter = book.chapters[chapterIndex];
  const pages = paginate(chapter.text, settings.fontSize);
  if (Number.isFinite(position?.charOffset)) return { chapter: chapterIndex, page: pageForCharacterOffset(chapter.text, pages, position.charOffset) };
  if (Number.isFinite(position?.page)) {
    const previousPageCount = Math.max(1, Number(position.pageCount) || pages.length);
    return { chapter: chapterIndex, page: clamp(Math.round((position.page / Math.max(1, previousPageCount - 1)) * Math.max(0, pages.length - 1)), 0, Math.max(0, pages.length - 1)) };
  }
  return { chapter: chapterIndex, page: pageForCharacterOffset(chapter.text, pages, fallback.charOffset) };
}

function currentReaderOffset(book, pages) {
  const chapter = book?.chapters?.[reader.chapter];
  if (!chapter) return 0;
  const fallback = pageStartOffset(chapter.text, pages, reader.page);
  return Number.isFinite(reader.anchorOffset) ? clamp(reader.anchorOffset, 0, chapter.text.length) : fallback;
}

function setReaderAnchorFromPage(book) {
  const chapter = book?.chapters?.[reader.chapter];
  if (!chapter) { reader.anchorOffset = 0; return; }
  const pages = paginate(chapter.text, settings.fontSize);
  reader.page = clamp(reader.page, 0, Math.max(0, pages.length - 1));
  reader.anchorOffset = pageStartOffset(chapter.text, pages, reader.page);
}

function bookmarkMatchesCurrentPosition(book, bookmark, currentOffset) {
  if (bookmark.chapter !== reader.chapter) return false;
  if (Number.isFinite(bookmark.charOffset)) return bookmark.charOffset === currentOffset;
  return resolveReadingPage(book, bookmark).page === reader.page;
}

function calculateReadingProgress(book, chapterIndex, page, pages) {
  const totalLength = Math.max(1, book.chapters.reduce((sum, chapter) => sum + chapter.text.length, 0));
  const before = book.chapters.slice(0, chapterIndex).reduce((sum, chapter) => sum + chapter.text.length, 0);
  const chapter = book.chapters[chapterIndex];
  const start = pageStartOffset(chapter.text, pages, page);
  const currentPageLength = (pages[page] || "").length;
  const visibleEnd = clamp(start + currentPageLength, start, chapter.text.length);
  return clamp((before + visibleEnd) / totalLength, 0, 1);
}

function bindEvents() {
  document.querySelectorAll("[data-nav]").forEach((el) => el.addEventListener("click", () => { view = el.dataset.nav; render(); }));
  document.querySelectorAll("[data-open-book]:not(.book-card)").forEach((el) => el.addEventListener("click", () => openBook(el.dataset.openBook)));
  document.querySelectorAll(".book-card[data-open-book]").forEach(bindBookCardGesture);
  const shelfSearch = document.querySelector("#shelf-query");
  if (shelfSearch) {
    shelfSearch.addEventListener("input", () => {
      shelfQuery = shelfSearch.value;
      filterShelfBooks(shelfQuery);
    });
    filterShelfBooks(shelfQuery);
  }
  document.querySelectorAll("[data-shelf-sort]").forEach((el) => el.addEventListener("click", () => {
    const nextSort = el.dataset.shelfSort;
    if (!["recent", "imported", "title"].includes(nextSort) || nextSort === settings.shelfSort) return;
    settings.shelfSort = nextSort;
    persistSettings();
    render();
  }));
  document.querySelectorAll("[data-shelf-control='clear-search']").forEach((el) => el.addEventListener("click", () => clearShelfSearch()));
  document.querySelectorAll("[data-action='import']").forEach((el) => el.addEventListener("click", openImportFlow));
  document.querySelectorAll("[data-import-action]").forEach((el) => el.addEventListener("click", () => handleImportAction(el.dataset.importAction)));
  document.querySelectorAll("[data-backup-action]").forEach((el) => el.addEventListener("click", () => handleBackupAction(el.dataset.backupAction)));
  document.querySelectorAll("[data-shelf-action]").forEach((el) => el.addEventListener("click", () => handleShelfAction(el.dataset.shelfAction)));
  document.querySelectorAll("[data-cover-index]").forEach((el) => el.addEventListener("click", () => { const candidate = shelfAction.coverCandidates?.[Number(el.dataset.coverIndex)]; if (candidate) void saveMatchedCover(shelfAction.bookId, candidate.coverId); }));
  const shelfEditForm = document.querySelector("#shelf-edit-form");
  if (shelfEditForm) shelfEditForm.addEventListener("submit", (event) => { event.preventDefault(); void saveBookInfo(shelfAction.bookId); });
  const encodingControl = document.querySelector("[data-import-encoding]");
  if (encodingControl) encodingControl.addEventListener("change", () => { importSession.encoding = encodingControl.value; });
  document.querySelectorAll("[data-add-source]").forEach((el) => el.addEventListener("click", () => addDemoSource(el.dataset.addSource)));
  document.querySelectorAll("[data-theme]").forEach((el) => el.addEventListener("click", () => { settings.theme = el.dataset.theme; persist(); render(); }));
  const form = document.querySelector("#search-form");
  if (form) form.addEventListener("submit", searchDemo);
  document.querySelectorAll("[data-reader-action]").forEach((el) => el.addEventListener("click", () => readerAction(el.dataset.readerAction)));
  document.querySelectorAll("[data-chapter]").forEach((el) => el.addEventListener("click", () => goToChapter(Number(el.dataset.chapter))));
  document.querySelectorAll("[data-bookmark]").forEach((el) => el.addEventListener("click", () => goToBookmark(el.dataset.bookmark)));
  document.querySelectorAll("[data-remove-bookmark]").forEach((el) => el.addEventListener("click", () => removeBookmark(el.dataset.removeBookmark)));
  const chapterSearch = document.querySelector("#chapter-search");
  if (chapterSearch) {
    const applyChapterSearch = () => {
      reader.chapterQuery = chapterSearch.value;
      filterChapterList(reader.chapterQuery);
    };
    chapterSearch.addEventListener("input", applyChapterSearch);
    chapterSearch.addEventListener("search", applyChapterSearch);
    chapterSearch.addEventListener("compositionend", applyChapterSearch);
    filterChapterList(reader.chapterQuery || "");
    if (!(reader.chapterQuery || "").trim()) requestAnimationFrame(() => document.querySelector(".chapter-list button.active:not([hidden])")?.scrollIntoView({ block: "center" }));
  }
  const chapterBackdrop = document.querySelector("#chapter-sheet .sheet-backdrop");
  if (chapterBackdrop) chapterBackdrop.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
  const readerPage = document.querySelector("#reader-page");
  if (readerPage) bindSwipe(readerPage);
}

function bindBookCardGesture(card) {
  let longPressTimer;
  let longPressTriggered = false;
  let startX = 0;
  let startY = 0;
  const clearLongPress = () => { clearTimeout(longPressTimer); longPressTimer = undefined; };
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    longPressTriggered = false;
    startX = event.clientX;
    startY = event.clientY;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      openShelfAction(card.dataset.openBook);
      if (navigator.vibrate) navigator.vibrate(8);
    }, 520);
  });
  card.addEventListener("pointermove", (event) => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) clearLongPress();
  });
  card.addEventListener("pointerup", clearLongPress);
  card.addEventListener("pointercancel", clearLongPress);
  card.addEventListener("pointerleave", clearLongPress);
  card.addEventListener("contextmenu", (event) => { event.preventDefault(); openShelfAction(card.dataset.openBook); });
  card.addEventListener("click", (event) => {
    if (longPressTriggered) {
      event.preventDefault();
      event.stopPropagation();
      longPressTriggered = false;
      return;
    }
    openBook(card.dataset.openBook);
  });
}

function openShelfAction(bookId) {
  if (!libraryReady) { showToast("书架正在准备，请稍后"); return; }
  const book = library.find((item) => item.id === bookId);
  if (!book) return;
  shelfAction = { visible: true, phase: "menu", bookId, title: book.title, error: "" };
  render();
}

function handleShelfAction(action) {
  if (action === "close") { shelfAction = emptyShelfAction(); render(); return; }
  if (action === "edit") { shelfAction = { ...shelfAction, phase: "edit", error: "" }; render(); requestAnimationFrame(() => document.querySelector("#shelf-edit-title")?.focus()); return; }
  if (action === "match-cover") { void matchOnlineCover(shelfAction.bookId); return; }
  if (action === "generate-cover") { void saveGeneratedCover(shelfAction.bookId); return; }
  if (action === "remove-cover") { void saveMatchedCover(shelfAction.bookId, null); return; }
  if (action === "confirm-remove") { shelfAction = { ...shelfAction, phase: "confirm", error: "" }; render(); return; }
  if (action === "confirm-clean") { shelfAction = { ...shelfAction, phase: "clean-confirm", error: "" }; render(); return; }
  if (action === "remove") void removeBookFromShelf(shelfAction.bookId);
  if (action === "clean") void cleanBookPromotions(shelfAction.bookId);
}

function coverSearchAuthor(book) {
  const author = String(book?.author || "").trim();
  return /^(?:本地导入|未知作者|清如许原型)$/.test(author) ? "" : author;
}

async function matchOnlineCover(bookId) {
  const book = library.find((item) => item.id === bookId);
  if (!book) { shelfAction = emptyShelfAction(); render(); return; }
  shelfAction = { ...shelfAction, phase: "matching-cover", error: "", coverCandidates: [] };
  render();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const author = coverSearchAuthor(book);
    const parameters = new URLSearchParams({ title: book.title, fields: "key,title,author_name,cover_i", limit: "12", lang: "zh" });
    if (author) parameters.set("author", author);
    const response = await fetch(`https://openlibrary.org/search.json?${parameters}`, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`cover-http-${response.status}`);
    const payload = await response.json();
    const seen = new Set();
    const candidates = (Array.isArray(payload.docs) ? payload.docs : []).map((item) => ({
      coverId: Math.max(0, Math.trunc(Number(item.cover_i) || 0)),
      title: String(item.title || book.title).slice(0, 100),
      author: String(Array.isArray(item.author_name) ? item.author_name[0] || "" : "").slice(0, 80)
    })).filter((item) => item.coverId && !seen.has(item.coverId) && seen.add(item.coverId)).slice(0, 6);
    if (!candidates.length) {
      await saveGeneratedCover(bookId, true);
      return;
    }
    shelfAction = { ...shelfAction, phase: "cover-results", coverCandidates: candidates, error: "" };
  } catch (error) {
    const message = error?.name === "AbortError" ? "网络响应时间过长" : "暂时无法连接封面服务";
    shelfAction = { ...shelfAction, phase: "cover-error", coverCandidates: [], error: message };
  } finally {
    clearTimeout(timeout);
  }
  render();
}

async function saveMatchedCover(bookId, coverId) {
  const book = library.find((item) => item.id === bookId);
  if (!book) { shelfAction = emptyShelfAction(); render(); return; }
  const previousCoverId = book.coverId;
  const previousCoverStyle = book.coverStyle;
  const previousMetadataUpdatedAt = book.metadataUpdatedAt;
  shelfAction = { ...shelfAction, phase: "saving-cover", error: "" };
  render();
  if (coverId) {
    book.coverId = Math.max(0, Math.trunc(Number(coverId) || 0));
    delete book.coverStyle;
  } else {
    delete book.coverId;
    delete book.coverStyle;
  }
  book.metadataUpdatedAt = Date.now();
  if (!(await persist())) {
    if (previousCoverId) book.coverId = previousCoverId;
    else delete book.coverId;
    if (previousCoverStyle) book.coverStyle = previousCoverStyle;
    else delete book.coverStyle;
    book.metadataUpdatedAt = previousMetadataUpdatedAt;
    shelfAction = { ...shelfAction, phase: "cover-error", error: "暂时无法保存这张封面" };
    render();
    return;
  }
  shelfAction = emptyShelfAction();
  render();
  showToast(coverId ? "封面已更新" : "已恢复文字封面");
}

async function saveGeneratedCover(bookId, automatic = false) {
  const book = library.find((item) => item.id === bookId);
  if (!book) { shelfAction = emptyShelfAction(); render(); return; }
  const previousCoverId = book.coverId;
  const previousCoverStyle = book.coverStyle;
  const previousMetadataUpdatedAt = book.metadataUpdatedAt;
  const baseStyle = Number(book.coverStyle) > 0 ? Math.trunc(Number(book.coverStyle)) : generatedCoverIndex(book) + 1;
  const nextStyle = Number(book.coverStyle) > 0 ? (baseStyle % generatedCoverThemes.length) + 1 : baseStyle;
  shelfAction = { ...shelfAction, phase: "saving-cover", error: "" };
  render();
  delete book.coverId;
  book.coverStyle = nextStyle;
  book.metadataUpdatedAt = Date.now();
  if (!(await persist())) {
    if (previousCoverId) book.coverId = previousCoverId;
    else delete book.coverId;
    if (previousCoverStyle) book.coverStyle = previousCoverStyle;
    else delete book.coverStyle;
    book.metadataUpdatedAt = previousMetadataUpdatedAt;
    shelfAction = { ...shelfAction, phase: "cover-error", error: "暂时无法保存生成的封面" };
    render();
    return;
  }
  shelfAction = emptyShelfAction();
  render();
  showToast(automatic ? "未找到公开封面，已生成专属封面" : "专属封面已生成");
}

async function saveBookInfo(bookId) {
  const book = library.find((item) => item.id === bookId);
  if (!book) { shelfAction = emptyShelfAction(); render(); return; }
  const title = String(document.querySelector("#shelf-edit-title")?.value || "").trim().slice(0, 80);
  const author = String(document.querySelector("#shelf-edit-author")?.value || "").trim().slice(0, 60) || "未知作者";
  if (!title) {
    shelfAction = { ...shelfAction, phase: "edit", error: "书名不能为空。" };
    render();
    requestAnimationFrame(() => document.querySelector("#shelf-edit-title")?.focus());
    return;
  }
  if (title === book.title && author === (book.author || "未知作者")) { shelfAction = emptyShelfAction(); render(); return; }
  const snapshot = { title: book.title, author: book.author, metadataUpdatedAt: book.metadataUpdatedAt };
  shelfAction = { ...shelfAction, phase: "saving-edit", error: "" };
  render();
  book.title = title;
  book.author = author;
  book.metadataUpdatedAt = Date.now();
  if (!(await persist())) {
    book.title = snapshot.title;
    book.author = snapshot.author;
    book.metadataUpdatedAt = snapshot.metadataUpdatedAt;
    shelfAction = { ...shelfAction, phase: "edit", error: "暂时无法保存修改，请稍后重试。" };
    render();
    return;
  }
  shelfAction = emptyShelfAction();
  render();
  showToast(`已更新《${title}》`);
}

async function removeBookFromShelf(bookId) {
  const book = library.find((item) => item.id === bookId);
  if (!book) { shelfAction = emptyShelfAction(); render(); return; }
  const previousLibrary = library;
  shelfAction = { ...shelfAction, phase: "removing", error: "" };
  render();
  library = library.filter((item) => item.id !== bookId);
  if (!(await persist())) {
    library = previousLibrary;
    shelfAction = { ...shelfAction, phase: "confirm", error: "暂时无法保存这次变更，请稍后重试。" };
    render();
    return;
  }
  shelfAction = emptyShelfAction();
  render();
  showToast(`已将《${book.title}》移出书架`);
}

function remapCleanedBookLocations(book, previousChapters) {
  const remapOffset = (chapterIndex, oldOffset) => {
    const previousText = previousChapters[chapterIndex]?.text || "";
    const nextText = book.chapters[chapterIndex]?.text || "";
    const safeOffset = clamp(Number(oldOffset) || 0, 0, previousText.length);
    const nearbyText = previousText.slice(safeOffset, safeOffset + 80).trim();
    const found = nearbyText.length >= 8 ? nextText.indexOf(nearbyText) : -1;
    return found >= 0 ? found : clamp(safeOffset, 0, nextText.length);
  };
  const remapPosition = (position) => {
    if (!position || !book.chapters.length) return position;
    const chapterIndex = clamp(Number(position.chapter) || 0, 0, book.chapters.length - 1);
    const previousPages = paginate(previousChapters[chapterIndex]?.text || "", settings.fontSize);
    const originalOffset = Number.isFinite(position.charOffset) ? position.charOffset : pageStartOffset(previousChapters[chapterIndex]?.text || "", previousPages, position.page);
    const charOffset = remapOffset(chapterIndex, originalOffset);
    const nextPages = paginate(book.chapters[chapterIndex].text, settings.fontSize);
    return { ...position, chapter: chapterIndex, charOffset, page: pageForCharacterOffset(book.chapters[chapterIndex].text, nextPages, charOffset), pageCount: nextPages.length, updatedAt: Date.now() };
  };

  book.readingPosition = remapPosition(book.readingPosition);
  if (book.readingPosition) {
    const currentPages = paginate(book.chapters[book.readingPosition.chapter].text, settings.fontSize);
    book.progress = calculateReadingProgress(book, book.readingPosition.chapter, book.readingPosition.page, currentPages);
  }
  if (Array.isArray(book.bookmarks)) book.bookmarks = book.bookmarks.map(remapPosition);
}

async function cleanBookPromotions(bookId) {
  const book = library.find((item) => item.id === bookId);
  if (!book) { shelfAction = emptyShelfAction(); render(); return; }
  const cleanups = book.chapters.map((chapter) => cleanImportedText(chapter.text));
  const blocks = cleanups.reduce((sum, cleanup) => sum + cleanup.blocks, 0);
  const characters = cleanups.reduce((sum, cleanup) => sum + cleanup.characters, 0);
  if (!blocks) {
    shelfAction = emptyShelfAction();
    render();
    showToast("没有发现可安全清理的推广或导流信息");
    return;
  }
  const snapshot = { chapters: book.chapters, bookmarks: book.bookmarks, readingPosition: book.readingPosition, progress: book.progress, promotionCleanup: book.promotionCleanup };
  shelfAction = { ...shelfAction, phase: "cleaning", error: "" };
  render();
  book.chapters = book.chapters.map((chapter, index) => ({ ...chapter, text: cleanups[index].text }));
  const previousCleanup = book.promotionCleanup || {};
  book.promotionCleanup = { blocks: (Number(previousCleanup.blocks) || 0) + blocks, characters: (Number(previousCleanup.characters) || 0) + characters };
  remapCleanedBookLocations(book, snapshot.chapters);
  if (!(await persist())) {
    book.chapters = snapshot.chapters;
    book.bookmarks = snapshot.bookmarks;
    book.readingPosition = snapshot.readingPosition;
    book.progress = snapshot.progress;
    book.promotionCleanup = snapshot.promotionCleanup;
    shelfAction = { ...shelfAction, phase: "clean-confirm", error: "暂时无法保存这次清理，请稍后重试。" };
    render();
    return;
  }
  shelfAction = emptyShelfAction();
  render();
  showToast(`已清理 ${blocks} 处推广或导流信息`);
}

function openBook(id) {
  const book = library.find((item) => item.id === id);
  if (!book) return;
  const location = resolveReadingPage(book, book.readingPosition);
  const chapter = book.chapters[location.chapter];
  const pages = paginate(chapter.text, settings.fontSize);
  const savedOffset = book.readingPosition?.charOffset;
  const anchorOffset = Number.isFinite(savedOffset) ? clamp(savedOffset, 0, chapter.text.length) : pageStartOffset(chapter.text, pages, location.page);
  reader = { bookId: id, chapter: location.chapter, page: location.page, anchorOffset, menuOpen: false, sheetOpen: false, sheetTab: "chapters", chapterOrder: "asc", chapterQuery: "", settingsOpen: false, transitionDirection: "" };
  view = "reader";
  render();
}

function readerAction(action) {
  if (action === "back") { updateProgress(true); view = "shelf"; render(); return; }
  if (action === "chapters") { reader.sheetOpen = true; reader.sheetTab = "chapters"; reader.chapterQuery = ""; reader.menuOpen = false; reader.settingsOpen = false; render(); return; }
  if (action === "close-chapters") { reader.sheetOpen = false; reader.chapterQuery = ""; reader.menuOpen = true; render(); return; }
  if (action === "show-chapters") { reader.sheetTab = "chapters"; render(); return; }
  if (action === "show-bookmarks") { reader.sheetTab = "bookmarks"; render(); return; }
  if (action === "toggle-chapter-order") { reader.chapterOrder = reader.chapterOrder === "desc" ? "asc" : "desc"; render(); return; }
  if (action === "settings") { reader.settingsOpen = !reader.settingsOpen; render(); return; }
  if (action === "toggle-theme") { settings.theme = settings.theme === "night" ? "bamboo" : "night"; persist(); render(); return; }
  if (action === "theme-bamboo" || action === "theme-paper" || action === "theme-night") { settings.theme = action.replace("theme-", ""); persist(); render(); return; }
  if (action === "font-sans" || action === "font-song") { applyReaderLayout({ fontFamily: action.replace("font-", "") }); return; }
  if (action === "weight-regular" || action === "weight-strong") { applyReaderLayout({ fontWeight: action.replace("weight-", "") }); return; }
  if (action === "font-up") { adjustFontSize(1); return; }
  if (action === "font-down") { adjustFontSize(-1); return; }
  if (action === "line-compact" || action === "line-comfortable" || action === "line-relaxed") { applyReaderLayout({ lineHeight: action.replace("line-", "") }); return; }
  if (action === "turn-slide" || action === "turn-cover" || action === "turn-fade") { settings.pageTurn = action.replace("turn-", ""); persist(); render(); return; }
  if (action === "toggle-bookmark") { toggleBookmark(); return; }
  if (action === "previous-chapter") { previousChapter(); return; }
  if (action === "next-chapter") { nextChapter(); return; }
  if (action === "next") { nextPage(); return; }
  if (action === "prev") { previousPage(); return; }
}

function nextPage() {
  const book = currentBook();
  const pages = paginate(book.chapters[reader.chapter].text, settings.fontSize);
  if (reader.page < pages.length - 1) reader.page += 1;
  else if (reader.chapter < book.chapters.length - 1) { reader.chapter += 1; reader.page = 0; }
  else { showToast("已经读到本书结尾"); return; }
  reader.transitionDirection = "next";
  setReaderAnchorFromPage(book);
  reader.menuOpen = false; reader.settingsOpen = false; updateProgress(); render();
}

function previousPage() {
  const book = currentBook();
  if (reader.page > 0) reader.page -= 1;
  else if (reader.chapter > 0) { reader.chapter -= 1; reader.page = paginate(book.chapters[reader.chapter].text, settings.fontSize).length - 1; }
  else { reader.menuOpen = false; render(); return; }
  reader.transitionDirection = "previous";
  setReaderAnchorFromPage(book);
  reader.menuOpen = false; reader.settingsOpen = false; updateProgress(); render();
}

function previousChapter() {
  if (reader.chapter === 0) { showToast("已经是第一章"); return; }
  const book = currentBook();
  reader.chapter -= 1;
  reader.page = paginate(book.chapters[reader.chapter].text, settings.fontSize).length - 1;
  reader.transitionDirection = "previous";
  setReaderAnchorFromPage(book);
  updateProgress();
  render();
}

function nextChapter() {
  const book = currentBook();
  if (reader.chapter >= book.chapters.length - 1) { showToast("已经是最后一章"); return; }
  reader.chapter += 1;
  reader.page = 0;
  reader.transitionDirection = "next";
  setReaderAnchorFromPage(book);
  updateProgress();
  render();
}

function goToChapter(chapterIndex) {
  const book = currentBook();
  if (!book) return;
  reader.chapter = clamp(chapterIndex, 0, Math.max(0, book.chapters.length - 1));
  reader.page = 0;
  setReaderAnchorFromPage(book);
  reader.sheetOpen = false;
  reader.menuOpen = false;
  reader.settingsOpen = false;
  updateProgress(true);
  render();
}

function filterChapterList(query) {
  const normalized = String(query || "").trim().toLowerCase();
  const buttons = [...document.querySelectorAll("#chapter-list [data-chapter]")];
  let visible = 0;
  buttons.forEach((button) => {
    const match = !normalized || button.textContent.toLowerCase().includes(normalized);
    button.hidden = !match;
    if (match) visible += 1;
  });
  const empty = document.querySelector("#chapter-search-empty");
  if (empty) empty.hidden = visible > 0;
  const meta = document.querySelector("#chapter-result-meta");
  if (meta) meta.textContent = normalized ? `找到 ${visible} 章` : `共 ${buttons.length} 章 · 当前第 ${reader.chapter + 1} 章`;
}

function toggleBookmark() {
  const book = currentBook();
  if (!book) return;
  const pages = paginate(book.chapters[reader.chapter].text, settings.fontSize);
  const bookmarks = Array.isArray(book.bookmarks) ? book.bookmarks : [];
  const charOffset = currentReaderOffset(book, pages);
  const existingIndex = bookmarks.findIndex((bookmark) => bookmarkMatchesCurrentPosition(book, bookmark, charOffset));
  if (existingIndex >= 0) {
    book.bookmarks = bookmarks.filter((_, index) => index !== existingIndex);
    void persist();
    render();
    showToast("已取消书签");
    return;
  }
  const excerpt = (pages[reader.page] || "").replace(/\s+/g, " ").trim().slice(0, 44);
  book.bookmarks = [...bookmarks, {
    id: newBookmarkId(),
    chapter: reader.chapter,
    chapterTitle: book.chapters[reader.chapter].title,
    page: reader.page,
    pageCount: pages.length,
    charOffset,
    excerpt,
    createdAt: Date.now()
  }];
  void persist();
  render();
  showToast("已加入书签");
}

function goToBookmark(bookmarkId) {
  const book = currentBook();
  const bookmark = book?.bookmarks?.find((item) => item.id === bookmarkId);
  if (!book || !bookmark) return;
  const location = resolveReadingPage(book, bookmark);
  reader.chapter = location.chapter;
  reader.page = location.page;
  const chapter = book.chapters[reader.chapter];
  const pages = paginate(chapter.text, settings.fontSize);
  reader.anchorOffset = Number.isFinite(bookmark.charOffset) ? clamp(bookmark.charOffset, 0, chapter.text.length) : pageStartOffset(chapter.text, pages, reader.page);
  reader.sheetOpen = false;
  reader.menuOpen = false;
  reader.settingsOpen = false;
  updateProgress(true);
  render();
}

function removeBookmark(bookmarkId) {
  const book = currentBook();
  if (!book?.bookmarks) return;
  book.bookmarks = book.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
  void persist();
  render();
  showToast("已删除书签");
}

function newBookmarkId() {
  if (globalThis.crypto?.randomUUID) return `bookmark-${globalThis.crypto.randomUUID()}`;
  return `bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function applyReaderLayout(nextSettings) {
  const book = currentBook();
  const chapter = book?.chapters?.[reader.chapter];
  const pagesBefore = chapter ? paginate(chapter.text, settings.fontSize) : null;
  const charOffset = chapter && pagesBefore ? currentReaderOffset(book, pagesBefore) : 0;
  Object.assign(settings, nextSettings);
  if (chapter) {
    const pagesAfter = paginate(chapter.text, settings.fontSize);
    reader.page = pageForCharacterOffset(chapter.text, pagesAfter, charOffset);
    reader.anchorOffset = charOffset;
    updateProgress();
  } else {
    void persist();
  }
  render();
}

function adjustFontSize(delta) {
  const nextSize = clamp(settings.fontSize + delta, 16, 40);
  if (nextSize === settings.fontSize) return;
  applyReaderLayout({ fontSize: nextSize });
}

function updateProgress(immediate = false) {
  const book = currentBook();
  if (!book) return;
  const chapter = book.chapters[reader.chapter];
  const pages = paginate(chapter.text, settings.fontSize);
  reader.page = clamp(reader.page, 0, Math.max(0, pages.length - 1));
  const charOffset = currentReaderOffset(book, pages);
  reader.anchorOffset = charOffset;
  book.readingPosition = { chapter: reader.chapter, page: reader.page, pageCount: pages.length, charOffset, updatedAt: Date.now() };
  book.lastReadAt = Date.now();
  book.progress = calculateReadingProgress(book, reader.chapter, reader.page, pages);
  clearTimeout(progressPersistTimer);
  const isStableStoppingPoint = reader.page === 0 || reader.page === pages.length - 1 || (reader.page + 1) % 3 === 0;
  if (immediate || isStableStoppingPoint) { void persist(); return; }
  progressPersistTimer = setTimeout(() => { void persist(); }, 650);
}

function bindSwipe(element) {
  let startX = 0;
  let startY = 0;
  let trackingPointer = false;
  element.addEventListener("pointerdown", (event) => {
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    // Keep the left iPhone edge free for Safari / PWA's system-back gesture.
    if (event.pointerType === "touch" && event.clientX <= 24) return;
    trackingPointer = true;
    startX = event.clientX;
    startY = event.clientY;
    try { element.setPointerCapture(event.pointerId); } catch {}
  });
  element.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
  element.addEventListener("dblclick", (event) => event.preventDefault());
  element.addEventListener("pointercancel", () => { trackingPointer = false; });
  element.addEventListener("pointerup", (event) => {
    if (event.isPrimary === false) return;
    if (!trackingPointer) return;
    trackingPointer = false;
    const diffX = event.clientX - startX;
    const diffY = event.clientY - startY;
    if (Math.abs(diffX) >= 42 && Math.abs(diffX) > Math.abs(diffY) * 1.2) {
      event.preventDefault();
      if (diffX < 0) nextPage(); else previousPage();
      return;
    }
    if (Math.abs(diffY) > 18 || Math.abs(diffX) > 18) return;
    const bounds = element.getBoundingClientRect();
    const relativeX = event.clientX - bounds.left;
    if (relativeX <= bounds.width * .3) { previousPage(); return; }
    if (relativeX >= bounds.width * .7) { nextPage(); return; }
    reader.menuOpen = !reader.menuOpen;
    if (!reader.menuOpen) reader.settingsOpen = false;
    render();
  });
  element.querySelectorAll(".tap-zone").forEach((zone) => zone.addEventListener("click", (event) => {
    // Touch and mouse taps are handled by pointerup above. Keep keyboard
    // activation available without letting a physical tap turn two pages.
    event.preventDefault();
    if (event.detail !== 0) return;
    if (zone.classList.contains("prev")) previousPage(); else nextPage();
  }));
}

function searchDemo(event) {
  event.preventDefault();
  const query = document.querySelector("#book-query").value.trim();
  const list = document.querySelector("#result-list");
  if (!query) { showToast("请输入书名、作者或关键词"); return; }
  list.innerHTML = sourceSamples.map((item, index) => resultCard({ ...item, title: index === 0 ? `${query} · 示例结果` : item.title })).join("");
  bindEvents();
}

function addDemoSource(id) {
  const item = sourceSamples.find((entry) => entry.id === id);
  const importedAt = Date.now();
  const book = { id: `demo-${importedAt}`, title: item.title, author: item.author, source: item.source, progress: 0, importedAt, chapters: [{ title: "第一章  内容接入说明", text: "这是用于验证加入书架流程的演示内容。\n\n正式版会在与版权方、开放内容库或授权书源完成接入后，显示对应书籍的真实章节。" }] };
  library.unshift(book); persist(); showToast("已加入书架"); view = "shelf"; render();
}

function createBackupError(code, detail = "") {
  const error = new Error(code);
  error.code = code;
  error.detail = detail;
  return error;
}

function backupFailure(error, file) {
  const code = error?.code || "backup-json";
  const size = file ? formatFileSize(file.size) : "";
  const copy = {
    "backup-type": ["这不是清如许备份文件", "请选择以 .json 或 .qrxbackup 结尾的备份文件。"],
    "backup-empty": ["备份文件是空的", "请重新选择一份完整的清如许备份。"],
    "backup-too-large": ["备份文件超过当前安全上限", `当前文件为 ${size}，本原型一次最多恢复 250 MB。`],
    "backup-json": ["备份文件无法解析", "文件可能不完整或已损坏，请重新导出后再试。"],
    "backup-format": ["备份格式不属于清如许", "请选择由“我的 → 书架备份”导出的文件。"],
    "backup-version": ["这个备份来自更高版本", "请先升级清如许，再恢复这份备份。"],
    "backup-content": ["备份中的小说数据不完整", error?.detail || "章节内容缺失，未对现有书架做任何修改。"],
    storage: ["恢复内容没有保存成功", "现有书架已保持原样，请确认本机空间充足后重试。"],
    export: ["暂时无法导出备份", "浏览器没有完成文件导出；请关闭提示后重试。现有书架不会受到影响。"]
  };
  const [message, detail] = copy[code] || copy["backup-json"];
  return { message, detail };
}

function sanitizeBackupSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const choose = (allowed, candidate, fallback) => allowed.includes(candidate) ? candidate : fallback;
  return {
    theme: choose(["bamboo", "paper", "night"], source.theme, settings.theme),
    fontSize: clamp(Number(source.fontSize) || settings.fontSize, 16, 40),
    fontFamily: choose(["sans", "song"], source.fontFamily, settings.fontFamily),
    fontWeight: choose(["regular", "strong"], source.fontWeight, settings.fontWeight),
    lineHeight: choose(["compact", "comfortable", "relaxed"], source.lineHeight, settings.lineHeight),
    pageTurn: choose(["slide", "cover", "fade"], source.pageTurn, settings.pageTurn),
    shelfSort: choose(["recent", "imported", "title"], source.shelfSort, settings.shelfSort)
  };
}

function sanitizeBackupPosition(value, chapters) {
  if (!value || typeof value !== "object" || !chapters.length) return null;
  const chapter = clamp(Math.floor(Number(value.chapter) || 0), 0, chapters.length - 1);
  const textLength = chapters[chapter].text.length;
  const position = {
    chapter,
    page: Math.max(0, Math.floor(Number(value.page) || 0)),
    pageCount: Math.max(1, Math.floor(Number(value.pageCount) || 1)),
    updatedAt: Math.max(0, Number(value.updatedAt) || 0)
  };
  if (Number.isFinite(value.charOffset)) position.charOffset = clamp(value.charOffset, 0, textLength);
  return position;
}

function sanitizeBackupBook(value, index) {
  if (!value || typeof value !== "object" || !Array.isArray(value.chapters) || !value.chapters.length) throw createBackupError("backup-content", `第 ${index + 1} 本书缺少章节。`);
  const chapters = value.chapters.map((chapter, chapterIndex) => {
    if (!chapter || typeof chapter !== "object" || typeof chapter.text !== "string") throw createBackupError("backup-content", `第 ${index + 1} 本书的第 ${chapterIndex + 1} 章内容损坏。`);
    return { title: String(chapter.title || `第 ${chapterIndex + 1} 章`).slice(0, 120), text: chapter.text };
  });
  const sourceId = String(value.id || "");
  const id = /^[a-z0-9][a-z0-9_-]{0,159}$/i.test(sourceId) ? sourceId : newLocalBookId();
  const readingPosition = sanitizeBackupPosition(value.readingPosition, chapters);
  const bookmarks = Array.isArray(value.bookmarks) ? value.bookmarks.map((bookmark) => {
    const position = sanitizeBackupPosition(bookmark, chapters);
    if (!position) return null;
    const sourceBookmarkId = String(bookmark.id || "");
    return {
      ...position,
      id: /^[a-z0-9][a-z0-9_-]{0,159}$/i.test(sourceBookmarkId) ? sourceBookmarkId : newBookmarkId(),
      chapterTitle: String(bookmark.chapterTitle || chapters[position.chapter].title).slice(0, 120),
      excerpt: String(bookmark.excerpt || "").slice(0, 180),
      createdAt: Math.max(0, Number(bookmark.createdAt) || 0)
    };
  }).filter(Boolean) : [];
  const cleanup = value.promotionCleanup && typeof value.promotionCleanup === "object" ? value.promotionCleanup : {};
  return {
    id,
    title: String(value.title || `恢复的小说 ${index + 1}`).slice(0, 180),
    author: String(value.author || "本地恢复").slice(0, 120),
    source: String(value.source || "清如许备份").slice(0, 120),
    progress: clamp(Number(value.progress) || 0, 0, 1),
    contentFingerprint: String(value.contentFingerprint || "").slice(0, 220),
    importedAt: Math.max(0, Number(value.importedAt) || 0),
    lastReadAt: Math.max(0, Number(value.lastReadAt) || 0),
    fileName: String(value.fileName || "").slice(0, 300),
    fileSize: Math.max(0, Number(value.fileSize) || 0),
    textEncoding: String(value.textEncoding || "").slice(0, 40),
    coverId: Math.max(0, Math.trunc(Number(value.coverId) || 0)) || undefined,
    coverStyle: clamp(Math.trunc(Number(value.coverStyle) || 0), 0, generatedCoverThemes.length) || undefined,
    metadataUpdatedAt: Math.max(0, Number(value.metadataUpdatedAt) || 0),
    promotionCleanup: { blocks: Math.max(0, Number(cleanup.blocks) || 0), characters: Math.max(0, Number(cleanup.characters) || 0) },
    readingPosition,
    bookmarks,
    chapters
  };
}

function parseBackupPayload(text) {
  let source;
  try { source = JSON.parse(text); }
  catch { throw createBackupError("backup-json"); }
  if (!source || source.format !== BACKUP_FORMAT || !Array.isArray(source.books)) throw createBackupError("backup-format");
  if (Number(source.version) > BACKUP_VERSION) throw createBackupError("backup-version");
  const books = source.books.map(sanitizeBackupBook);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: source.exportedAt || "", settings: sanitizeBackupSettings(source.settings), books };
}

function backupBookmarkKey(bookmark) {
  const offset = Number.isFinite(bookmark.charOffset) ? bookmark.charOffset : `p${bookmark.page || 0}`;
  return `${bookmark.chapter || 0}:${offset}:${bookmark.excerpt || ""}`;
}

function mergeBackupBookmarks(existing, incoming) {
  const merged = [];
  const keys = new Set();
  [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])].forEach((bookmark) => {
    const key = backupBookmarkKey(bookmark);
    if (keys.has(key)) return;
    keys.add(key);
    merged.push(bookmark);
  });
  return merged;
}

function uniqueRestoredBookId(preferred, books) {
  if (!books.some((book) => book.id === preferred)) return preferred;
  let id = newLocalBookId();
  while (books.some((book) => book.id === id)) id = newLocalBookId();
  return id;
}

function mergeBackupLibrary(incomingBooks) {
  const books = [...library];
  let added = 0;
  let merged = 0;
  incomingBooks.forEach((incoming) => {
    let matchIndex = incoming.contentFingerprint ? books.findIndex((book) => book.contentFingerprint && book.contentFingerprint === incoming.contentFingerprint) : -1;
    if (matchIndex < 0) matchIndex = books.findIndex((book) => book.id === incoming.id);
    if (matchIndex < 0) {
      books.push({ ...incoming, id: uniqueRestoredBookId(incoming.id, books) });
      added += 1;
      return;
    }
    const existing = books[matchIndex];
    if (existing.id === incoming.id && existing.contentFingerprint && incoming.contentFingerprint && existing.contentFingerprint !== incoming.contentFingerprint) {
      books.push({ ...incoming, id: uniqueRestoredBookId(newLocalBookId(), books) });
      added += 1;
      return;
    }
    const existingUpdatedAt = Math.max(Number(existing.readingPosition?.updatedAt) || 0, Number(existing.lastReadAt) || 0);
    const incomingUpdatedAt = Math.max(Number(incoming.readingPosition?.updatedAt) || 0, Number(incoming.lastReadAt) || 0);
    const shouldRestorePosition = Boolean(incoming.readingPosition) && incomingUpdatedAt > existingUpdatedAt;
    const shouldRestoreMetadata = (Number(incoming.metadataUpdatedAt) || 0) > (Number(existing.metadataUpdatedAt) || 0);
    books[matchIndex] = {
      ...existing,
      ...(shouldRestorePosition ? { readingPosition: incoming.readingPosition, progress: incoming.progress, lastReadAt: incomingUpdatedAt } : {}),
      ...(shouldRestoreMetadata ? { title: incoming.title, author: incoming.author, coverId: incoming.coverId, coverStyle: incoming.coverStyle, metadataUpdatedAt: incoming.metadataUpdatedAt } : {}),
      bookmarks: mergeBackupBookmarks(existing.bookmarks, incoming.bookmarks)
    };
    merged += 1;
  });
  return { books, added, merged };
}

async function exportLibraryBackup() {
  if (!libraryReady) { showToast("书架正在准备，请稍后"); return; }
  backupSession = { ...emptyBackupSession(), visible: true, phase: "working", operation: "export", message: "正在生成本地备份", detail: "备份只会交给你保存，不会上传" };
  render();
  try {
    const exportedAt = new Date().toISOString();
    const payload = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, settings: sanitizeBackupSettings(settings), books: library };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json;charset=utf-8" });
    const day = exportedAt.slice(0, 10);
    const fileName = `清如许备份-${day}.qrxbackup.json`;
    backupSession = emptyBackupSession();
    render();
    try {
      if (typeof File === "function" && navigator.share && navigator.canShare) {
        const file = new File([blob], fileName, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: "清如许本地备份" }); showToast("备份已交给系统保存"); }
          catch (error) { if (error?.name === "AbortError") return; throw error; }
          return;
        }
      }
    } catch { /* System sharing can be unavailable in embedded browsers; use a file download instead. */ }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast("备份文件已导出");
  } catch (error) {
    const failure = backupFailure(createBackupError("export", error?.message || ""));
    backupSession = { ...emptyBackupSession(), visible: true, phase: "error", operation: "export", message: failure.message, detail: failure.detail };
    render();
  }
}

async function prepareBackupRestore(file) {
  backupSession = { ...emptyBackupSession(), visible: true, phase: "working", operation: "restore", file, message: "正在检查备份", detail: "检查完成后会先让你确认" };
  render();
  try {
    if (!/\.(?:json|qrxbackup)$/i.test(file.name)) throw createBackupError("backup-type");
    if (!file.size) throw createBackupError("backup-empty");
    if (file.size > BACKUP_MAX_BYTES) throw createBackupError("backup-too-large");
    const text = typeof file.text === "function" ? await file.text() : await new Response(file).text();
    const payload = parseBackupPayload(text);
    const bookmarkCount = payload.books.reduce((sum, book) => sum + book.bookmarks.length, 0);
    backupSession = { ...backupSession, phase: "preview", payload, bookCount: payload.books.length, bookmarkCount, exportedAt: payload.exportedAt };
    render();
  } catch (error) {
    const failure = backupFailure(error, file);
    backupSession = { ...emptyBackupSession(), visible: true, phase: "error", operation: "restore", file, message: failure.message, detail: failure.detail };
    render();
  }
}

async function restoreBackup() {
  const payload = backupSession.payload;
  if (!payload) return;
  const previousLibrary = library;
  const previousSettings = { ...settings };
  backupSession = { ...backupSession, phase: "working", message: "正在恢复书架", detail: "现有书架会保留，相同小说正在合并" };
  render();
  try {
    const result = mergeBackupLibrary(payload.books);
    library = result.books;
    settings = sanitizeBackupSettings(payload.settings);
    if (!(await persist())) throw createBackupError("storage");
    shelfQuery = "";
    backupSession = emptyBackupSession();
    view = "shelf";
    render();
    showToast(`恢复完成：新增 ${result.added} 本，合并 ${result.merged} 本`);
  } catch (error) {
    library = previousLibrary;
    settings = previousSettings;
    persistSettings();
    const failure = backupFailure(error, backupSession.file);
    backupSession = { ...backupSession, phase: "error", payload, message: failure.message, detail: failure.detail };
    render();
  }
}

function handleBackupAction(action) {
  if (action === "close") { backupSession = emptyBackupSession(); render(); return; }
  if (action === "export") { void exportLibraryBackup(); return; }
  if (action === "choose") {
    backupSession = emptyBackupSession();
    if (backupPicker) { backupPicker.value = ""; backupPicker.click(); }
    return;
  }
  if (action === "restore") void restoreBackup();
}

function openImportFlow() {
  importSession = { ...emptyImportSession(), visible: true, phase: "choose" };
  render();
}

function closeImportFlow() {
  if (importSession.phase === "working") return;
  importSession = emptyImportSession();
  picker.value = "";
  render();
}

function handleImportAction(action) {
  if (action === "close") { closeImportFlow(); return; }
  if (action === "choose-file" || action === "reselect") {
    importSession = { ...emptyImportSession(), visible: true, phase: "choose" };
    picker.value = "";
    picker.click();
    render();
    return;
  }
  if (action === "retry" && importSession.file) { void startImport(importSession.file, importSession.encoding); return; }
  if (action === "confirm") { void savePendingImport(); return; }
  if (action === "open-existing" && importSession.existingBookId) {
    const bookId = importSession.existingBookId;
    importSession = emptyImportSession();
    openBook(bookId);
    return;
  }
  if (action === "read-imported" && importSession.pendingBook?.id) {
    const bookId = importSession.pendingBook.id;
    importSession = emptyImportSession();
    openBook(bookId);
  }
}

function createImportError(code, detail = "") {
  const error = new Error(code);
  error.code = code;
  error.detail = detail;
  return error;
}

function importFailure(error, file) {
  const code = error?.code || error?.name || "unknown";
  const size = file ? formatFileSize(file.size) : "";
  const copy = {
    "file-type": ["目前只能导入 TXT 文件", "EPUB 会在原生 App 阶段支持；请从“文件”中选择 .txt 文本。"],
    "file-empty": ["这个文件没有可阅读的正文", "请确认文件不是空文件后再试。"],
    "file-too-large": ["文件超过当前原型的安全上限", `当前文件为 ${size}。为了避免手机浏览器在处理中退出，本原型一次最多导入 100 MB TXT。`],
    binary: ["这个文件看起来不是纯文本", "它可能是压缩包、电子书或损坏的文件；请导入 TXT。"],
    encoding: ["没有可靠地识别出文本编码", "请在下方选择 UTF-8、GB18030 / GBK、UTF-16 或 Big5 后重新解析。"],
    storage: ["本机存储空间不足，暂未加入书架", "请清理一些浏览器空间后重试；原文件没有被修改。"],
    unreadable: ["系统暂时无法读取这个文件", "文件可能正在被其他应用占用，或读取权限已失效；请重新选择。"],
    "database-blocked": ["书架正在被另一个页面占用", "请关闭其他打开清如许的标签页后重试；原文件没有被修改。"],
    "database-aborted": ["本机书架没有保存成功", "浏览器中断了本次保存；原文件仍在，请稍后重试。"]
  };
  const [message, detail] = copy[code] || ["暂时无法读取这个文件", error?.detail || "请重新选择一个 TXT 文件后再试。"];
  return { code, message, detail };
}

function setImportWorking(progress, message, detail = "") {
  const nextProgress = Math.max(importSession.progress || 0, Math.min(99, progress));
  const shouldRender = message !== importSession.message || detail !== importSession.detail || nextProgress - (importSession.renderedProgress || 0) >= 5;
  importSession.progress = nextProgress;
  importSession.message = message;
  importSession.detail = detail;
  if (shouldRender) {
    importSession.renderedProgress = nextProgress;
    render();
  }
}

function isSupportedTextFile(file) {
  return /\.txt$/i.test(file.name) || file.type === "text/plain";
}

async function requestImportStorage(file) {
  try {
    const storage = navigator.storage;
    if (!storage?.estimate) return;
    const estimate = await storage.estimate();
    const available = Number(estimate.quota) - Number(estimate.usage);
    const expected = Math.max(8 * 1024 * 1024, file.size * 2);
    if (Number.isFinite(available) && available > 0 && available < expected) throw createImportError("storage");
    if (storage.persist) void storage.persist().catch(() => {});
  } catch (error) {
    if (error?.code === "storage") throw error;
  }
}

async function startImport(file, requestedEncoding = "auto") {
  importSession = {
    ...emptyImportSession(),
    visible: true,
    phase: "working",
    file,
    encoding: requestedEncoding,
    progress: 4,
    message: "正在准备书架",
    detail: "会自动识别中文编码"
  };
  render();
  try {
    if (!libraryReady) await libraryReadyPromise;
    if (!isSupportedTextFile(file)) throw createImportError("file-type");
    if (file.size === 0) throw createImportError("file-empty");
    if (file.size > IMPORT_MAX_BYTES) throw createImportError("file-too-large");
    setImportWorking(8, "正在检查可用空间", "会优先把书籍保存在本机数据库");
    await requestImportStorage(file);
    const { text, encoding } = await readTextFile(file, requestedEncoding, (progress, message) => setImportWorking(progress, message, "文件较大时，请保持页面开启"));
    if (!text.trim()) throw createImportError("file-empty");
    setImportWorking(74, "正在清理推广与导流信息", "保留作者话、求票和章节收尾，只处理明确站外导流");
    const cleanup = cleanImportedText(text);
    const readableText = cleanup.text;
    if (!readableText.trim()) throw createImportError("file-empty");
    setImportWorking(76, "正在确认是否重复导入", "不会覆盖已有阅读进度");
    const fingerprint = await textFingerprint(readableText, (progress) => setImportWorking(progress, "正在整理文本", "正在生成本地内容标识"));
    const existing = library.find((book) => book.contentFingerprint === fingerprint);
    const metadata = inferBookMetadata(file.name, readableText);
    const baseTitle = metadata.title;
    if (existing) {
      importSession = { ...importSession, phase: "duplicate", progress: 100, title: existing.title, existingBookId: existing.id, detectedEncoding: encoding };
      render();
      return;
    }
    setImportWorking(91, "正在识别中文章节", "目录识别完成后可以先预览正文");
    const chapters = parseChapters(readableText);
    const title = importedTitle(baseTitle);
    const book = {
      id: newLocalBookId(),
      title,
      author: metadata.author,
      source: "本机文件",
      progress: 0,
      contentFingerprint: fingerprint,
      importedAt: Date.now(),
      fileName: file.name,
      fileSize: file.size,
      textEncoding: encoding,
      promotionCleanup: { blocks: cleanup.blocks, characters: cleanup.characters },
      chapters
    };
    importSession = {
      ...importSession,
      phase: "preview",
      progress: 100,
      detectedEncoding: encoding,
      pendingBook: book,
      title,
      author: metadata.author,
      chapterCount: chapters.length,
      wordCount: readableText.replace(/\s/g, "").length,
      preview: makeTextPreview(readableText),
      sameTitle: title !== baseTitle,
      cleanedPromotionBlocks: cleanup.blocks,
      cleanedPromotionCharacters: cleanup.characters
    };
    render();
  } catch (error) {
    const failure = importFailure(error, file);
    importSession = { ...importSession, phase: "error", progress: 0, errorCode: failure.code, message: failure.message, detail: failure.detail, pendingBook: null };
    render();
  } finally {
    picker.value = "";
  }
}

async function savePendingImport() {
  const book = importSession.pendingBook;
  if (!book) return;
  const titleInput = document.querySelector("#import-book-title");
  const authorInput = document.querySelector("#import-book-author");
  const title = String(titleInput?.value || "").trim().slice(0, 80);
  const author = String(authorInput?.value || "").trim().slice(0, 60) || "未知作者";
  if (!title) {
    titleInput?.setCustomValidity("请输入书名");
    titleInput?.reportValidity();
    titleInput?.focus();
    return;
  }
  titleInput?.setCustomValidity("");
  book.title = title;
  book.author = author;
  book.metadataUpdatedAt = Date.now();
  importSession = { ...importSession, phase: "working", progress: 97, message: "正在保存到书架", detail: "保存完成后原文件仍会保留" };
  render();
  library.unshift(book);
  if (!(await persist())) {
    library = library.filter((item) => item.id !== book.id);
    const failure = importFailure(createImportError("storage"), importSession.file);
    importSession = { ...importSession, phase: "error", progress: 0, errorCode: failure.code, message: failure.message, detail: failure.detail, pendingBook: null };
    render();
    return;
  }
  view = "shelf";
  importSession = { ...importSession, phase: "success", progress: 100, pendingBook: book, title: book.title, chapterCount: book.chapters.length };
  render();
}

function newLocalBookId() {
  if (globalThis.crypto?.randomUUID) return `local-${globalThis.crypto.randomUUID()}`;
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanImportedText(text) {
  // Policy: protect author notes and chapter endings first. For the rest,
  // only remove a short line when there is clear third-party promotion or
  // diversion evidence. An inline URL, site name, app, group number, or QR
  // code is deliberately not enough; a pure standalone web address is a
  // common watermark and can be removed.
  const sourceText = String(text || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
  const siteLabel = /[【\[][^】\]\n]{0,48}(?:小说网|文学网|阅读网|书友网|书库|笔趣阁|笔趣|追书|看书)[^】\]\n]{0,48}[】\]]/i;
  const webAddress = /(?:https?:\/\/|www[.．])[a-z0-9][a-z0-9./_?=&%#．-]{1,}|(?:[a-z0-9][a-z0-9-]{0,62}[.．])+(?:com|cn|net|org|cc|co|info|vip|me|io|top|xyz|site|online|app|tv|club|mobi|pro|asia|us|uk|de|jp|ru|fr|ai)\b/i;
  const chapterHeading = /^[ \t　]*(?:(?:第[ \t　]*[〇零一二三四五六七八九十百千万两0-9]+[ \t　]*(?:章|节|卷|回|部|篇|集|话))|(?:楔子|序章|序言|引子|前言|后记|尾声|番外))/i;
  const authorHeading = /^[ \t　]*(?:[【\[（(]?[ \t　]*)?(?:作者(?:有话说|的话|公告|寄语)?|PS(?:[.．：:]|\s|$)|ＰＳ(?:[.．：:]|\s|$)|题外话|本章说)/i;
  const preservedInteraction = /^[ \t　]*(?:[【\[]?[ \t　]*)?(?:求(?:票|月票|推荐(?:票)?|收藏|订阅|评论|打赏|追读)|(?:跪求|求个|麻烦(?:大家|各位)?)(?:月票|推荐票|收藏|订阅|评论|打赏|追读)|感谢(?:大家|支持)?|本章(?:完|结束)|下一章|下章预告|未完待续)/i;
  const promoSignals = [/(?:更新快|更新及时|最快更新|最新章节)/i, /(?:无弹窗|弹窗少)/i, /(?:广告少|少广告|无广告)/i, /(?:免费阅读|免费(?:看|读)?书)/i, /(?:网站(?:页面)?清爽|阅读体验)/i, /(?:欢迎(?:收藏|访问|分享)|请(?:记住|收藏|访问))/i, /(?:最新地址|最新网址|备用网址|永久域名)/i];
  const addressDirective = /(?:最新网址|最新地址|备用网址|永久域名|官网地址|官方网址)/i;
  const bracketedAddressDirective = /[【\[][^】\]\n]{0,48}(?:最新网址|最新地址|备用网址|永久域名|官网地址|官方网址)[^】\]\n]{0,48}[】\]]/i;
  const externalDirectives = [
    /(?:请|请您).{0,10}(?:记住|收藏|访问).{0,20}(?:本站|本网站|最新网址|备用网址|网址|域名|官网)/i,
    /(?:手机用户|手机访问).{0,12}(?:请|可).{0,10}(?:浏览|访问|阅读)/i,
    /(?:更多(?:精彩|免费|内容).{0,36}(?:百度搜索|搜索|访问|阅读))/i,
    /(?:本书(?:来自|转载自|收录于)).{0,34}(?:小说网|网站|阅读|网址|域名)/i,
    /(?:关注|搜索).{0,18}(?:微信公众号|公众号|微信(?:号)?|小程序|微博|抖音).{0,48}(?:回复|领取|获取|免费|全集|福利|下载|阅读)/i,
    /(?:(?:书友|读者)(?:交流群|群)|QQ群|群号).{0,32}(?:加群|进群|欢迎加入|领取|获取|客服|福利|完整版)/i,
    /(?:扫码|扫描(?:二维码|码)|二维码).{0,48}(?:关注|加群|下载|领取|获取|免费|全集|阅读|客户端)/i,
    /(?:下载|安装|打开).{0,28}(?:APP|客户端|应用).{0,58}(?:小说|阅读|免费|会员|扫码|商店|福利)/i,
    /(?:小说|阅读|看书).{0,24}(?:APP|客户端|应用).{0,36}(?:下载|安装|扫码|商店)/i,
    /(?:安卓|Android|苹果|iOS).{0,32}(?:点击|请).{0,12}(?:下载|安装|搜索).{0,40}(?:APP|客户端|应用|App Store|https?:\/\/|www[.．])/i,
    /(?:本章(?:未完|未完待续)|未完待续).{0,35}(?:点击|请).{0,15}(?:下一页|继续阅读)/i
  ];
  const continuationPromotion = /(?:一定要好评|欢迎收藏(?:本站)?|请(?:记住|收藏|访问)|无弹窗|广告少|更新快|最新网址|备用网址|二维码|公众号|进群|加群|下载(?:APP|客户端)|客户端)/i;
  const maxCandidateLength = 280;
  let blocks = 0;
  let characters = Math.max(0, String(text || "").length - sourceText.length);
  let continuationLines = 0;
  let authorParagraph = false;
  let previousLineEnd = 0;

  const signalCount = (line) => promoSignals.reduce((count, pattern) => count + (pattern.test(line) ? 1 : 0), 0);
  const firstDirectiveMatch = (line) => {
    const matches = externalDirectives.map((pattern) => pattern.exec(line)).filter(Boolean);
    if (!matches.length) return null;
    return matches.reduce((first, match) => match.index < first.index ? match : first);
  };
  const isStandaloneAddress = (line, address) => {
    const remaining = `${line.slice(0, address.index)}${line.slice(address.index + address[0].length)}`.replace(/[\s\-—_~·•|:：,，。．!！?？()（）【】\[\]<>《》]+/g, "");
    return remaining.length <= 4;
  };
  const isProtectedLine = (line) => authorHeading.test(line) || preservedInteraction.test(line) || chapterHeading.test(line);
  const removalMarker = (line) => {
    if (line.trim().length > maxCandidateLength || isProtectedLine(line)) return -1;
    const directive = firstDirectiveMatch(line);
    if (directive) return directive.index;
    const address = webAddress.exec(line);
    if (!address) return -1;
    const label = siteLabel.exec(line);
    const addressLabel = bracketedAddressDirective.exec(line);
    const pairedLabel = label && label.index <= address.index && address.index - label.index <= 96;
    const signals = signalCount(line);
    if ((pairedLabel && signals >= 1) || signals >= 3 || addressDirective.test(line) || isStandaloneAddress(line, address)) {
      const indexes = [label?.index, addressLabel?.index, address.index].filter((index) => Number.isFinite(index));
      return Math.min(...indexes);
    }
    return -1;
  };
  const linkedPromotionAhead = (source, afterLine) => {
    // Stay in the same paragraph and stop at a chapter heading. This prevents
    // a site label from swallowing unrelated content farther down the file.
    const sameParagraph = source.slice(afterLine, afterLine + 460).split(/\n[ \t　]*\n/, 1)[0] || "";
    const candidates = sameParagraph.split("\n").filter((line) => line.trim()).slice(0, 2);
    return candidates.some((line) => !chapterHeading.test(line) && removalMarker(line) >= 0);
  };
  const removePromotionTail = (line, markerIndex) => {
    const tail = line.slice(markerIndex);
    const sentenceEnd = tail.search(/[。！？]/);
    const removeEnd = sentenceEnd >= 0 ? markerIndex + sentenceEnd + 1 : line.length;
    const prefix = line.slice(0, markerIndex).replace(/[ \t　]+$/, "");
    const suffix = line.slice(removeEnd).replace(/^[ \t　]+/, "");
    return { text: `${prefix}${suffix}`, removed: removeEnd - markerIndex };
  };

  const cleaned = sourceText.replace(/[^\n]+/g, (line, offset, source) => {
    const separator = source.slice(previousLineEnd, offset);
    previousLineEnd = offset + line.length;
    if (/\n[ \t　]*\n/.test(separator)) { authorParagraph = false; continuationLines = 0; }
    if (chapterHeading.test(line)) { authorParagraph = false; continuationLines = 0; return line; }
    if (authorHeading.test(line)) { authorParagraph = true; continuationLines = 0; return line; }
    if (authorParagraph || preservedInteraction.test(line)) { continuationLines = 0; return line; }

    const label = siteLabel.exec(line);
    let markerIndex = removalMarker(line);
    if (markerIndex < 0 && label && linkedPromotionAhead(source, offset + line.length)) markerIndex = label.index;
    if (markerIndex >= 0) {
      // An injected label or directive can follow real prose. Preserve the
      // prefix, then remove only the third-party promotion tail.
      const result = removePromotionTail(line, markerIndex);
      if (result.removed > 0) { blocks += 1; characters += result.removed; }
      continuationLines = 2;
      return result.text;
    }

    if (continuationLines > 0 && continuationPromotion.test(line) && line.trim().length <= maxCandidateLength) {
      blocks += 1;
      characters += line.length;
      continuationLines -= 1;
      return "";
    }
    if (line.trim()) continuationLines = 0;
    return line;
  });

  return { text: cleaned.replace(/\n{3,}/g, "\n\n"), blocks, characters };
}

function parseChapters(text) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const heading = /^[ \t　]*((?:(?:第[ \t　]*[〇零一二三四五六七八九十百千万两0-9]+[ \t　]*(?:章|节|卷|回|部|篇|集|话))(?:[ \t　]*[：:、.\-—][ \t　]*.*|[ \t　]+.*)?|(?:楔子|序章|序言|引子|前言|后记|尾声|番外)(?:[ \t　]*[：:、.\-—][ \t　]*.*|[ \t　]+.*)?))[ \t　]*$/gm;
  const matches = [...normalized.matchAll(heading)].filter((match) => match[1].trim().length <= 90);
  if (!matches.length) return [{ title: "正文", text: normalized }];
  const chapters = [];
  if (matches[0].index > 0 && normalized.slice(0, matches[0].index).trim()) chapters.push({ title: "前言", text: normalized.slice(0, matches[0].index).trim() });
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
    chapters.push({ title: match[1].trim(), text: normalized.slice(match.index + match[0].length, end).trim() || "暂无正文。" });
  });
  return chapters;
}

function detectTextEncoding(sample, requestedEncoding) {
  if (requestedEncoding !== "auto") return requestedEncoding;
  if (sample[0] === 0xff && sample[1] === 0xfe) return "utf-16le";
  if (sample[0] === 0xfe && sample[1] === 0xff) return "utf-16be";
  try {
    // Streaming avoids treating a valid multi-byte Chinese character cut at
    // the sample boundary as malformed UTF-8.
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return "utf-8";
  } catch {
    try { new TextDecoder("gb18030"); return "gb18030"; }
    catch { throw createImportError("encoding"); }
  }
}

function looksLikeBinary(text) {
  const sample = text.slice(0, 12000);
  if (!sample) return false;
  const controls = (sample.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  return controls > Math.max(12, sample.length * 0.01);
}

async function readTextFile(file, requestedEncoding, onProgress) {
  let sample;
  try {
    sample = new Uint8Array(await file.slice(0, Math.min(file.size, IMPORT_SAMPLE_BYTES)).arrayBuffer());
  } catch {
    throw createImportError("unreadable");
  }
  const encoding = detectTextEncoding(sample, requestedEncoding);
  let decoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    throw createImportError("encoding");
  }
  const chunks = [];
  let offset = 0;
  try {
    while (offset < file.size) {
      const end = Math.min(file.size, offset + IMPORT_CHUNK_BYTES);
      const bytes = await file.slice(offset, end).arrayBuffer();
      chunks.push(decoder.decode(bytes, { stream: end < file.size }));
      offset = end;
      onProgress(12 + Math.round((offset / file.size) * 60), `正在读取正文 · ${encodingName(encoding)}`);
      if (file.size > IMPORT_CHUNK_BYTES) await yieldToBrowser();
    }
  } catch (error) {
    if (error?.code) throw error;
    throw createImportError("unreadable");
  }
  const text = chunks.join("").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  if (looksLikeBinary(text)) throw createImportError("binary");
  if (replacementCount > Math.max(12, text.length * 0.008)) throw createImportError("encoding");
  return { text, encoding };
}

async function textFingerprint(text, onProgress) {
  let primary = 2166136261;
  let secondary = 0x9e3779b9;
  const blockSize = 360000;
  for (let start = 0; start < text.length; start += blockSize) {
    const end = Math.min(text.length, start + blockSize);
    for (let index = start; index < end; index += 1) {
      const code = text.charCodeAt(index);
      primary = Math.imul(primary ^ code, 16777619);
      secondary = Math.imul(secondary ^ code, 0x5bd1e995);
    }
    onProgress(76 + Math.round((end / text.length) * 13));
    if (end < text.length) await yieldToBrowser();
  }
  return `${text.length}-${(primary >>> 0).toString(36)}-${(secondary >>> 0).toString(36)}`;
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function makeTextPreview(text) {
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > 180 ? `${clean.slice(0, 180).trim()}……` : clean;
}

function importedTitle(baseTitle) {
  if (!library.some((book) => book.title === baseTitle)) return baseTitle;
  let number = 2;
  while (library.some((book) => book.title === `${baseTitle}（导入 ${number}）`)) number += 1;
  return `${baseTitle}（导入 ${number}）`;
}

function cleanBookMetadataValue(value, fallback = "") {
  const cleaned = String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^[\s《》【】\[\]()（）_-]+|[\s《》【】\[\]()（）_-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned.length <= 100 ? cleaned : fallback;
}

function inferBookMetadata(fileName, text) {
  const rawFileTitle = String(fileName || "").replace(/\.txt$/i, "").trim() || "未命名小说";
  let title = rawFileTitle;
  let author = "";
  const filenamePatterns = [
    /^《([^》]{1,80})》\s*(?:作者|作\s*者)\s*[：:]\s*([^【\[(（]{1,60})/i,
    /^(.{1,80}?)\s*[（(]\s*(?:作者|作\s*者)\s*[：:]\s*([^）)]{1,60})[）)]/i,
    /^(.{1,80}?)[\s._-]+(?:作者|作\s*者)\s*[：:_-]*\s*([^【\[(（]{1,60})/i
  ];
  for (const pattern of filenamePatterns) {
    const match = rawFileTitle.match(pattern);
    if (!match) continue;
    title = match[1];
    author = match[2];
    break;
  }
  const sample = String(text || "").slice(0, 5000);
  const contentTitle = sample.match(/^(?:书名|作品名)\s*[：:]\s*([^\n]{1,100})\s*$/im)?.[1];
  const contentAuthor = sample.match(/^(?:作者|作\s*者)\s*[：:]\s*([^\n]{1,80})\s*$/im)?.[1];
  if (contentTitle) title = contentTitle;
  if (contentAuthor) author = contentAuthor;
  title = cleanBookMetadataValue(title, "未命名小说")
    .replace(/[\s_-]*(?:完本|全本|全集|精校版?|校对版|未删减版|TXT版)\s*$/i, "")
    .trim() || "未命名小说";
  author = cleanBookMetadataValue(author, "未知作者")
    .replace(/\s*(?:著|作品)\s*$/i, "")
    .trim() || "未知作者";
  return { title: title.slice(0, 80), author: author.slice(0, 60) };
}

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file) void startImport(file);
});

backupPicker?.addEventListener("change", () => {
  const file = backupPicker.files?.[0];
  if (file) void prepareBackupRestore(file);
});

function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) { toast = document.createElement("div"); toast.className = "toast"; document.body.append(toast); }
  toast.textContent = message; requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") updateProgress(true);
});
window.addEventListener("pagehide", () => updateProgress(true));
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
initializeBatteryStatus();
render();
libraryReadyPromise = hydrateLibrary();
