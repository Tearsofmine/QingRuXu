import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { upstream } from './upstream.mjs';

const SOURCE_URL='https://www.gutenberg.org/ebooks/23962';
const DOWNLOAD_URL='https://www.gutenberg.org/cache/epub/23962/pg23962.txt';
const CACHE_URL=new URL('./library-cache/23962.txt',import.meta.url);
const digits={零:0,〇:0,'○':0,O:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
export function chapterNumber(value) {
  const numeral=value.normalize('NFKC').replace(/\s/g,'');
  if (/^[零〇○O一二三四五六七八九\d]+$/.test(numeral)) return Number([...numeral].map(char=>digits[char]??char).join(''));
  let total=0,current=0;
  for(const char of numeral) {
    if(char==='十'||char==='百'){total+=(current||1)*(char==='十'?10:100);current=0;}
    else if(digits[char]!==undefined)current=digits[char];
    else return NaN;
  }
  return total+current;
}
export function parseJourney(text) {
  const start=text.match(/\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\r\n]*\*\*\*/i);
  const end=text.match(/\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\r\n]*\*\*\*/i);
  if(!start||!end||end.index<=start.index||!text.includes('西遊記'))throw new Error('《西游记》文件不完整，未加入书架');
  const body=text.slice(start.index+start[0].length,end.index);
  const headings=[...body.matchAll(/^[ \t\u3000]*第([^\r\n]{1,18}?)[回囘囬][^\r\n]*/gm)];
  if(headings.length!==100||headings.some((match,index)=>chapterNumber(match[1])!==index+1))throw new Error('《西游记》目录未能完整识别一百回，已停止导入');
  const chapters=headings.map((match,index)=>({title:match[0].trim().replace(/[ \t\u3000]+/g,' '),text:body.slice(match.index+match[0].length,headings[index+1]?.index??body.length).trim(),sourceUrl:SOURCE_URL}));
  if(chapters.some(chapter=>chapter.text.length<500))throw new Error('《西游记》有章节内容不完整，已停止导入');
  return chapters;
}
export function createClassicsSource(fetchPage=upstream) {
  let cachedChapters;
  async function chapters(signal) {
    signal.throwIfAborted();
    if(cachedChapters)return cachedChapters;
    try {cachedChapters=parseJourney(await readFile(CACHE_URL,'utf8'));return cachedChapters;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const text=await(await fetchPage(DOWNLOAD_URL,{signal})).text();
    const parsed=parseJourney(text);signal.throwIfAborted();
    await mkdir(new URL('./library-cache/',import.meta.url),{recursive:true});
    const temporary=new URL(`./library-cache/23962-${randomUUID()}.tmp`,import.meta.url);
    await writeFile(temporary,text,'utf8');await rename(temporary,CACHE_URL);
    cachedChapters=parsed;return parsed;
  }
  return {
    id:'gutenberg-classics',name:'古腾堡古籍',defaultEnabled:true,
    description:'《西游记》繁体原文，一百回；已取得全文，可保存后离线阅读。目前仅配置这部作品。',
    async search(query,signal) {
      signal.throwIfAborted();const key=query.normalize('NFKC').replace(/[《》\s]/g,'').toLowerCase();
      const keywords=['西游记','西遊記','吴承恩','吳承恩','journeytothewest'];
      return key&&keywords.some(word=>word.toLowerCase().includes(key))?[{id:'23962',title:'西游记',author:'吴承恩',url:SOURCE_URL,snippet:'繁体原文 · 一百回 · 全文已校验'}]:[];
    },
    async prepare(id,signal) {
      if(id!=='23962')throw new Error('这个来源尚未配置该作品');
      const content=await chapters(signal);
      return {title:'西游记',author:'吴承恩',source:'古腾堡古籍',sourceUrl:SOURCE_URL,sourceLicenseUrl:'https://www.gutenberg.org/policy/license.html',sourceNotice:'吴承恩《西遊記》｜Project Gutenberg eBook #23962\n电子文本整理：Leong Joana Kit Ieng（据来源页）。正文为繁体，按一百回分章，未做简繁转换。原始下载文件及其完整许可保存在本地书源缓存中。',first:content[0],root:{children:content.map(chapter=>chapter.title)},chapters:content};
    },
    async download(preview,signal,onProgress) {
      signal.throwIfAborted();
      onProgress({done:preview.chapters.length,total:preview.chapters.length,title:'全文一百回已就绪'});
      const {first,root,...book}=preview;return book;
    }
  };
}
