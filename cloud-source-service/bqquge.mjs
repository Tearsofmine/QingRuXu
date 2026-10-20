import{parseHTML}from'linkedom';import{upstream}from'./upstream.mjs';import{parseSuduguChapterPage}from'./sudugu.mjs';
const BASE='https://www.bqquge.org',valid=x=>/^\d{1,10}$/.test(String(x)),key=x=>String(x||'').normalize('NFKC').replace(/[\s\p{P}]/gu,'').toLowerCase();
export function parseBqSearch(html,query){
 const{document:d}=parseHTML(html),items=new Map();if(!d.querySelector('title')?.textContent.includes('搜索'))throw new Error('未取得正常搜索结果');
 for(const a of d.querySelectorAll('.itemtxt h3 a[href]')){const m=a.getAttribute('href')?.match(/^\/(\d{1,10})$/);if(!m)continue;const title=a.textContent.trim(),author=a.closest('.itemtxt').querySelector('a[href^="/zuozhe/"]')?.textContent.replace(/^作者[:：]\s*/,'').trim();if(!title||!author||!(key(title).includes(key(query))||key(author).includes(key(query))))continue;items.set(m[1],{id:m[1],title,author,url:`${BASE}/${m[1]}`,snippet:'公开免费转载，授权未核实。',access:'free',accessLabel:'免费 · 第三方转载'});}return[...items.values()].slice(0,20);
}
export function parseBqDirectory(html,bookId){
 const{document:d}=parseHTML(html),title=d.querySelector('h1')?.textContent.trim(),author=d.querySelector('a[href^="/zuozhe/"]')?.textContent.replace(/^作者[:：]\s*/,'').trim(),seen=new Set(),chapters=[];
 for(const a of d.querySelectorAll('#list a[href]')){const m=a.getAttribute('href')?.match(new RegExp(`^/${bookId}/(\\d{1,10})$`));if(!m||seen.has(m[1]))continue;seen.add(m[1]);chapters.push({title:a.textContent.trim(),text:'',sourceChapterId:m[1],sourceUrl:`${BASE}/${bookId}/${m[1]}`});}
 if(!title||!author||!chapters.length||chapters.length>12000)throw new Error('未取得可识别的作品信息与目录');return{title,author,chapters};
}
export function createBqqugeSource(fetchPage=upstream){
 const directories=new Map(),texts=new Map();
 async function directory(id,signal,fresh=false){if(!valid(id))throw new Error('作品标识无效');const c=directories.get(id);if(!fresh&&c&&Date.now()-c.at<600000)return c.book;const book=parseBqDirectory(await(await fetchPage(`${BASE}/${id}`,{signal})).text(),id);if(directories.size>=8)directories.delete(directories.keys().next().value);directories.set(id,{at:Date.now(),book});return book;}
 async function readChapter(bookId,chapterId,signal){
  if(!valid(chapterId))throw new Error('章节标识无效');const book=await directory(bookId,signal),chapter=book.chapters.find(c=>c.sourceChapterId===chapterId);if(!chapter)throw new Error('章节不在作品目录内');const id=`${bookId}/${chapterId}`,cached=texts.get(id);if(cached&&Date.now()-cached.at<600000)return cached.value;
  let url=chapter.sourceUrl;const visited=new Set(),parts=[];while(url){signal?.throwIfAborted();if(visited.has(url)||visited.size>=40)throw new Error('章节分页异常，未保存半章');visited.add(url);const p=parseSuduguChapterPage(await(await fetchPage(url,{signal})).text(),chapter,bookId,BASE,'');parts.push(p.text);if(parts.reduce((s,t)=>s+t.length,0)>1000000)throw new Error('章节正文过大');url=p.next;}
  const text=parts.join('\n\n');if(text.length<200&&!/感言|后记|新书|作者|公告|通知|感谢/.test(chapter.title))throw new Error('章节正文过短，未保存');const value={title:chapter.title,text,sourceUrl:chapter.sourceUrl,sourceChapterId:chapterId};if(texts.size>=24)texts.delete(texts.keys().next().value);texts.set(id,{at:Date.now(),value});return value;
 }
 return{id:'bqquge',name:'笔趣阁 · BQ',freeOnly:true,description:'bqquge.org 公开免费转载，授权未核实；章节分页逐页读取。',
 async catalog(id,signal){const book=await directory(id,signal,true);return{...book,remoteSource:'bqquge',remoteBookId:id};},
 async search(q,signal){return parseBqSearch(await(await fetchPage(`${BASE}/so/${encodeURIComponent(q)}`,{signal})).text(),q);},
 async prepare(id,signal){const book=await directory(id,signal),first=await readChapter(id,book.chapters[0].sourceChapterId,signal);await readChapter(id,book.chapters.at(-1).sourceChapterId,signal);return{...book,source:'笔趣阁 · BQ',sourceUrl:`${BASE}/${id}`,sourceNotice:`${book.author}《${book.title}》｜bqquge.org（第三方转载，授权未核实）\n公开页面无需付费，首章及当前末章已核验。未逐章遍历，不保证转载无缺漏或与原站同步。版权归作者及权利人。`,remoteSource:'bqquge',remoteBookId:id,first,root:{children:book.chapters.map(c=>c.title)}};},
 async download(p,signal,progress){signal.throwIfAborted();const{first,root,...book}=p;progress({done:1,total:book.chapters.length,title:'首章已保存，其余随读缓存'});return{...book,chapters:book.chapters.map((c,i)=>({...c,text:i===0?first.text:''}))};},readChapter};
}
