/* Shared upgrades for the v36.8 reader. No personal credentials here. */
globalThis.QrxUpgrades=(()=>{
  let loadState='loading',saveError='',conflict=false,bookmarkBusy=false;
  let virtualEntries=[],virtualBookId='',checkBusy=false;
  function notice(){
    if(loadState==='loading')return '';
    const blocked=loadState==='error';if(!blocked&&!saveError&&!conflict)return '';
    return `<aside class="storage-notice ${blocked?'storage-blocked':''}" role="alert"><div><strong>${blocked?'暂时未能读取书架':conflict?'书架在另一页面有变更':'本次更改尚未保存'}</strong><p>${blocked?'原有数据没有被清空。成功重新读取前，已暂停写入。':conflict?'请重新读取最新书架，避免覆盖其他页面的修改。':escapeHTML(saveError)}</p><button class="secondary-button" data-retry-library>${blocked||conflict?'重新读取书架':'重试保存'}</button></div></aside>`;
  }
  async function hydrate(){
    loadState='loading';libraryReady=false;
    try{const saved=await readLibraryFromDatabase({adopt:true});const demos=saved.books.filter(b=>!withoutDemoBooks([b]).length).map(b=>b.id);
      library=withoutDemoBooks(saved.books);loadState='ready';libraryReady=true;saveError='';conflict=false;
      if(demos.length&&!await persist({deletedIds:demos}))throw new Error('保存示例清理失败');
      try{localStorage.removeItem(STORAGE_KEY);}catch{}
      if(view==='reader'){const book=currentBook();if(!book)view='shelf';else{const location=resolveReadingPage(book,book.readingPosition);reader.chapter=location.chapter;reader.page=location.page;reader.anchorOffset=book.readingPosition?.charOffset??null;reader.sheetOpen=false;}}
      render();return true;
    }catch{loadState='error';libraryReady=false;render();return false;}
  }
  function persist(options={}){
    persistSettings();if(loadState!=='ready'||!libraryReady)return Promise.resolve(false);
    const write=libraryWriteQueue.then(()=>saveLibraryToDatabase(library,options));libraryWriteQueue=write.catch(()=>{});
    return write.then(()=>{saveError='';return true;}).catch(e=>{conflict=e?.code==='storage-conflict';saveError=conflict?'': '浏览器没有完成保存。阅读位置仍在当前页面，请检查存储空间后重试。';refreshNotice();return false;});
  }
  function refreshNotice(){const old=document.querySelector('.storage-notice');old?.remove();if(!app)return;app.insertAdjacentHTML('beforeend',notice());document.querySelector('[data-retry-library]')?.addEventListener('click',retry);}
  async function retry(){
    await libraryWriteQueue;
    if(loadState==='error'||conflict){await hydrate();return;}
    if(await persist()){showToast('已重新保存');refreshNotice();}
  }
  QrxLibrary.onExternalChange(()=>{conflict=true;refreshNotice();});
  async function toggleBookmark(){
    const book=currentBook();if(!book||bookmarkBusy)return;bookmarkBusy=true;
    const previous=book.bookmarks||[],pages=paginate(book.chapters[reader.chapter].text,settings.fontSize,book.chapters[reader.chapter].title),offset=currentReaderOffset(book,pages);
    const existing=previous.findIndex(b=>bookmarkMatchesCurrentPosition(book,b,offset));
    book.bookmarks=existing>=0?previous.filter((_,i)=>i!==existing):[...previous,{id:newBookmarkId(),chapter:reader.chapter,chapterTitle:book.chapters[reader.chapter].title,page:reader.page,pageCount:pages.length,charOffset:offset,excerpt:(pages[reader.page]||'').replace(/\s+/g,' ').slice(0,44),createdAt:Date.now()}];
    try{if(!await persist({stateOnly:true,bookId:book.id})){book.bookmarks=previous;showToast('书签没有保存成功，请重试');}else showToast(existing>=0?'已取消书签':'已加入书签');}finally{bookmarkBusy=false;render();}
  }
  async function removeBookmark(id){const book=currentBook();if(!book||bookmarkBusy)return;bookmarkBusy=true;const previous=book.bookmarks||[];book.bookmarks=previous.filter(b=>b.id!==id);
    try{if(!await persist({stateOnly:true,bookId:book.id})){book.bookmarks=previous;showToast('书签删除未保存，请重试');}else showToast('已删除书签');}finally{bookmarkBusy=false;render();}}
  function saveProgress(){const id=currentBook()?.id;if(id)void persist({stateOnly:true,bookId:id});}
  function mergeCached(existing,incoming){
    if(!isOnlineBook(existing)||existing.remoteSource!==incoming.remoteSource||existing.remoteBookId!==incoming.remoteBookId)return existing.chapters;
    const cached=new Map((incoming.chapters||[]).filter(c=>c.sourceChapterId&&c.text?.trim()).map(c=>[String(c.sourceChapterId),c]));
    return existing.chapters.map(ch=>{const row=cached.get(String(ch.sourceChapterId));return !ch.text?.trim()&&row&&row.title===ch.title?{...ch,text:row.text}:ch;});
  }
  function renderPage(){
    reader.menuOpen=false;reader.settingsOpen=false;
    const book=currentBook(),root=app.querySelector('.reader'),page=document.querySelector('#reader-page');
    if(!book||!root||!page||root.dataset.bookId!==book.id||document.querySelector('#chapter-sheet')){render();return;}
    const chapter=book.chapters[reader.chapter],pages=paginate(chapter.text,settings.fontSize,chapter.title);reader.page=clamp(reader.page,0,pages.length-1);
    root.classList.remove('menu-open');root.querySelectorAll('.reader-menu.open,.reader-top-menu.open,.reader-settings.open').forEach(n=>n.classList.remove('open'));
    page.className='reader-page';let h=page.querySelector('h1');if(reader.page===0){if(!h){h=document.createElement('h1');page.insertBefore(h,page.querySelector('.reader-text'));}h.textContent=chapter.title;}else h?.remove();
    page.querySelector('.reader-text').textContent=pages[reader.page];root.querySelector('.reader-chapter-label').textContent=chapter.title;
    const progress=Math.round(calculateReadingProgress(book,reader.chapter,reader.page,pages)*100);root.querySelector('.reader-progress span').style.width=`${progress}%`;
    const footer=root.querySelectorAll('.reader-footer span');footer[0].textContent=`${reader.page+1} / ${pages.length}`;footer[1].textContent=`${progress}%`;
    if(reader.transitionDirection){void page.offsetWidth;page.classList.add(`page-turn-${settings.pageTurn}-${reader.transitionDirection}`);reader.transitionDirection='';}syncReaderStatus();
  }
  function sheet(book){
    if(!reader.sheetOpen)return '';
    const bookmarks=getBookBookmarks(book),show=reader.sheetTab==='bookmarks';
    const credit=`${safeSourceUrl(book.sourceUrl)?`<a href="${escapeHTML(safeSourceUrl(book.sourceUrl))}" target="_blank" rel="noopener noreferrer">原文与署名</a>`:''}${book.sourceNotice?`<details class="source-credits"><summary>作者、来源与许可</summary><p>${escapeHTML(book.sourceNotice)}</p>${safeSourceUrl(book.sourceLicenseUrl)?`<a href="${escapeHTML(safeSourceUrl(book.sourceLicenseUrl))}" target="_blank" rel="noopener noreferrer">查看许可</a>`:''}</details>`:''}`;
    return `<aside class="sheet" id="chapter-sheet"><button class="sheet-backdrop" data-reader-action="close-chapters" aria-label="关闭目录并返回阅读"></button><div class="sheet-content"><div class="sheet-head"><div><h2>${escapeHTML(book.title)}</h2><p class="subtle">目录与书签</p>${credit}${isOnlineBook(book)?`<button class="text-button" data-check-updates="${escapeHTML(book.id)}" ${checkBusy?'disabled':''}>${checkBusy?'正在检查…':'检查新章节'}</button>`:''}</div><button class="close" data-reader-action="close-chapters">×</button></div><div class="chapter-tabs"><button class="${show?'':'active'}" data-reader-action="show-chapters">目录</button><button class="${show?'active':''}" data-reader-action="show-bookmarks">书签${bookmarks.length?` (${bookmarks.length})`:''}</button></div>${show?bookmarkPanel(book,bookmarks):`<div class="chapter-search"><span>⌕</span><input id="chapter-search" value="${escapeHTML(reader.chapterQuery||'')}" placeholder="搜索章节" autocomplete="off" /></div><div class="chapter-directory-meta"><span id="chapter-result-meta"></span><button data-reader-action="toggle-chapter-order">${reader.chapterOrder==='desc'?'倒序 ↓':'正序 ↑'}</button></div><p class="chapter-search-empty" id="chapter-search-empty" hidden>没有匹配的章节</p><div class="chapter-list virtual-chapter-list" id="chapter-list"><div class="chapter-virtual-spacer"></div><div class="chapter-virtual-window"></div></div>`}</div></aside>`;
  }
  function filterChapters(query){
    const book=currentBook(),list=document.querySelector('#chapter-list');if(!book||!list)return;
    const q=String(query||'').trim().toLowerCase();virtualBookId=book.id;virtualEntries=book.chapters.map((chapter,index)=>({chapter,index})).filter(e=>!q||e.chapter.title.toLowerCase().includes(q));if(reader.chapterOrder==='desc')virtualEntries.reverse();
    list.querySelector('.chapter-virtual-spacer').style.height=`${virtualEntries.length*80}px`;
    const meta=document.querySelector('#chapter-result-meta');meta.textContent=q?`找到 ${virtualEntries.length} 章`:`共 ${book.chapters.length} 章 · 当前第 ${reader.chapter+1} 章`;
    document.querySelector('#chapter-search-empty').hidden=virtualEntries.length>0;
    const active=q?-1:virtualEntries.findIndex(e=>e.index===reader.chapter);list.scrollTop=active<0?0:Math.max(0,active*80-list.clientHeight/2);drawVirtual();
  }
  function drawVirtual(){const list=document.querySelector('#chapter-list');if(!list||currentBook()?.id!==virtualBookId)return;const start=Math.max(0,Math.floor(list.scrollTop/80)-6),end=Math.min(virtualEntries.length,start+Math.ceil((list.clientHeight||560)/80)+14);
    const windowNode=list.querySelector('.chapter-virtual-window');windowNode.style.transform=`translateY(${start*80}px)`;windowNode.innerHTML=virtualEntries.slice(start,end).map(({chapter,index})=>`<button class="${index===reader.chapter?'active':''}" data-chapter="${index}"><span>${escapeHTML(chapter.title)}</span>${index===reader.chapter?'<em>正在读</em>':''}</button>`).join('');
  }
  function bind(){document.querySelector('[data-retry-library]')?.addEventListener('click',retry);document.querySelectorAll('[data-check-updates]').forEach(b=>b.addEventListener('click',()=>checkUpdates(b.dataset.checkUpdates)));
    const list=document.querySelector('#chapter-list');if(list){list.addEventListener('scroll',drawVirtual,{passive:true});list.addEventListener('click',e=>{const button=e.target.closest('[data-chapter]');if(button)void goToChapter(Number(button.dataset.chapter));});}}
  async function checkUpdates(id){
    const book=library.find(b=>b.id===id);if(!book||!isOnlineBook(book)||checkBusy)return;if(!libraryReady){showToast('请先重新读取书架');return;}if(!navigator.onLine){showToast('检查新章节需要联网');return;}
    checkBusy=true;shelfAction=emptyShelfAction();const previous=book.chapters,previousChecked=book.lastUpdateCheckedAt;render();
    try{const catalog=await QrxSources.catalog(book);if(catalog.remoteSource!==book.remoteSource||catalog.remoteBookId!==book.remoteBookId||!Array.isArray(catalog.chapters)||catalog.chapters.length<previous.length||catalog.chapters.length>12000)throw new Error('来源目录发生变化，已保留原有目录和缓存');
      const seen=new Set();catalog.chapters.forEach((c,i)=>{if(!/^\d{1,20}$/.test(c.sourceChapterId||'')||!c.title||seen.has(c.sourceChapterId)||i<previous.length&&String(c.sourceChapterId)!==String(previous[i].sourceChapterId))throw new Error('目录顺序或章节标识变化，已保留原书');seen.add(c.sourceChapterId);});
      if(!library.includes(book))throw new Error('这本书已不在书架，未保存更新');
      book.chapters=catalog.chapters.map((c,i)=>i<previous.length?{...previous[i],title:String(c.title).slice(0,200)}:{title:String(c.title).slice(0,200),sourceChapterId:String(c.sourceChapterId),sourceUrl:safeSourceUrl(c.sourceUrl),text:''});book.lastUpdateCheckedAt=Date.now();
      if(!await persist()){book.chapters=previous;book.lastUpdateCheckedAt=previousChecked;throw new Error('新目录没有保存成功，原目录和进度已保留');}
      const added=book.chapters.length-previous.length;showToast(added?`已新增 ${added} 章，原进度和缓存保留`:'当前来源暂时没有新章节');
    }catch(e){showToast(e?.message||'检查更新失败，原书不受影响');}finally{checkBusy=false;render();}
  }
  return{notice,hydrate,persist,retry,bind,toggleBookmark,removeBookmark,saveProgress,mergeCached,renderPage,sheet,filterChapters,checkUpdates};
})();
