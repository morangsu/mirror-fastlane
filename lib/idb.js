/* 镜像快车道 - 极简 IndexedDB 键值封装（后台与校验页共用同一库） */
'use strict';

(function (root) {
  const DB_NAME = 'mfl-fs';
  const DB_VERSION = 1;
  const STORE = 'kv';
  const HANDLE_KEY = 'outboxDir';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((ok, no) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    return dbPromise;
  }

  async function get(key) {
    const db = await open();
    return new Promise((ok, no) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => ok(rq.result);
      rq.onerror = () => no(rq.error);
    });
  }

  async function put(key, value) {
    const db = await open();
    return new Promise((ok, no) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => ok(true);
      tx.onerror = () => no(tx.error);
    });
  }

  async function del(key) {
    const db = await open();
    return new Promise((ok, no) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => ok(true);
      tx.onerror = () => no(tx.error);
    });
  }

  const api = { get, put, del, HANDLE_KEY, DB_NAME, STORE };
  root.IDB = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
