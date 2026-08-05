const DB_NAME = 'FinanceDB';
const DB_VERSION = 2;
const STORES = ['expenses', 'income', 'uber', 'fuel', 'investments', 'maintenance', 'budgets', 'goals', 'settings', 'metadata', 'backups', 'categories', 'wallets', 'dues', 'favorites'];
export const stores = STORES;

export function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      STORES.forEach(name => {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database upgrade blocked. Close other tabs and reload.'));
  });
}

export async function add(store, data) {
  const db = await openDB();
  const now = new Date().toISOString();
  const record = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, deleted: false, ...data };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).add(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export async function all(store, includeDeleted = false) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store);
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(includeDeleted ? req.result : req.result.filter(item => !item.deleted));
    req.onerror = () => reject(req.error);
  });
}

export async function update(store, id, changes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objectStore = tx.objectStore(store);
    const get = objectStore.get(id);
    get.onsuccess = () => {
      const existing = get.result;
      if (!existing) { reject(new Error('Record not found')); return; }
      objectStore.put({ ...existing, ...changes, id, updatedAt: new Date().toISOString() });
    };
    get.onerror = () => reject(get.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function upsert(store, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export const softDelete = (store, id) => update(store, id, { deleted: true });

export async function exportData() {
  const result = { version: 2, exportedAt: new Date().toISOString(), data: {} };
  for (const store of STORES) result.data[store] = await all(store, true);
  return result;
}
