import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSources } from './sources.mjs';
const defaults = fileURLToPath(new URL('../qingruxu-pwa-v36/',import.meta.url));
const assets = new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/online-source.js','online-source.js'],['/styles.css','styles.css'],['/sw.js','sw.js'],['/manifest.webmanifest','manifest.webmanifest'],['/assets/icon.svg','assets/icon.svg']]);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function message(error) {
  if(['AbortError','TimeoutError'].includes(error?.name))return '连接这个书源超时，请换一个来源或稍后重试';
  if(error?.name==='TypeError'&&error.message==='fetch failed')return '无法连接这个书源，请换一个来源；这不表示没有这本书';
  return String(error?.message || '书源暂不可用').slice(0,250);
}
export function createServer({sources=createSources(),webRoot=defaults}={}) {
  const providers = new Map(sources.map(s=>[s.id,s]));
  const previews = new Map();let active=0;let windowStart=0;let requests=0;
  const server=http.createServer(async(req,res)=>{
    const host=req.headers.host;const port=server.address()?.port;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)) return send(res,403,{error:'本地服务拒绝此 Host'});
    const origin=req.headers.origin;
    if(origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(origin)) return send(res,403,{error:'只接受本地清如许页面请求'});
    if(req.method!=='GET') return send(res,405,{error:'只支持只读请求'});
    const url=new URL(req.url,`http://${host}`);
    if(!url.pathname.startsWith('/qrx-api/')) {
      const file=assets.get(url.pathname);if(!file) return send(res,404,{error:'没有这个页面'});
      try {const content=await readFile(path.join(webRoot,file));res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(content);}
      catch {send(res,404,{error:'找不到 v36 页面，请将服务文件夹与 qingruxu-pwa-v36 放在同一目录'});}
      return;
    }
    // Cross-site scripts cannot set this header without a preflight; no CORS is granted.
    if(req.headers['x-qrx-client']!=='1') return send(res,403,{error:'缺少本地阅读器请求标记'});
    if(Date.now()-windowStart>60000){windowStart=Date.now();requests=0;}
    if(++requests>60 || active>=4) return send(res,429,{error:'请求较多，请稍后再试'});
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),120000);
    res.on('close',()=>{if(!res.writableEnded) controller.abort();});active+=1;const {signal}=controller;
    try {
      for(const[id,item]of previews)if(item.expires<Date.now())previews.delete(id);
      if(url.pathname==='/qrx-api/sources') return send(res,200,{version:1,mode:'local-only',sources:sources.filter(s=>s.searchable!==false&&s.freeOnly===true).map(({id,name,description,defaultEnabled,freeOnly})=>({id,name,description,defaultEnabled,freeOnly}))});
      if(url.pathname==='/qrx-api/search') {
        const query=(url.searchParams.get('q')||'').trim();
        if(!query || query.length>100) return send(res,400,{error:'书名长度应为 1–100 字'});
        const configured=sources.filter(s=>s.searchable!==false&&s.freeOnly===true).map(s=>s.id);
        const ids=url.searchParams.has('sources')?[...new Set((url.searchParams.get('sources')||'').split(',').filter(Boolean))]:configured;
        if(!ids.length || ids.some(id=>!configured.includes(id))) return send(res,400,{error:'没有可查询的免费渠道'});
        const outcomes=await Promise.all(ids.map(async id=>{
          const source=providers.get(id);const started=Date.now();
          try {const items=await source.search(query,signal);return {id,name:source.name,status:'ok',elapsedMs:Date.now()-started,results:items.map(i=>({...i,sourceId:id,sourceName:source.name}))};}
          catch(error){return {id,name:source.name,status:'error',elapsedMs:Date.now()-started,error:message(error),results:[]};}
        }));
        if(signal.aborted || res.destroyed)return;
        return send(res,200,{outcomes,results:outcomes.flatMap(o=>o.results)});
      }
      if(url.pathname==='/qrx-api/preview') {
        const source=providers.get(url.searchParams.get('source'));const id=url.searchParams.get('id');
        if(!source || source.searchable===false || source.freeOnly!==true || !id || id.length>250) return send(res,400,{error:'作品标识无效或渠道已停止新增'});
        const preview=await source.prepare(id,signal);signal.throwIfAborted();
        if(previews.size>=8)previews.delete(previews.keys().next().value);
        const previewId=randomUUID();previews.set(previewId,{source,preview,expires:Date.now()+10*60000});
        return send(res,200,{previewId,sourceId:source.id,sourceName:source.name,title:preview.title,author:preview.author,sourceUrl:preview.sourceUrl,sourceNotice:preview.sourceNotice||preview.notice||'',sourceLicenseUrl:preview.sourceLicenseUrl||'',accessLabel:preview.accessLabel||'',chapterCount:preview.chapters?.length,readingMode:preview.remoteSource?'online':'download',first:{text:preview.first.text.slice(0,600)},root:{children:preview.root.children}});
      }
      if(url.pathname==='/qrx-api/catalog') {
        const source=providers.get(url.searchParams.get('source')),book=url.searchParams.get('book');
        if(!source?.catalog||source.freeOnly!==true||source.searchable===false||!/^\d{1,10}$/.test(book||''))return send(res,400,{error:'此来源暂不支持检查目录更新'});
        const result=await source.catalog(book,signal);signal.throwIfAborted();return send(res,200,result);
      }
      if(url.pathname==='/qrx-api/chapter') {
        const source=providers.get(url.searchParams.get('source'));const book=url.searchParams.get('book'),chapter=url.searchParams.get('chapter');
        if(!source?.readChapter||!book||!chapter)return send(res,400,{error:'来源或章节标识无效'});
        const result=await source.readChapter(book,chapter,signal);signal.throwIfAborted();return send(res,200,result);
      }
      if(url.pathname==='/qrx-api/download') {
        const entry=previews.get(url.searchParams.get('id'));
        if(!entry)return send(res,410,{error:'预览已过期或服务已重启，请重新预览后下载'});
        res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        const emit=event=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');};
        try {const book=await entry.source.download(entry.preview,signal,p=>emit({type:'progress',progress:p}));signal.throwIfAborted();emit({type:'book',book});res.end();}
        catch(error){emit({type:'error',error:message(error)});res.end();}
        return;
      }
      return send(res,404,{error:'未知接口'});
    } catch(error){if(!res.destroyed&&!res.headersSent)send(res,502,{error:message(error)});}
    finally{clearTimeout(timeout);active-=1;}
  });
  return server;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.QRX_PORT||4191);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('QRX_PORT 必须是 1024–65535');
  const server=createServer();
  server.on('error',e=>{console.error(`启动失败：${e.message}`);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`清如许本地验证版：http://127.0.0.1:${port}/\n仅限本机；请勿直接暴露公网。现有手机书架不受影响。`));
}
