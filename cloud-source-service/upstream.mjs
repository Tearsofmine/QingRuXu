const HOSTS = new Set(['scp-wiki-cn.wikidot.com', 'zh.wikisource.org', 'www.gutenberg.org', 'www.tadu.com', 'www.zongheng.com', 'search.zongheng.com', 'bookapi.zongheng.com', 'read.zongheng.com', 'www.suduguu.com', 'www.bqquge.org']);
export function checkedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password) throw new Error('此地址不在已配置书源中');
  return url;
}
// Only server-owned adapters can request fixed allowlisted hosts. Never an arbitrary proxy.
export async function upstream(value, options = {}) {
  const deadline = AbortSignal.timeout(18000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let url = checkedURL(value);
  let method=options.method || 'GET';
  let body=options.body;
  const allowedPost=(url.hostname==='www.tadu.com'&&url.pathname==='/search')||(url.hostname==='bookapi.zongheng.com'&&url.pathname==='/api/chapter/getChapterList'&&/^bookId=\d{1,10}$/.test(body||''));
  if(method!=='GET' && !(method==='POST'&&allowedPost&&typeof body==='string'&&body.length<=2048))throw new Error('书源请求方式不受支持');
  for (let redirects = 0; redirects < 3; redirects += 1) {
    const headers={'User-Agent':'QingRuXu-PersonalReader/0.1 (local text reader)'};
    if(method==='POST')headers['Content-Type']='application/x-www-form-urlencoded; charset=UTF-8';
    const response = await fetch(url, {signal, method, body, redirect:'manual', headers});
    if ([301,302,303,307,308].includes(response.status)) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Error('书源重定向无效');
      url = checkedURL(new URL(next, url));
      if(response.status===303||((response.status===301||response.status===302)&&method==='POST')){method='GET';body=undefined;}
      continue;
    }
    if (!response.ok) {await response.body?.cancel();throw new Error(`书源响应 ${response.status}，没有获取正文`);}
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const {done,value:chunk} = await reader.read(); if (done) break;
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) throw new Error('书源页面过大，已停止读取');
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {await reader.cancel().catch(()=>{});throw error;}
    return new Response(Buffer.concat(chunks), {status:200,headers:{'Content-Type':response.headers.get('content-type') || 'text/plain'}});
  }
  throw new Error('书源重定向过多');
}
