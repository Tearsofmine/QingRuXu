import {parseHTML} from 'linkedom';
import {upstream} from './upstream.mjs';
const BASE='https://www.zongheng.com';
const validId=value=>/^\d{1,10}$/.test(String(value));
const plain=value=>parseHTML(`<html><body>${String(value||'')}</body></html>`).document.body.textContent.trim();
export function parseZonghengSearch(payload){
 if(payload?.code!==0||!Array.isArray(payload.data?.datas?.list))throw new Error('纵横未返回正常搜索结果');
 const seen=new Set();return payload.data.datas.list.filter(b=>validId(b.bookId)&&!seen.has(String(b.bookId))&&seen.add(String(b.bookId))).slice(0,20).map(b=>({id:String(b.bookId),title:plain(b.name),author:plain(b.authorName)||'作者见原站',url:`${BASE}/detail/${b.bookId}`,snippet:'公开章节按章阅读；订阅章节需前往原站。'+plain(b.description).slice(0,80)}));
}
export function parseZonghengDirectory(payload,bookId){
 if(payload?.code!==0||!Array.isArray(payload.result?.chapterList))throw new Error('纵横未返回正常目录');
 const chapters=[],seen=new Set();
 for(const volume of payload.result.chapterList)for(const c of volume.chapterViewList||[]){
  const id=String(c.chapterId);if(String(c.bookId)!==bookId||!validId(id)||seen.has(id))continue;
  if(![0,1].includes(c.level))throw new Error('目录章节权限无法确认');
  seen.add(id);chapters.push({title:plain(c.chapterName),text:'',sourceChapterId:id,sourceUrl:`https://read.zongheng.com/chapter/${bookId}/${id}.html`,expectedLength:Number(c.wordNums)||0,restricted:c.level!==0});
 }
 if(!chapters.length||chapters.length>12000)throw new Error('纵横目录为空或超出限制');return chapters;
}
export function parseZonghengContent(html,chapter){
 const {document}=parseHTML(html);const readUrl=document.querySelector('meta[property="og:novel:read_url"]')?.getAttribute('content');
 if(!readUrl||new URL(readUrl,'https://read.zongheng.com').href!==chapter.sourceUrl)throw new Error('来源返回的不是请求的章节，未保存');
 const content=document.querySelector('.content');
 if(!content)throw new Error('纵横没有返回可读取的正文，请在原站查看');
 content.querySelectorAll('script,style,iframe,form,button,[hidden]').forEach(e=>e.remove());
 const text=[...content.querySelectorAll('p')].map(p=>p.textContent.trim()).filter(Boolean).join('\n\n');
 if(text.length<Math.max(100,chapter.expectedLength*.75)||text.length>1000000)throw new Error('纵横只返回短预览或正文不完整，未保存；请在原站继续阅读');
 if((text.match(/[\uE000-\uF8FF]/g)||[]).length>text.length*.02)throw new Error('章节依赖专用字体，不能可靠读取');return text;
}
export function createZonghengSource(fetchPage=upstream){
 const directories=new Map(),cache=new Map();
 async function directory(bookId,signal){
  if(!validId(bookId))throw new Error('作品标识无效');
  const saved=directories.get(bookId);if(saved&&Date.now()-saved.at<600000)return saved.book;
  const html=await(await fetchPage(`${BASE}/detail/${bookId}`,{signal})).text();const {document}=parseHTML(html);
  const meta=name=>document.querySelector(`meta[name="og:novel:${name}"]`)?.getAttribute('content')?.trim();
  const title=meta('book_name'),author=meta('author');if(!title||!author)throw new Error('未取得纵横作品名称和作者');
  const payload=await(await fetchPage('https://bookapi.zongheng.com/api/chapter/getChapterList',{signal,method:'POST',body:new URLSearchParams({bookId}).toString()})).json();
  const chapters=parseZonghengDirectory(payload,bookId),book={title,author,chapters};
  if(directories.size>=8)directories.delete(directories.keys().next().value);directories.set(bookId,{at:Date.now(),book});return book;
 }
 async function readChapter(bookId,chapterId,signal){
  if(!validId(chapterId))throw new Error('章节标识无效');
  const book=await directory(bookId,signal),chapter=book.chapters.find(c=>c.sourceChapterId===chapterId);if(!chapter)throw new Error('章节不在该作品目录内');
  if(chapter.restricted)throw new Error('这一章为纵横订阅章节，请前往原站阅读；阅读位置已保留');
  const key=`${bookId}/${chapterId}`,saved=cache.get(key);if(saved&&Date.now()-saved.at<600000)return saved.value;
  const html=await(await fetchPage(chapter.sourceUrl,{signal})).text(),text=parseZonghengContent(html,chapter);
  const value={title:chapter.title,text,sourceChapterId:chapterId,sourceUrl:chapter.sourceUrl};
  if(cache.size>=24)cache.delete(cache.keys().next().value);cache.set(key,{at:Date.now(),value});return value;
 }
 return {id:'zongheng',name:'纵横中文网',defaultEnabled:true,description:'玄幻、仙侠等网文，可搜《逆天邪神》《剑来》等。公开章节可在清如许阅读，订阅章节需在原站阅读。',
  async search(query,signal){const params=new URLSearchParams({keyword:query,sort:'null',pageNo:'1',pageNum:'20',isFromHuayu:'0'});return parseZonghengSearch(await(await fetchPage(`https://search.zongheng.com/search/book?${params}`,{signal})).json());},
  async prepare(bookId,signal){const book=await directory(bookId,signal),first=await readChapter(bookId,book.chapters[0].sourceChapterId,signal),free=book.chapters.filter(c=>!c.restricted).length;return {...book,source:'纵横中文网',sourceUrl:`${BASE}/detail/${bookId}`,sourceNotice:`${book.author}《${book.title}》｜纵横中文网\n目录共 ${book.chapters.length} 条，其中 ${free} 条标为公开章节（仍需逐章验证正文）。订阅章节仅展示目录，不导入付费正文。版权归作者及相应权利人。`,remoteSource:'zongheng',remoteBookId:bookId,first,root:{children:book.chapters.map(c=>c.title)}};},
  async download(preview,signal,onProgress){signal.throwIfAborted();const{first,root,...book}=preview;onProgress({done:1,total:book.chapters.length,title:'首章已缓存，公开章节阅读时加载'});return {...book,chapters:book.chapters.map((c,i)=>({title:c.title,text:i===0?first.text:'',sourceChapterId:c.sourceChapterId,sourceUrl:c.sourceUrl}))};},readChapter};
}
