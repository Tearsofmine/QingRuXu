/* Same-origin private source-service client. No arbitrary proxy or remote code. */
globalThis.QrxSources = (() => {
  const unavailableMessage = "手机端书源后台尚未连接。已导入的 TXT 和已缓存章节仍可阅读；新书搜索及未缓存章节需连接 HTTPS 书源后台。";
  async function response(route,signal){
    throw new Error(unavailableMessage);
    try {
      const r=await fetch(`/qrx-api/${route}`,{signal,credentials:'omit',cache:'no-store',headers:{'X-Qrx-Client':'1'}});
      if(!r.ok){let data;try{data=await r.json();}catch{}throw new Error(data?.error||'没有连接到本地书源服务，请用服务提供的地址打开此验证版');}
      return r;
    }catch(error){if(signal?.aborted)throw error;if(error instanceof TypeError)throw new Error('书源服务未启动或连接中断；已导入小说仍可阅读');throw error;}
  }
  async function json(route,signal){const r=await response(route,signal);try{return await r.json();}catch{throw new Error('书源服务响应格式异常，请检查打开的是否是本地验证地址');}}
  const list=signal=>json('sources',signal);
  const search=(q,signal)=>json(`search?${new URLSearchParams({q})}`,signal);
  const prepare=(item,signal)=>json(`preview?${new URLSearchParams({source:item.sourceId,id:item.id})}`,signal);
  async function chapter(book,entry,signal){
    const result=await json(`chapter?${new URLSearchParams({source:book.remoteSource,book:book.remoteBookId,chapter:entry.sourceChapterId})}`,signal);
    if(result.sourceChapterId!==entry.sourceChapterId||typeof result.text!=='string'||!result.text.trim())throw new Error('没有收到正确的章节正文，阅读位置已保留');
    return result;
  }
  async function download(preview,signal,onProgress=()=>{}){
    const r=await response(`download?${new URLSearchParams({id:preview.previewId})}`,signal);
    if(!r.headers.get('content-type')?.includes('application/x-ndjson'))throw new Error('服务返回的不是正文数据');
    const reader=r.body.getReader();const decoder=new TextDecoder();let buffer='',book=null,size=0;
    function consume(line){if(!line.trim())return;const item=JSON.parse(line);if(item.type==='error')throw new Error(item.error);if(item.type==='progress')onProgress(item.progress);if(item.type==='book')book=item.book;}
    try {
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64*1024*1024)throw new Error('下载内容超出本版容量');buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n'))!==-1){consume(buffer.slice(0,end));buffer=buffer.slice(end+1);}}
      buffer+=decoder.decode();consume(buffer);signal?.throwIfAborted();
      const online=['tadu','zongheng','sudugu','bqquge'].includes(book?.remoteSource)&&/^\d{1,10}$/.test(book.remoteBookId||'');
      if(!book || !Array.isArray(book.chapters) || !book.chapters.length || book.chapters.some(c=>typeof c.text!=='string'||(!online&&!c.text.trim())||(online&&!/^\d{1,20}$/.test(c.sourceChapterId||'')))||!book.chapters[0].text.trim())throw new Error('没有收到有效的目录与首章，未加入书架');
      return book;
    }finally{await reader.cancel().catch(()=>{});}
  }
  return {list,search,prepare,download,chapter,available:false,unavailableMessage};
})();
