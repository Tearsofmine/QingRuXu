import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from './server.mjs';

const routes = new Set(['/qrx-api/sources', '/qrx-api/search', '/qrx-api/preview', '/qrx-api/download', '/qrx-api/chapter']);
const allowedHeaders = new Set(['authorization', 'x-qrx-client']);
const digest = value => createHash('sha256').update(value).digest();
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

// The existing local server remains loopback-only. This gate exposes only its
// fixed read API, with independent authentication and a single allowed origin.
export async function createCloudServer({ token, allowedOrigin, sources } = {}) {
  if (!/^[A-Za-z0-9+/_=-]{32,256}$/.test(token || '') || new Set(token).size < 8) throw new Error('QRX_API_TOKEN 必须是至少 32 位的随机密钥，建议使用平台生成值');
  let origin;
  try { origin = new URL(allowedOrigin); } catch { throw new Error('QRX_ALLOWED_ORIGIN 必须为清如许网页的 HTTPS 来源'); }
  if (origin.protocol !== 'https:' || origin.origin !== allowedOrigin || origin.username || origin.password) throw new Error('QRX_ALLOWED_ORIGIN 只能包含 HTTPS 协议与域名，不能包含路径');
  const expected = digest(token);
  const core = createServer(sources ? { sources } : {});
  core.listen(0, '127.0.0.1');
  await once(core, 'listening');
  const port = core.address().port;
  const server = http.createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if ((req.url || '').length > 4096) return json(res, 414, { error: '请求地址过长' });
    let url;
    try { url = new URL(req.url, 'http://gateway.invalid'); } catch { return json(res, 400, { error: '请求地址无效' }); }
    // No secrets, source metadata, user content, or external requests in health.
    if ((url.pathname === '/' || url.pathname === '/health') && req.method === 'GET') return json(res, 200, { ok: true, service: 'qingruxu-source', version: '36.7' });
    if (!routes.has(url.pathname)) return json(res, 404, { error: '没有这个接口' });
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== allowedOrigin) return json(res, 403, { error: '不接受此网页来源' });
    if (requestOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!requestOrigin || req.headers['access-control-request-method'] !== 'GET' || requested.some(h => !allowedHeaders.has(h))) return json(res, 403, { error: '不接受此跨域请求' });
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization, X-Qrx-Client', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (req.method !== 'GET') return json(res, 405, { error: '只支持只读请求' });
    const authorization = String(req.headers.authorization || '');
    const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (presented.length > 256 || !timingSafeEqual(digest(presented), expected)) return json(res, 401, { error: '私人访问密钥不正确或尚未配置' });
    if (req.headers['x-qrx-client'] !== '1') return json(res, 403, { error: '缺少阅读器请求标记' });
    // Rebuild headers. Never forward the private token, Origin, cookies, or Host.
    const upstream = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: url.pathname + url.search, headers: { Host: `127.0.0.1:${port}`, 'X-Qrx-Client': '1' } }, inner => {
      res.writeHead(inner.statusCode, { 'Content-Type': inner.headers['content-type'] || 'application/json; charset=utf-8' });
      inner.on('error', () => res.destroy());
      inner.pipe(res);
    });
    upstream.setTimeout(125000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.destroyed && !res.headersSent) json(res, 502, { error: '书源服务连接中断，请稍后重试' }); else res.destroy(); });
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end();
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 15000;
  server.on('close', () => { core.closeAllConnections(); core.close(); });
  // Allows a caller to dispose an unbound gateway after setup failures.
  server.closeCore = () => { core.closeAllConnections(); core.close(); };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须在 1024–65535 之间');
  const server = await createCloudServer({ token: process.env.QRX_API_TOKEN, allowedOrigin: process.env.QRX_ALLOWED_ORIGIN });
  server.on('error', () => { server.closeCore(); console.error('云端监听失败'); process.exitCode = 1; });
  server.listen(port, '0.0.0.0', () => console.log(`清如许云端后台就绪，端口 ${port}；API 已启用私人密钥验证`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
}
