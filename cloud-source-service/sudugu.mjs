import {parseHTML} from 'linkedom';
import {upstream} from './upstream.mjs';
const BASE='https://www.suduguu.com',validId=x=>/^\d{1,10}$/.test(String(x));
const key=x=>String(x||'').normalize('NFKC').replace(/[\s\p{P}]/gu,'').toLowerCase();
function documentOf(html){return parseHTML(html).document;}
export function parseSuduguSearch(html,query){
 const d=documentOf(html),found=new Map();
 if(!d.querySelector('title')?.textContent.includes('搜索'))throw new Error('来源未返回正常搜索页面');
 for(const a of d.querySelectorAll('.itemtxt h3 a[href]')){
  const match=a.getAttribute('href')?.match(/^\/(\d{1,10})\/$/);if(!match)continue;
  const row=a.closest('.itemtxt'),title=a.textContent.trim(),author=row.querySelector('a[href^="/zuozhe/"]')?.textContent.replace(/^作者[:：]\s*/,'').trim();
  if(!title||!author||!(key(title).includes(key(query))||key(author).includes(key(query))))continue;
  found.set(match[1],{id:match[1],title,author,url:`${BASE}/${match[1]}/`,snippet:'第三方公开转载，授权未核实；正文预览时核验。',access:'free',accessLabel:'公开免费转载 · 授权未核实'});
 }return[...found.values()].slice(0,20);
}
export function parseSuduguDirectoryPage(html,bookId){
 const d=documentOf(html),heading=d.querySelector('#dir'),list=d.querySelector('#list');
 if(!heading||!list)throw new Error('未取得可识别的章节目录');
 const chapters=[];
 for(const a of list.querySelectorAll('a[href]')){const m=a.getAttribute('href')?.match(new RegExp(`^/${bookId}/(\\d{1,10})\\.html$`));if(m&&a.textContent.trim())chapters.push({title:a.textContent.trim(),text:'',sourceChapterId:m[1],sourceUrl:`${BASE}/${bookId}/${m[1]}.html`});}
 const pages=[...d.querySelectorAll('a[href]')].map(a=>new URL(a.getAttribute('href'),`${BASE}/${bookId}/`)).filter(u=>u.origin===BASE&&new RegExp(`^/${bookId}/p-(?:[2-9]|[1-9]\\d)\\.html$`).test(u.pathname)).map(u=>u.origin+u.pathname);
 return{title:d.querySelector('h1 a')?.textContent.trim(),author:d.querySelector('a[href^="/zuozhe/"]')?.textContent.replace(/^作者[:：]\s*/,'').trim(),chapters,pages:[...new Set(pages)]};
}
export function parseSuduguChapterPage(html,chapter,bookId,base=BASE,suffix='\\.html'){
 const d=documentOf(html),h1=d.querySelector('h1'),root=d.querySelector('.con');
 if(!root||!key(h1?.textContent).includes(key(chapter.title)))throw new Error('来源没有返回正确章节正文');
 root.querySelectorAll('script,style,iframe,form,button,img,.ad,[hidden]').forEach(e=>e.remove());
 const text=[...root.querySelectorAll('p')].map(e=>e.textContent.trim()).filter(Boolean).join('\n\n');
 if(text.length<20||text.length>1000000||/订阅后阅读|付费解锁|登录后阅读|验证码|安全验证/.test(text))throw new Error('来源正文不可直接读取，未导入');
 if((text.match(/[\uE000-\uF8FF]/g)||[]).length>text.length*.02)throw new Error('来源文字编码不可读');
 const more=[...d.querySelectorAll('a[href]')].find(a=>/^(?:下一页|下页)$/.test(a.textContent.trim()));let next='';
 if(more){const u=new URL(more.getAttribute('href'),chapter.sourceUrl);if(u.origin!==base||!new RegExp(`^/${bookId}/${chapter.sourceChapterId}-(?:[2-9]|[1-9]\\d)${suffix}$`).test(u.pathname))throw new Error('章节分页地址异常，未导入');next=u.origin+u.pathname;}
 return{text,next};
}
export function createSuduguSource(fetchPage=upstream){
 const directories=new Map(),texts=new Map();
  async function directory(bookId,signal,fresh=false){
   if(!validId(bookId))throw new Error('作品标识无效');const cached=directories.get(bookId);if(!fresh&&cached&&Date.now()-cached.at<600000)return cached.book;
  const first=parseSuduguDirectoryPage(await(await fetchPage(`${BASE}/${bookId}/`,{signal})).text(),bookId);
  if(!first.title||!first.author)throw new Error('未取得作品名称及作者');
  const chapters=[...first.chapters],visited=new Set(),queue=[...first.pages];
  while(queue.length){signal?.throwIfAborted();const url=queue.shift();if(visited.has(url))continue;if(visited.size>=20)throw new Error('目录分页过多，未导入');visited.add(url);const page=parseSuduguDirectoryPage(await(await fetchPage(url,{signal})).text(),bookId);if(page.title!==first.title||page.author!==first.author)throw new Error('目录分页不属于同一本书');chapters.push(...page.chapters);for(const u of page.pages)if(!visited.has(u))queue.push(u);}
  const seen=new Set();if(!chapters.length||chapters.length>12000||chapters.some(c=>seen.has(c.sourceChapterId)||!seen.add(c.sourceChapterId)))throw new Error('目录缺失或存在重复章节，未导入');
  const book={title:first.title,author:first.author,chapters};if(directories.size>=8)directories.delete(directories.keys().next().value);directories.set(bookId,{at:Date.now(),book});return book;
 }
 async function readChapter(bookId,chapterId,signal){
  if(!validId(chapterId))throw new Error('章节标识无效');const book=await directory(bookId,signal),chapter=book.chapters.find(c=>c.sourceChapterId===chapterId);if(!chapter)throw new Error('章节不在作品目录内');
  const id=`${bookId}/${chapterId}`,cached=texts.get(id);if(cached&&Date.now()-cached.at<600000)return cached.value;
  let url=chapter.sourceUrl;const visited=new Set(),parts=[];
  while(url){signal?.throwIfAborted();if(visited.has(url)||visited.size>=40)throw new Error('章节分页循环或过多，未保存半章');visited.add(url);const page=parseSuduguChapterPage(await(await fetchPage(url,{signal})).text(),chapter,bookId);parts.push(page.text);if(parts.reduce((sum,t)=>sum+t.length,0)>1000000)throw new Error('章节过大，已停止');url=page.next;}
  const text=parts.join('\n\n');if(text.length<200)throw new Error('章节正文过短，未保存');
  const value={title:chapter.title,text,sourceChapterId:chapterId,sourceUrl:chapter.sourceUrl};if(texts.size>=24)texts.delete(texts.keys().next().value);texts.set(id,{value,at:Date.now()});return value;
 }
 return{id:'sudugu',name:'速读谷',freeOnly:true,description:'第三方公开免费转载源，授权未核实；逐章读取，不执行原站广告脚本。',
   async catalog(bookId,signal){const book=await directory(bookId,signal,true);return{...book,remoteSource:'sudugu',remoteBookId:bookId};},
  async search(query,signal){return parseSuduguSearch(await(await fetchPage(`${BASE}/i/sor.aspx?${new URLSearchParams({key:query})}`,{signal})).text(),query);},
  async prepare(bookId,signal){const book=await directory(bookId,signal),first=await readChapter(bookId,book.chapters[0].sourceChapterId,signal);await readChapter(bookId,book.chapters.at(-1).sourceChapterId,signal);return{...book,source:'速读谷',sourceUrl:`${BASE}/${bookId}/`,sourceNotice:`${book.author}《${book.title}》｜速读谷（第三方转载）\n公开网页无需付费；转载授权未核实，免费不等于已获版权授权。首章及当前末章正文和分页已核验，不保证逐章无缺漏或与原作同步。版权归作者及权利人。`,accessLabel:'首章及当前末章已核验 · 第三方转载',remoteSource:'sudugu',remoteBookId:bookId,first,root:{children:book.chapters.map(c=>c.title)}};},
  async download(preview,signal,onProgress){signal.throwIfAborted();const{first,root,...book}=preview;onProgress({done:1,total:book.chapters.length,title:'首章已保存，其余正文阅读时加载'});return{...book,chapters:book.chapters.map((c,i)=>({...c,text:i===0?first.text:''}))};},readChapter};
}
