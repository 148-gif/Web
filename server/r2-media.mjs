// Private R2 S3 client. Only fixed account endpoints and app-owned media keys are accepted.
import { createHash, createHmac } from 'node:crypto';

const keyPattern = /^[a-z0-9][\w.-]{0,100}$/;
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hash = value => createHash('sha256').update(value).digest('hex');
const mac = (key, value) => createHmac('sha256', key).update(value).digest();
const xmlValue = (xml, name) => new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(xml)?.[1]?.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const xmlEscape = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const issue = message => Object.assign(new Error(message), { status: 502 });
export const DIRECT_PART_BYTES = 8 * 1024 ** 2;
export const LOCAL_MEDIA_BYTES = 90 * 1024 ** 2;

export function createR2Media({ accountId, accessKeyId, secretAccessKey, bucket = 'heichal-media', fetch: request = globalThis.fetch, now = Date.now } = {}) {
  if (!/^[a-f0-9]{32}$/.test(accountId || '') || !/^[A-Za-z0-9]{16,128}$/.test(accessKeyId || '') || !/^[A-Za-z0-9/+]{32,128}=?$/.test(secretAccessKey || '') || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new TypeError('Invalid private R2 configuration');
  const host = accountId + '.r2.cloudflarestorage.com';
  const pathOf = key => {
    if (!keyPattern.test(key || '')) throw new TypeError('Invalid media key');
    return '/' + bucket + '/cms/' + key;
  };
  function signing(method, key, query = {}, headers = {}, payload = '', expiry) {
    const stamp = new Date(now()).toISOString().replace(/[:-]|\.\d{3}/g,''), date = stamp.slice(0,8), scope = date + '/auto/s3/aws4_request';
    const path = pathOf(key), h = { host, ...headers };
    const q = Object.entries(query);
    const digest = expiry ? 'UNSIGNED-PAYLOAD' : hash(payload);
    if (expiry) q.push(['X-Amz-Algorithm','AWS4-HMAC-SHA256'],['X-Amz-Credential',accessKeyId + '/' + scope],['X-Amz-Date',stamp],['X-Amz-Expires',String(expiry)]);
    else { h['x-amz-date'] = stamp; h['x-amz-content-sha256'] = digest; }
    const names = Object.keys(h).sort(), signed = names.join(';');
    if (expiry) q.push(['X-Amz-SignedHeaders',signed]);
    const queryString = q.map(([k,v]) => [encode(k),encode(String(v))]).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).map(pair => pair.join('=')).join('&');
    const canonical = [method,path,queryString,names.map(name => name + ':' + String(h[name]).trim().replace(/\s+/g,' ') + '\n').join(''),signed,digest].join('\n');
    const signingKey = mac(mac(mac(mac('AWS4' + secretAccessKey,date),'auto'),'s3'),'aws4_request');
    const signature = mac(signingKey,['AWS4-HMAC-SHA256',stamp,scope,hash(canonical)].join('\n')).toString('hex');
    if (!expiry) h.authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature;
    delete h.host;
    return { url: 'https://' + host + path + (queryString ? '?' + queryString : '') + (expiry ? '&X-Amz-Signature=' + signature : ''), headers: h };
  }
  async function call(method, key, query = {}, body, headers = {}) {
    const signed = signing(method,key,query,headers,body || '');
    const response = await request(signed.url,{ method,headers:signed.headers,body,redirect:'error',signal:AbortSignal.timeout(60000) });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw issue('אחסון הקבצים אינו זמין כרגע. נסו שוב.'); }
    return response;
  }
  async function readXml(response) {
    if (!response) throw issue('ההעלאה לא נמצאה באחסון.');
    const text = await response.text();
    if (text.length > 512 * 1024 || /<Error[>\s]/.test(text)) throw issue('לא ניתן להשלים את העלאת הקובץ.');
    return text;
  }
  return {
    host,
    async head(key) {
      const r = await call('HEAD',key);
      if (!r) return null;
      const size = Number(r.headers.get('content-length'));
      if (!Number.isSafeInteger(size) || size < 0) throw issue('Invalid object length');
      return { key,size,remote:true,httpMetadata:{contentType:r.headers.get('content-type') || 'application/octet-stream',cacheControl:r.headers.get('cache-control') || 'public, max-age=31536000, immutable'} };
    },
    async get(key,{range} = {}) {
      const r = await call('GET',key,{},undefined,range ? {range:'bytes=' + range.offset + '-' + (range.offset + range.length - 1)} : {});
      return r && { body:r.body,arrayBuffer:() => r.arrayBuffer() };
    },
    async delete(key) { const r = await call('DELETE',key); await r?.body?.cancel(); },
    downloadUrl(key) { return signing('GET',key,{}, {},'',300).url; },
    async begin(key,mime) {
      const xml = await readXml(await call('POST',key,{uploads:''},undefined,{'content-type':mime,'cache-control':'public, max-age=31536000, immutable'}));
      const id = xmlValue(xml,'UploadId');
      if (!id || id.length > 2048) throw issue('Invalid multipart upload');
      return id;
    },
    partUrl(key,uploadId,number,size) {
      const signed = signing('PUT',key,{partNumber:String(number),uploadId},{'content-length':String(size),'content-type':'application/octet-stream'},'',600);
      return { number,url:signed.url,headers:{'Content-Type':'application/octet-stream'} };
    },
    async complete(key,uploadId,size) {
      const xml = await readXml(await call('GET',key,{uploadId}));
      if (xmlValue(xml,'IsTruncated') === 'true') throw issue('ההעלאה מכילה יותר מדי חלקים.');
      const parts = [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map(m => ({number:Number(xmlValue(m[1],'PartNumber')),size:Number(xmlValue(m[1],'Size')),etag:xmlValue(m[1],'ETag')}));
      const count = Math.ceil(size / DIRECT_PART_BYTES);
      if (parts.length !== count || parts.some((p,i) => p.number !== i + 1 || p.size !== Math.min(DIRECT_PART_BYTES,size - i * DIRECT_PART_BYTES) || !/^"?[a-f0-9]{32}"?$/.test(p.etag || ''))) throw Object.assign(new Error('ההעלאה אינה שלמה. נסו שוב.'),{status:400});
      const body = '<CompleteMultipartUpload>' + parts.map(p => '<Part><PartNumber>' + p.number + '</PartNumber><ETag>' + xmlEscape(p.etag) + '</ETag></Part>').join('') + '</CompleteMultipartUpload>';
      await readXml(await call('POST',key,{uploadId},body,{'content-type':'application/xml'}));
    },
    async abort(key,uploadId) { const r = await call('DELETE',key,{uploadId}); await r?.body?.cancel(); },
  };
}
