// One logical media library; the physical destination is selected automatically.
import { DIRECT_PART_BYTES, LOCAL_MEDIA_BYTES } from './r2-media.mjs';

const stateKey = row => 'media-upload:' + row.id;
const uploadError = (message,status = 409) => Object.assign(new Error(message),{status});
export function createHybridMedia({local,remote,state,now = Date.now} = {}) {
  if (!local || !state) throw new TypeError('Media storage and persistent upload state are required');
  const read = async row => {
    const saved = await state.get(stateKey(row),'json');
    if (!saved || saved.key !== row.key || saved.size !== row.size || saved.email !== row.email || !saved.uploadId) throw uploadError('ההעלאה לא נמצאה. התחילו מחדש.',404);
    if (now() - saved.created > 24 * 3600_000) throw uploadError('תוקף ההעלאה פג. התחילו מחדש.',410);
    return saved;
  };
  const api = {
    hybrid:true,localMaxBytes:LOCAL_MEDIA_BYTES,remoteAvailable:!!remote,
    put:(...args) => local.put(...args),
    async head(key) { return await local.head(key) || (remote ? remote.head(key) : null); },
    async get(key,options) { return await local.head(key) ? local.get(key,options) : remote ? remote.get(key,options) : null; },
    async delete(key) { if (await local.head(key)) return local.delete(key); if (remote) await remote.delete(key); },
    publicResponse(key,head,request) {
      if (!head.remote || !remote || request.method === 'HEAD') return null;
      // The stable URL stays on our domain; object bytes bypass the hosting server.
      return new Response(null,{status:307,headers:{Location:remote.downloadUrl(key),'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
    },
    async beginDirect(row) {
      if (!remote || row.size <= LOCAL_MEDIA_BYTES) throw uploadError('לא ניתן להתחיל את ההעלאה הזאת.',400);
      const uploadId = await remote.begin(row.key,row.mime);
      try { await state.put(stateKey(row),JSON.stringify({key:row.key,size:row.size,email:row.email,uploadId,created:now(),completing:false})); }
      catch (error) { await remote.abort(row.key,uploadId); throw error; }
      return { direct:true,partBytes:DIRECT_PART_BYTES };
    },
    async partUrls(row,from,count = 16) {
      const saved = await read(row), total = Math.ceil(row.size / DIRECT_PART_BYTES);
      if (!Number.isSafeInteger(from) || from < 1 || from > total || !Number.isSafeInteger(count) || count < 1 || count > 16) throw uploadError('חלק לא תקין.',400);
      return {parts:Array.from({length:Math.min(count,total - from + 1)},(_,i) => {
        const number = from + i;
        return remote.partUrl(row.key,saved.uploadId,number,Math.min(DIRECT_PART_BYTES,row.size - (number - 1) * DIRECT_PART_BYTES));
      })};
    },
    async finishDirect(row) {
      const saved = await read(row);
      // Persist this before the provider call so a lost response can be retried safely.
      const existing = saved.completing && await remote.head(row.key);
      if (!existing || existing.size !== row.size) {
        saved.completing = true; await state.put(stateKey(row),JSON.stringify(saved));
        await remote.complete(row.key,saved.uploadId,row.size);
      }
    },
    async forgetDirect(row) { await state.delete(stateKey(row)); },
    async abortDirect(row) {
      const saved = await state.get(stateKey(row),'json');
      if (!saved) return;
      if (saved.key !== row.key || saved.email !== row.email || saved.size !== row.size) throw uploadError('Invalid upload state');
      await remote.abort(row.key,saved.uploadId);
      if (saved.completing) await remote.delete(row.key);
      await state.delete(stateKey(row));
    },
    async cleanupDirect(store) {
      if (!remote || !store.listReceivingMedia) return;
      for (const row of await store.listReceivingMedia(now() - 24 * 3600_000)) {
        if (row.size <= LOCAL_MEDIA_BYTES) continue;
        // Rows remain reserved if provider cleanup fails; capacity is never released early.
        try { await api.abortDirect(row); if (row.status === 'finalizing') await store.resetR2Direct(row.id); else await store.resetR2Upload(row.id); await store.dropUploading(row.id); }
        catch { /* A later cleanup retries without releasing the reservation. */ }
      }
    },
  };
  return api;
}
