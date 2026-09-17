#!/usr/bin/env node
/**
 * migrate-storage-urls.mjs   —   run:  node migrate-storage-urls.mjs   (dry run)
 *                                       node migrate-storage-urls.mjs --write
 *
 * Rewrites attachment URLs still pointing at the retired
 * dbx-dispatch.firebasestorage.app bucket to dbx-prod.firebasestorage.app,
 * using each attachment's stored `path` to mint a FRESH valid download URL from
 * dbx-prod (the old token is not valid for the copied file).
 *
 * Scans EVERY document in EVERY collection and walks EVERY field.
 * SAFETY: dry-run by default; only touches URLs containing the OLD bucket;
 * requires a `path`; verifies the file exists in dbx-prod before rewriting.
 *
 * SETUP:
 *   npm install firebase-admin
 *   Firebase console -> dbx-prod -> Project settings -> Service accounts ->
 *     Generate new private key -> save as ./serviceAccountKey.json
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const serviceAccount = JSON.parse(
  readFileSync(new URL("./serviceAccountKey.json", import.meta.url))
);

const OLD_BUCKET = "dbx-dispatch.firebasestorage.app";
const NEW_BUCKET = "dbx-prod.firebasestorage.app";
const WRITE = process.argv.includes("--write");

initializeApp({ credential: cert(serviceAccount), storageBucket: NEW_BUCKET });

const db = getFirestore();
const bucket = getStorage().bucket(NEW_BUCKET);

async function freshUrl(path) {
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) return { ok: false, reason: "missing-in-dbx-prod" };
  const [meta] = await file.getMetadata();
  let token =
    meta.metadata && meta.metadata.firebaseStorageDownloadTokens
      ? String(meta.metadata.firebaseStorageDownloadTokens).split(",")[0]
      : null;
  if (!token) {
    token = randomUUID();
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  }
  return {
    ok: true,
    url:
      `https://firebasestorage.googleapis.com/v0/b/${NEW_BUCKET}/o/` +
      encodeURIComponent(path) +
      `?alt=media&token=${token}`,
  };
}

const isAttachmentObj = (v) => v && typeof v === "object" && typeof v.url === "string";

async function walk(value, report, ctx) {
  let changed = false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      changed = (await walk(value[i], report, `${ctx}[${i}]`)) || changed;
    }
    return changed;
  }
  if (value && typeof value === "object") {
    if (isAttachmentObj(value) && value.url.includes(OLD_BUCKET)) {
      report.found++;
      if (!value.path) {
        report.skippedNoPath.push(`${ctx} (name: ${value.name || "?"})`);
        return changed;
      }
      const res = await freshUrl(value.path);
      if (!res.ok) {
        report.skippedMissing.push(`${ctx} -> ${value.path} (${res.reason})`);
        return changed;
      }
      report.willRewrite.push(`${ctx}: ${value.path}`);
      value.url = res.url;
      return true;
    }
    for (const k of Object.keys(value)) {
      changed = (await walk(value[k], report, `${ctx}.${k}`)) || changed;
    }
  }
  return changed;
}

async function main() {
  console.log(`\n${WRITE ? "WRITE MODE - changes WILL be saved" : "DRY RUN - no changes written"}`);
  console.log(`Old: ${OLD_BUCKET}\nNew: ${NEW_BUCKET}\n`);

  const report = { found: 0, willRewrite: [], skippedNoPath: [], skippedMissing: [], docsChanged: 0 };

  const collections = await db.listCollections();
  for (const col of collections) {
    const snap = await col.get();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (await walk(data, report, `${col.id}/${doc.id}`)) {
        report.docsChanged++;
        if (WRITE) await doc.ref.set(data, { merge: true });
      }
    }
  }

  console.log("---------------- SUMMARY ----------------");
  console.log(`Stale attachments found (dbx-dispatch URL): ${report.found}`);
  console.log(`Will rewrite (path + file present in dbx-prod): ${report.willRewrite.length}`);
  console.log(`Documents ${WRITE ? "updated" : "that would update"}: ${report.docsChanged}`);
  if (report.willRewrite.length) {
    console.log("\n  Rewrites:");
    report.willRewrite.forEach((s) => console.log("   [rewrite] " + s));
  }
  if (report.skippedMissing.length) {
    console.log(`\n  WARNING - Skipped, file NOT in dbx-prod (copy incomplete?):`);
    report.skippedMissing.forEach((s) => console.log("   [skip] " + s));
  }
  if (report.skippedNoPath.length) {
    console.log(`\n  WARNING - Skipped, stale URL but no 'path' (manual):`);
    report.skippedNoPath.forEach((s) => console.log("   [skip] " + s));
  }
  console.log("\n" + (WRITE ? "Done - written." : "Dry run complete - re-run with --write to apply."));
  process.exit(0);
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
