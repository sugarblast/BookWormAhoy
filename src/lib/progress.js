// Reading progress, one record per book: { id, source, fileId, name, size, page, numPages, updatedAt }

import { db } from './db.js';

export async function loadAllProgress() {
  try {
    const records = await db.all('progress');
    return new Map(records.map((record) => [record.id, record]));
  } catch {
    return new Map();
  }
}

export async function getProgress(id) {
  try {
    return (await db.get('progress', id)) ?? null;
  } catch {
    return null;
  }
}

export async function saveProgress(record) {
  try {
    await db.put('progress', record);
  } catch {
    /* progress is a convenience; never interrupt reading over it */
  }
}

/** 0 at the first page, 1 at the last. */
export function fractionRead(record) {
  if (!record || !record.numPages || record.numPages < 2) return 0;
  return Math.min(1, Math.max(0, (record.page - 1) / (record.numPages - 1)));
}

/** A book counts as "started" once the reader has turned past page 1. */
export const isStarted = (record) => Boolean(record && record.page > 1);
