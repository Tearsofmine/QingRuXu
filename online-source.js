/* Read-only source adapter. Remote HTML is parsed off-screen and never mounted. */
globalThis.QrxSources = (() => {
  const API = "https://zh.wikisource.org/w/api.php";
  const ORIGIN = "https://zh.wikisource.org";
  const MAX_PAGES = 500;
  const MAX_CHARS = 15000000;
  const sourceUrl = (title) => `${ORIGIN}/wiki/${encodeURIComponent(title)}`;
  const fail = (message) => new Error(message);
  const abort = (signal) => { if (signal?.aborted) throw new DOMException("已取消", "AbortError"); };

  async function request(params, signal) {
    abort(signal);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, params.action === "parse" ? 60000 : 20000);
    try {
      const query = new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params });
      const response = await fetch(`${API}?${query}`, { signal: controller.signal, credentials: "omit" });
      if (!response.ok) throw fail(`书源暂时不可用（${response.status}），请稍后重试。`);
      const data = await response.json();
      if (data.error) throw fail(data.error.code === "missingtitle" ? "书源中的这一页已不存在，请重新搜索。" : "书源暂时无法处理请求，请稍后重试。");
      return data;
    } catch (error) {
      abort(signal);
      if (error.name === "AbortError") throw fail("连接书源超时，请检查网络后重试。");
      if (error instanceof TypeError) throw fail("无法连接中文维基文库。当前网络可能无法访问该站，请换网络后重试；这不表示没有这本书。");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }

  function plain(html) {
    return new DOMParser().parseFromString(String(html || ""), "text/html").body.textContent.trim();
  }

  async function search(query, signal) {
    const data = await request({ action: "query", list: "search", srsearch: query, srnamespace: "0", srlimit: "30", srwhat: "title", srprop: "snippet", converttitles: "1", uselang: "zh-hans" }, signal);
    const found = new Map();
    for (const entry of data.query?.search || []) {
      const title = String(entry.title || "").split("/")[0];
      if (!title || title.includes(":")) continue;
      if (!found.has(title)) found.set(title, { title, snippet: plain(entry.snippet), url: sourceUrl(title) });
    }
    return [...found.values()].slice(0, 12);
  }

  function linkedTitle(anchor) {
    try {
      const url = new URL(anchor.getAttribute("href") || "", ORIGIN);
      if (url.origin !== ORIGIN || anchor.classList.contains("new")) return "";
      if (url.pathname.startsWith("/wiki/")) return decodeURIComponent(url.pathname.slice(6)).replace(/_/g, " ");
      if (url.pathname === "/w/index.php" && !url.searchParams.has("action")) return url.searchParams.get("title") || "";
    } catch { /* Ignore malformed links. */ }
    return "";
  }

  function parsePage(parsed) {
    const title = parsed.title;
    if (!title || typeof parsed.text !== "string") throw fail("书源没有返回可读取的正文。");
    if ((parsed.properties || []).some((p) => p.name === "disambiguation") || /[（(]消歧[義义][）)]/.test(title)) {
      throw fail("这是同名作品索引，请输入更准确的版本名称后搜索。");
    }
    const doc = new DOMParser().parseFromString(parsed.text, "text/html");
    const root = doc.querySelector(".mw-parser-output") || doc.body;
    const authorLink = root.querySelector('a[href*="Author:"], a[href*="Author%3A"], a[title^="Author:"]');
    const author = authorLink?.textContent.trim() || "作者见来源页";
    const notice = [...root.querySelectorAll('.licensetpl, .licenseContainer, .license, .copyright, #copyright, .license-container')].map((el) => el.textContent.trim()).join("\n");
    root.querySelectorAll('script, style, iframe, object, embed, img, .mw-editsection, .noprint, .navbox, .ws-noexport, #header, .header, #headerContainer, .ws-header, .ws-footer, #footer, .acContainer, .licenseContainer, .licensetpl, .license, .copyright, #copyright, .license-container, .sisitem, .catlinks').forEach((el) => el.remove());
    const children = [];
    const seen = new Set();
    for (const anchor of root.querySelectorAll("a[href]")) {
      const child = linkedTitle(anchor);
      if (child.startsWith(`${title}/`) && !seen.has(child)) { seen.add(child); children.push(child); }
    }
    // When both a volume and its chapters are listed, let the volume own them.
    const directChildren = children.filter((child) => !children.some((parent) => parent !== child && child.startsWith(`${parent}/`)));
    root.querySelectorAll("br").forEach((el) => el.replaceWith(doc.createTextNode("\n")));
    let blocks = [...root.querySelectorAll("p, .poem, h2, h3, pre")].filter((el) => !el.parentElement?.closest("p, .poem, pre"));
    const text = blocks.map((el) => el.textContent.trim()).filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    const prose = blocks.filter((el) => !/^H[23]$/.test(el.tagName)).map((el) => el.textContent.trim()).join("");
    if (!directChildren.length && !prose) throw fail(`“${title}”暂时没有可导入的文字正文，可能是扫描版或索引页。`);
    return { title, author, text, children: directChildren, sourceUrl: sourceUrl(title), revision: Number(parsed.revid) || 0, notice };
  }

  async function readPage(title, signal) {
    const data = await request({ action: "parse", page: title, prop: "text|properties|revid", redirects: "1", disableeditsection: "1", variant: "zh-hans" }, signal);
    abort(signal);
    return parsePage(data.parse || {});
  }

  async function prepare(title, signal) {
    const root = await readPage(title, signal);
    const cache = new Map([[title, root], [root.title, root]]);
    let first = root;
    const visited = new Set();
    while (first.children.length) {
      if (visited.has(first.title) || visited.size >= 10) throw fail("这个版本的目录层级暂不支持，请选择其他版本。");
      visited.add(first.title);
      const next = first.children[0];
      first = await readPage(next, signal);
      cache.set(next, first);
    }
    return { title: root.title, author: root.author, sourceUrl: root.sourceUrl, notice: root.notice, first, root, cache };
  }

  async function download(preview, signal, onProgress = () => {}) {
    const queue = preview.root.children.length ? [...preview.root.children] : [preview.root.title];
    const visited = new Set();
    const chapters = [];
    let characters = 0;
    for (let index = 0; index < queue.length; index += 1) {
      abort(signal);
      const title = queue[index];
      if (visited.has(title)) continue;
      if (visited.size >= MAX_PAGES) throw fail("目录超过本版一次下载的 500 页上限，尚未加入书架；请尝试分卷版本。");
      visited.add(title);
      onProgress({ done: chapters.length, total: queue.length, title });
      const page = preview.cache.get(title) || await readPage(title, signal);
      if (page.children.length) {
        queue.splice(index + 1, 0, ...page.children.filter((child) => !visited.has(child)));
        continue;
      }
      characters += page.text.length;
      if (characters > MAX_CHARS) throw fail("正文超过本版一次下载的容量，请选择分卷版本。");
      if (!page.text.trim()) throw fail(`“${title}”缺少正文，尚未加入书架，请稍后重试。`);
      chapters.push({ title: page.title.startsWith(`${preview.title}/`) ? page.title.slice(preview.title.length + 1) : page.title, text: page.text, sourceUrl: page.sourceUrl, sourceRevision: page.revision });
      onProgress({ done: chapters.length, total: queue.length, title });
    }
    if (!chapters.length) throw fail("没有获得可阅读的章节，尚未加入书架。");
    return { title: preview.title, author: preview.author, source: "中文维基文库", sourceUrl: preview.sourceUrl, sourceNotice: preview.notice || "正文及整理版本的使用说明请见来源页与其历史记录。", sourceLicenseUrl: "https://zh.wikisource.org/wiki/Wikisource:版权信息", chapters };
  }

  return { search, prepare, download, parsePage, sourceUrl };
})();
