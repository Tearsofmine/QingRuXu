/* Private HTTPS client. The key is never bundled, rendered, or exported. */
globalThis.QrxSources = (() => {
  const API = 'https://qingruxu.onrender.com';
  const KEY = 'qingruxu-private-source-token-v1';
  let connecting = null, generation = 0;
  const valid = value => /^[A-Za-z0-9+/_=-]{32,256}$/.test(value || '') && new Set(value).size >= 8;
  function savedToken() { try { const value = localStorage.getItem(KEY) || ''; return valid(value) ? value : ''; } catch { return ''; } }
  async function response(route, signal, token = savedToken()) {
    if (!valid(token)) throw new Error('请先到“我的 → 私人书源”填写访问密钥；本地小说仍可阅读');
    const timeout = AbortSignal.timeout(150000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let r;
    try {
      r = await fetch(`${API}/qrx-api/${route}`, { signal:combined, credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer', headers:{'X-Qrx-Client':'1', Authorization:`Bearer ${token}`} });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new Error('书源后台响应超时，可能正在唤醒，请稍后重试；本地小说不受影响');
      throw new Error('暂时无法连接书源后台，请检查网络或稍后重试；本地小说仍可阅读');
    }
    if (r.status === 401) throw new Error('访问密钥不正确或已更换，请在“我的 → 私人书源”重新填写');
    if (r.status === 403) throw new Error('后台拒绝了当前网页来源，请检查 QRX_ALLOWED_ORIGIN 配置');
    if (r.status === 429) throw new Error('请求较多，请稍后再试');
    if (!r.headers.get('content-type')?.includes('application/')) throw new Error('后台可能正在唤醒或暂不可用，请稍后重试');
    if (!r.ok) {
      if (r.status >= 500) throw new Error('书源暂时无法读取，请稍后重试或换一个渠道');
      throw new Error(r.status === 410 ? '预览已过期或后台已重启，请重新预览' : '书源请求无效，请重新搜索或预览');
    }
    return r;
  }
  async function json(route, signal, token) { const r = await response(route,signal,token); try { return await r.json(); } catch { throw new Error('后台响应格式异常，请稍后重试'); } }
  function validateSources(data) { if (!Array.isArray(data?.sources) || !data.sources.length || data.sources.some(s => !s.id || s.freeOnly !== true)) throw new Error('后台没有返回有效的免费书源列表'); return data; }
  async function connect(value) {
    const token = String(value || '').trim() || savedToken();
    if (!valid(token)) throw new Error('请粘贴 Render 中生成的 QRX_API_TOKEN，至少 32 位；不要把密钥发到聊天或公开仓库');
    connecting?.abort(); const controller = new AbortController(); connecting = controller; const task = ++generation;
    try {
      const data = validateSources(await json('sources',controller.signal,token));
      controller.signal.throwIfAborted(); if (task !== generation) throw new Error('连接已取消');
      try { localStorage.setItem(KEY,token); } catch { throw new Error('此浏览器无法保存连接密钥，请检查网站存储权限；书架未改动'); }
      return { count:data.sources.length };
    } finally { if (connecting === controller) connecting = null; }
  }
  function forget() { generation++; connecting?.abort(); localStorage.removeItem(KEY); }
  const configuration = () => ({ url:API, configured:Boolean(savedToken()) });
  const list = async signal => validateSources(await json('sources',signal));
  const search = (q,signal) => json(`search?${new URLSearchParams({q})}`,signal);
  const prepare = (item,signal) => json(`preview?${new URLSearchParams({source:item.sourceId,id:item.id})}`,signal);
  async function chapter(book,entry,signal) {
    const result = await json(`chapter?${new URLSearchParams({source:book.remoteSource,book:book.remoteBookId,chapter:entry.sourceChapterId})}`,signal);
    if(result.sourceChapterId !== entry.sourceChapterId || typeof result.text !== 'string' || !result.text.trim()) throw new Error('没有收到正确的章节正文，阅读位置已保留');
    return result;
  }
  async function download(preview,signal,onProgress=()=>{}) {
    const r=await response(`download?${new URLSearchParams({id:preview.previewId})}`,signal);
    if(!r.headers.get('content-type')?.includes('application/x-ndjson'))throw new Error('服务返回的不是正文数据');
    const reader=r.body.getReader(), decoder=new TextDecoder();let buffer='',book=null,size=0;
    function consume(line){if(!line.trim())return;const item=JSON.parse(line);if(item.type==='error')throw new Error('书源没有返回完整正文，请重新预览后再试');if(item.type==='progress')onProgress(item.progress);if(item.type==='book')book=item.book;}
    try {
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64*1024*1024)throw new Error('下载内容超出本版容量');buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n'))!==-1){consume(buffer.slice(0,end));buffer=buffer.slice(end+1);}}
      buffer+=decoder.decode();consume(buffer);signal?.throwIfAborted();
      const online=['tadu','zongheng','sudugu','bqquge'].includes(book?.remoteSource)&&/^\d{1,10}$/.test(book.remoteBookId||'');
      if(!book||!Array.isArray(book.chapters)||!book.chapters.length||book.chapters.some(c=>typeof c.text!=='string'||(!online&&!c.text.trim())||(online&&!/^\d{1,20}$/.test(c.sourceChapterId||'')))||!book.chapters[0].text.trim())throw new Error('没有收到有效的目录与首章，未加入书架');
      return book;
    } finally { await reader.cancel().catch(()=>{}); }
  }
  return { get available(){return Boolean(savedToken());},configuration,connect,forget,list,search,prepare,download,chapter };
})();
