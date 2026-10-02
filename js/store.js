// Everything is saved in this phone's browser storage (IndexedDB): the mixes, the files they use, and settings.
// Nothing is uploaded anywhere.
const DB_NAME = 'dance-mix';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('blobs');   // the original audio/video files, keyed by source id
        d.createObjectStore('kv');      // settings and small flags
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

function run(storeName, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error || new Error('storage failed'));
  }));
}

export const store = {
  getProject: id => run('projects', 'readonly', s => s.get(id)),
  putProject: p => run('projects', 'readwrite', s => s.put(p)),
  deleteProject: id => run('projects', 'readwrite', s => s.delete(id)),
  listProjects: () => run('projects', 'readonly', s => s.getAll()),
  getBlob: id => run('blobs', 'readonly', s => s.get(id))
    .then(v => (v && v.data instanceof ArrayBuffer ? new Blob([v.data], { type: v.type || '' }) : v)),
  async putBlob(id, blob) {
    try {
      await run('blobs', 'readwrite', s => s.put(blob, id));
    } catch {
      // Some Safari modes (private browsing, for one) refuse to store files; the raw bytes are always accepted.
      const data = await blob.arrayBuffer();
      await run('blobs', 'readwrite', s => s.put({ type: blob.type, data }, id));
    }
  },
  deleteBlob: id => run('blobs', 'readwrite', s => s.delete(id)),
  get: key => run('kv', 'readonly', s => s.get(key)),
  set: (key, value) => run('kv', 'readwrite', s => s.put(value, key)),
};
