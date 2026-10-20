import {parseHTML} from 'linkedom';
import {upstream} from './upstream.mjs';
const BASE='https://www.tadu.com';
function validId(value){return /^\d{1,10}$/.test(String(value));}
export function parseTaduSearch(html) {
 const {document}=parseHTML(html);const found=new Map();
 for(const link of document.querySelectorAll('.search_left li .bookNm')){
  const match=link.getAttribute('href')?.match(/^\/book\/(\d{1,10})\/?$/);if(!match)continue;
  const row=link.closest('li');const title=link.textContent.trim();if(!title)continue;
  found.set(match[1],{id:match[1],title,author:row.querySelector('.authorNm')?.textContent.trim()||'作者见来源',url:`${BASE}/book/${match[1]}/`,snippet:(row.querySelector('.bookIntro')?.textContent.trim()||'').slice(0,160)});
 }
 if(!document.querySelector('.search_left'))throw new Error('书源未返回正常搜索页面，请稍后重试');
 return [...found.values()].slice(0,20);
}
export function parseTaduDirectory(html,bookId) {
 const {document}=parseHTML(html);const title=document.querySelector('.bookNm .bkNm, .bkNm')?.textContent.trim();
 const author=document.querySelector('.bookNm .author, .author')?.textContent.replace(/\s*著\s*$/,'').trim();
 if(!title||!author)throw new Error('没有取得作品名称和作者');
 const seen=new Set();const chapters=[];
 for(const link of document.querySelectorAll('a[title*="章节字数"]')){
  const match=link.getAttribute('href')?.match(/^\/book\/(\d{1,10})\/(\d{1,12})\/?$/);
  if(!match||match[1]!==bookId||seen.has(match[2]))continue;seen.add(match[2]);
  const name=link.textContent.trim();if(!name)continue;
  chapters.push({title:name,text:'',sourceChapterId:match[2],sourceUrl:`${BASE}/book/${bookId}/${match[2]}/`,expectedLength:Number(link.getAttribute('title').match(/章节字数[:：]\s*(\d+)/)?.[1])||0});
 }
 if(!chapters.length||chapters.length>12000)throw new Error('没有取得完整、可识别的目录');
 return {title,author,chapters};
}
export function parseTaduContent(payload,expectedLength=0) {
 if(payload?.status!==200||payload.redirectUrl||payload.data?.url)throw new Error('这一章需要前往原站继续阅读，清如许未获取正文');
 const html=payload.data?.content;if(typeof html!=='string')throw new Error('来源未返回章节正文');
 const {document}=parseHTML(`<html><body>${html}</body></html>`);
 document.querySelectorAll('script,style,iframe,form,button,img,[hidden],[style*="display:none"],[style*="display: none"]').forEach(e=>e.remove());
 // Standalone station promotions contain deliberately inserted punctuation.
 // Preserve author notes and requests for votes/collections.
 document.querySelectorAll('p').forEach(paragraph=>{
  const raw=paragraph.textContent.trim();const normalized=raw.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
  if(raw.length<220&&!/作者|求票|月票|推荐票|收藏/.test(normalized)&&normalized.includes('塔读')&&/首发|原文来自|站点|下载|无广告|无弹窗/.test(normalized))paragraph.remove();
 });
 document.querySelectorAll('br').forEach(e=>e.replaceWith(document.createTextNode('\n')));
 const text=[...document.querySelectorAll('p')].map(p=>p.textContent.trim()).filter(Boolean).join('\n\n');
 if(!text||text.length>1000000)throw new Error('这一章的正文长度异常');
 if(text.length<Math.max(expectedLength>0?Math.floor(expectedLength*0.7):200,30))throw new Error('来源只返回了本章短预览，完整正文请在原站阅读；阅读位置已保留');
 if(/下载.{0,8}(?:APP|客户端).{0,15}(?:继续|完整|本章)|订阅后.{0,8}阅读|登录后.{0,8}阅读/.test(text)&&text.length<500)throw new Error('这一章需要在原站阅读，清如许未获取完整正文');
 if((text.match(/[\uE000-\uF8FF]/g)||[]).length>text.length*0.02)throw new Error('章节文字编码无法可靠读取');
 return text;
}
export function createTaduSource(fetchPage=upstream) {
 const directories=new Map();const cachedChapters=new Map();
 async function directory(bookId,signal){
  if(!validId(bookId))throw new Error('作品标识无效');
  const cached=directories.get(bookId);if(cached&&Date.now()-cached.at<10*60000)return cached.book;
  const html=await(await fetchPage(`${BASE}/book/${bookId}`,{signal})).text();const book=parseTaduDirectory(html,bookId);
  if(directories.size>=8)directories.delete(directories.keys().next().value);directories.set(bookId,{book,at:Date.now()});return book;
 }
 async function readChapter(bookId,chapterId,signal){
  if(!validId(bookId)||!/^\d{1,12}$/.test(chapterId))throw new Error('章节标识无效');
  const book=await directory(bookId,signal);const chapter=book.chapters.find(c=>c.sourceChapterId===chapterId);if(!chapter)throw new Error('该章节不在作品目录中，请重新搜索作品');
  const key=`${bookId}/${chapterId}`,cached=cachedChapters.get(key);if(cached&&Date.now()-cached.at<10*60000)return cached.value;
  const html=await(await fetchPage(chapter.sourceUrl,{signal})).text();const {document}=parseHTML(html);
  const resource=document.querySelector('#bookPartResourceUrl')?.getAttribute('value');
  if(!resource||!new RegExp(`^/getPartContentByCodeTable/${bookId}/[1-9]\\d{0,7}$`).test(resource))throw new Error('未找到公开的章节正文地址');
  const payload=await(await fetchPage(BASE+resource,{signal})).json();const text=parseTaduContent(payload,chapter.expectedLength);
  const value={title:chapter.title,text,sourceUrl:chapter.sourceUrl,sourceChapterId:chapterId};
  if(cachedChapters.size>=24)cachedChapters.delete(cachedChapters.keys().next().value);cachedChapters.set(key,{at:Date.now(),value});return value;
 }
 return {id:'tadu',name:'塔读小说',defaultEnabled:true,description:'网文来源，按章联网读取；读过的章节可离线。部分后段章节仅提供短预览，会明确提示。',
  async search(query,signal){const html=await(await fetchPage(`${BASE}/search`,{signal,method:'POST',body:new URLSearchParams({query}).toString()})).text();return parseTaduSearch(html);},
  async prepare(bookId,signal){const book=await directory(bookId,signal);const first=await readChapter(bookId,book.chapters[0].sourceChapterId,signal);return {...book,source:'塔读小说',sourceUrl:`${BASE}/book/${bookId}/`,sourceNotice:`${book.author}《${book.title}》｜塔读小说\n采用官网公开阅读路径，按章加载。目录条目不代表每章完整正文均可取得；短预览或需在原站阅读的章节会停止加载并提示。书籍版权归作者及相应权利人，完整信息见原站。`,remoteSource:'tadu',remoteBookId:bookId,first,root:{children:book.chapters.map(c=>c.title)}};},
  async download(preview,signal,onProgress){signal.throwIfAborted();const {first,root,...book}=preview;const chapters=book.chapters.map((c,index)=>({title:c.title,text:index===0?first.text:'',sourceUrl:c.sourceUrl,sourceChapterId:c.sourceChapterId}));onProgress({done:1,total:chapters.length,title:'首章已缓存，其余章节阅读时加载'});return {...book,chapters};},
  readChapter
 };
}
