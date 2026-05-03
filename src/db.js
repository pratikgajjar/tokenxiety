"use strict";

const DB_NAME = "tokenxiety";
const DB_VERSION = 3;

const QUOTA_LATEST_STORE = "quota_latest";  // keyPath: providerId
const SNAPSHOT_STORE = "snapshot";           // keyPath: [providerId, ts] — raw API payload
const BUCKET_SAMPLE_STORE = "bucket_sample"; // keyPath: [providerId, bucketKey, ts]
const BUCKET_INDEX = "byProviderBucket";

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HISTORY_RECENT_TRIM_KEEP = 2000;
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SNAPSHOT_KEEP_PER_PROVIDER = 200;

const channel = typeof BroadcastChannel === "function"
  ? new BroadcastChannel(`${DB_NAME}:changes`)
  : null;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 3) {
        // Drop legacy stores; v3 uses unix-ms numbers (not ISO strings) for ts.
        for (const legacy of ["quota", "history", QUOTA_LATEST_STORE, SNAPSHOT_STORE, BUCKET_SAMPLE_STORE]) {
          if (db.objectStoreNames.contains(legacy)) db.deleteObjectStore(legacy);
        }
      }

      db.createObjectStore(QUOTA_LATEST_STORE, { keyPath: "providerId" });
      db.createObjectStore(SNAPSHOT_STORE, { keyPath: ["providerId", "ts"] });
      const bucketStore = db.createObjectStore(BUCKET_SAMPLE_STORE, { keyPath: ["providerId", "bucketKey", "ts"] });
      bucketStore.createIndex(BUCKET_INDEX, ["providerId", "bucketKey"]);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(new Error(request.error?.message ?? "indexedDB.open failed"));
    };
    request.onblocked = () => {
      console.warn("[tokenxiety] indexedDB open blocked by another connection");
    };
    request.onsuccess = () => {
      const db = request.result;
      // Invalidate the cached promise whenever this connection becomes
      // unusable, so the next withTx reopens cleanly instead of hitting
      // "connection is closing".
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        dbPromise = null;
      };
      db.onclose = () => { dbPromise = null; };
      db.onerror = (event) => {
        console.warn("[tokenxiety] indexedDB error", event.target?.error);
      };
      resolve(db);
    };
  });

  return dbPromise;
}

async function withTx(stores, mode, work) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = db.transaction(stores, mode);
        } catch (error) {
          reject(error);
          return;
        }
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        Promise.resolve(work(transaction)).then((value) => { result = value; }).catch(reject);
      });
    } catch (error) {
      const message = String(error?.message ?? error ?? "");
      const recoverable = /closing|InvalidStateError/i.test(message) || error?.name === "InvalidStateError";
      if (attempt === 0 && recoverable) {
        console.debug("[tokenxiety] indexedDB connection stale, reopening");
        dbPromise = null;
        continue;
      }
      throw error;
    }
  }
  throw new Error("withTx failed after retry");
}

function awaitRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------- quota_latest ---------------- */

export async function dbLoadAllQuotas() {
  return withTx(QUOTA_LATEST_STORE, "readonly", async (transaction) => {
    const records = await awaitRequest(transaction.objectStore(QUOTA_LATEST_STORE).getAll());
    const result = {};
    for (const record of records) result[record.providerId] = record;
    return result;
  });
}

export async function dbLoadQuota(providerId) {
  return withTx(QUOTA_LATEST_STORE, "readonly", (transaction) =>
    awaitRequest(transaction.objectStore(QUOTA_LATEST_STORE).get(providerId))
  );
}

/**
 * Save derived quota + raw API response. ts is unix-ms (number).
 * Diffs against the existing latest record using a SHA-256 of the raw payload
 * (or, if not provided, of the derived fields). If the hash matches, only
 * bumps _lastObservedAtMs and skips the snapshot insert. If the hash differs,
 * inserts snapshot + updates latest + appends bucket samples for any bucket
 * whose utilization changed.
 */
export async function dbSaveQuotaIfChanged(providerId, derived, rawPayload, ts) {
  const observedMs = ensureMs(ts ?? derived.observedAt);
  const existing = await dbLoadQuota(providerId);
  const hash = await hashContent(rawPayload ?? derived);

  if (existing?._hash === hash) {
    const merged = { ...existing, _lastObservedAtMs: observedMs };
    await withTx(QUOTA_LATEST_STORE, "readwrite", (transaction) =>
      awaitRequest(transaction.objectStore(QUOTA_LATEST_STORE).put(merged))
    );
    notify({ type: "quota-touched", providerId });
    return { changed: false, quota: merged };
  }

  const record = {
    ...derived,
    _hash: hash,
    _firstObservedAtMs: existing?._firstObservedAtMs ?? observedMs,
    _lastObservedAtMs: observedMs
  };

  await withTx([QUOTA_LATEST_STORE, SNAPSHOT_STORE], "readwrite", async (transaction) => {
    await awaitRequest(transaction.objectStore(QUOTA_LATEST_STORE).put(record));
    if (rawPayload !== undefined && rawPayload !== null) {
      await awaitRequest(transaction.objectStore(SNAPSHOT_STORE).put({
        providerId,
        ts: observedMs,
        hash,
        payload: rawPayload
      }));
    }
  });

  notify({ type: "quota-changed", providerId });
  return { changed: true, quota: record };
}

