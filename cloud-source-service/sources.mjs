import { DOMParser, parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { upstream } from './upstream.mjs';
import { createClassicsSource } from './classics.mjs';
import { createTaduSource } from './tadu.mjs';
import { createZonghengSource } from './zongheng.mjs';
import { createSuduguSource } from './sudugu.mjs';
import { createBqqugeSource } from './bqquge.mjs';

const SCP = 'https://scp-wiki-cn.wikidot.com';
const LICENSE = 'https://creativecommons.org/licenses/by-sa/3.0/';
const context = vm.createContext({URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout,fetch:upstream,
  DOMParser: class {parseFromString(html){return new DOMParser().parseFromString(`<html><body>${html}</body></html>`,'text/html');}}
});
vm.runInContext(readFileSync(new URL('./wikisource-adapter.cjs',import.meta.url),'utf8'),context);
const wiki = context.QrxSources;

export function parseStoryIndex(html) {
  const {document} = parseHTML(html); const results = new Map();
  for (const row of document.querySelectorAll('#page-content tr')) {
    const link = row.querySelector('td a[href^="/"]');
    const id = link?.getAttribute('href')?.slice(1);
    if (!id || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(id)) continue;
    const author = [...row.querySelectorAll('.printuser')].map(e=>e.textContent.trim()).filter(Boolean).join('、');
    const title = link.textContent.trim();
    if (!title || !author) continue;
    results.set(id,{id,title,author,url:`${SCP}/${id}`,snippet:'网络原创故事 · 非仙侠网文书库 · 按标题/作者检索公开索引'});
  }
  return [...results.values()];
}
export function parseStory(html, item) {
  const {document} = parseHTML(html);
  const licenseLink = [...document.querySelectorAll('#license-area a')].find(a=>/creativecommons\.org\/licenses\/by-sa\/3\.0/.test(a.getAttribute('href') || ''));
  if (!licenseLink) throw new Error('该页面未找到预期开放许可，已停止导入');
  const root = document.querySelector('#page-content');
  if (!root) throw new Error('未找到故事正文');
  if (root.querySelector('iframe, .collapsible-block, .yui-navset')) throw new Error('这篇作品含嵌入或交互内容，纯文字导入可能缺失，暂不支持');
  root.querySelectorAll('script,style,form,button,.page-rate-widget-box,.creditRate,.licensebox,.footer-wikiwalk-nav,.footnotes-footer,.backlinks').forEach(e=>e.remove());
  root.querySelectorAll('br').forEach(e=>e.replaceWith(document.createTextNode('\n')));
  const text = [...root.querySelectorAll('p,h1,h2,h3,h4,pre')].filter(e=>!e.parentElement?.closest('p,pre')).map(e=>e.textContent.trim()).filter(Boolean).join('\n\n');
  if (text.length < 40 || text.length > 1000000) throw new Error('正文长度异常，未导入');
  if ((text.match(/[\uE000-\uF8FF]/g)||[]).length > text.length * 0.02) throw new Error('正文依赖专用字体，不能可靠地提取为普通文字');
  return {title:document.querySelector('#page-title')?.textContent.trim() || item.title,text};
}
export function createSources(fetchPage = upstream) {
  return [createSuduguSource(fetchPage),createBqqugeSource(fetchPage),{...createTaduSource(fetchPage),searchable:false},{...createZonghengSource(fetchPage),searchable:false}];
}
// Historical adapters retained for regression tests only, not registered or requested.
function createHistoricalSources(fetchPage = upstream) {
  let indexCache = null;
  async function index(signal) {
    if (indexCache && Date.now()-indexCache.at < 30*60000) return indexCache.items;
    const html = await (await fetchPage(`${SCP}/tales-cn-by-page-name`,{signal})).text();
    const items = parseStoryIndex(html);
    if (!items.length) throw new Error('来源目录结构变化，未获取有效作品列表');
    indexCache = {at:Date.now(),items}; return items;
  }
  return [
    createTaduSource(fetchPage),
    createClassicsSource(fetchPage),
    {id:'scp-cn',name:'中文网络原创故事（验证源）',defaultEnabled:false,description:'连接不稳定，默认不选；SCP 中文原创故事，只支持静态文字单篇。',
      async search(query,signal) {const items=await index(signal);const key=query.normalize('NFKC').toLowerCase();return items.filter(i=>(i.title+' '+i.author).normalize('NFKC').toLowerCase().includes(key)).slice(0,20);},
      async prepare(id,signal) {
        const item=(await index(signal)).find(i=>i.id===id);if(!item) throw new Error('作品不在该来源公开索引中，请重新搜索');
        const html=await (await fetchPage(item.url,{signal})).text(); const chapter=parseStory(html,item);
        return {title:item.title,author:item.author,source:'SCP 中文分部',sourceUrl:item.url,sourceLicenseUrl:LICENSE,
          sourceNotice:`${item.author}｜${item.title}｜${item.url}\n文字依据 CC BY-SA 3.0 使用；本副本提取文字，未包含图片、版式和交互。再分享时请保留署名、来源、许可及修改说明。`,
          first:chapter,root:{children:[]},chapters:[{...chapter,sourceUrl:item.url}]};
      },
      async download(preview,signal,onProgress) {signal.throwIfAborted();onProgress({done:1,total:1,title:preview.title});const{first,root,...book}=preview;return book;}
    },
    {id:'wikisource',name:'中文维基文库',defaultEnabled:false,description:'连接不稳定，默认不选；可手动勾选重试。古典与公版作品。',
      async search(query,signal){return (await wiki.search(query,signal)).map(item=>({...item,id:item.title,author:'作者待预览'}));},
      prepare:(id,signal)=>wiki.prepare(id,signal),download:(preview,signal,progress)=>wiki.download(preview,signal,progress)}
  ];
}
