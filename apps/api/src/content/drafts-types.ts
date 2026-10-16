/**
 * Limits, the draft shape clients see, and the record fingerprint.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@sethucms/core';
import type { StoredDraft } from '../store/state.js';


// Limits that keep the gateway's own store from growing without bound.
export const MAX_ACTIVE_DRAFTS = 5000;
export const MAX_VALUES_BYTES = 256 * 1024;
export const KEEP_FINISHED_DAYS = 30;
export const PREVIEW_TTL_SECONDS = 15 * 60;

/** A draft as sent to a client: values decrypted and masked per caller. */
export interface DraftView {
  id: string;
  connectionId: string;
  collection: string;
  recordId: string | null;
  values: Record<string, unknown>;
  version: number;
  status: StoredDraft['status'];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  publishedRecordId?: string;
}

// Hash of a record's canonical JSON; used to detect changes made behind
// a draft's back. Canonical form makes key order irrelevant.
export const fingerprint = (record: Record<string, unknown>): string =>
  createHash('sha256').update(canonicalJson(record)).digest('hex');