/* ---------------- bucket_sample ---------------- */

export async function dbAppendBucketSampleIfChanged(providerId, bucketKey, sample) {
  const tsMs = ensureMs(sample.t);
  const last = await dbLoadLastBucketSample(providerId, bucketKey);
  if (last && last.u === sample.u) return { appended: false };

  await withTx(BUCKET_SAMPLE_STORE, "readwrite", (transaction) =>
    awaitRequest(transaction.objectStore(BUCKET_SAMPLE_STORE).put({
      providerId,
      bucketKey,
      ts: tsMs,
      u: sample.u
    }))
  );

  notify({ type: "bucket-sample-appended", providerId, bucketKey });
  return { appended: true };
}

async function dbLoadLastBucketSample(providerId, bucketKey) {
  return withTx(BUCKET_SAMPLE_STORE, "readonly", (transaction) => new Promise((resolve, reject) => {
    const store = transaction.objectStore(BUCKET_SAMPLE_STORE);
    const cursor = store.index(BUCKET_INDEX).openCursor(IDBKeyRange.only([providerId, bucketKey]), "prev");
    cursor.onsuccess = () => resolve(cursor.result?.value ?? null);
    cursor.onerror = () => reject(cursor.error);
  }));
}

export async function dbLoadBucketSamples(providerId, { sinceMs = Date.now() - HISTORY_RETENTION_MS } = {}) {
  return withTx(BUCKET_SAMPLE_STORE, "readonly", async (transaction) => {
    const store = transaction.objectStore(BUCKET_SAMPLE_STORE);
    // String + number compound key range. "" < any string, "\uffff" > any
    // string, and unix-ms numbers are always finite, so this captures every
    // sample for `providerId`.
    const records = await awaitRequest(store.getAll(IDBKeyRange.bound(
      [providerId, "", -Infinity],
      [providerId, "\uffff", Infinity]
    )));
    const grouped = {};
    for (const record of records) {
      const tMs = Number(record.ts);
      if (!Number.isFinite(tMs) || tMs < sinceMs) continue;
      (grouped[record.bucketKey] ??= []).push({ tMs, u: record.u });
    }
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => a.tMs - b.tMs);
      if (grouped[key].length > HISTORY_RECENT_TRIM_KEEP) {
        grouped[key] = grouped[key].slice(-HISTORY_RECENT_TRIM_KEEP);
      }
    }
    return grouped;
  });
}

/* ---------------- snapshot (raw payloads) ---------------- */

export async function dbLoadSnapshots(providerId, { limit = SNAPSHOT_KEEP_PER_PROVIDER, sinceMs = Date.now() - SNAPSHOT_RETENTION_MS } = {}) {
  return withTx(SNAPSHOT_STORE, "readonly", async (transaction) => {
    const store = transaction.objectStore(SNAPSHOT_STORE);
    const records = await awaitRequest(store.getAll(IDBKeyRange.bound(
      [providerId, sinceMs],
      [providerId, Infinity]
    )));
    return records.sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, limit);
  });
}

export async function dbDeleteOldSnapshots() {
  const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
  await withTx(SNAPSHOT_STORE, "readwrite", async (transaction) => {
    const store = transaction.objectStore(SNAPSHOT_STORE);
    const records = await awaitRequest(store.getAll());
    for (const record of records) {
      if (Number(record.ts) < cutoff) {
        await awaitRequest(store.delete([record.providerId, record.ts]));
      }
    }
  });
}

/* ---------------- maintenance ---------------- */

export async function dbClearAll() {
  await withTx([QUOTA_LATEST_STORE, SNAPSHOT_STORE, BUCKET_SAMPLE_STORE], "readwrite", async (transaction) => {
    await awaitRequest(transaction.objectStore(QUOTA_LATEST_STORE).clear());
    await awaitRequest(transaction.objectStore(SNAPSHOT_STORE).clear());
    await awaitRequest(transaction.objectStore(BUCKET_SAMPLE_STORE).clear());
  });
  notify({ type: "cleared" });
}

/* ---------------- change events ---------------- */

export function dbOnChange(handler) {
  if (!channel) return () => {};
  const listener = (event) => {
    try { handler(event.data); } catch { /* ignore */ }
  };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}

function notify(message) {
  if (!channel) return;
  try { channel.postMessage(message); } catch { /* ignore */ }
}

function ensureMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

async function hashContent(value) {
  const json = JSON.stringify(value, Object.keys(value ?? {}).sort());
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
