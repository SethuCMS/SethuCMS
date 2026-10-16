/**
 * The part of the Firestore API the gateway uses, its settings, and opening the real driver.
 */


// ---------------------------------------------------------------------------
// The part of the Firestore API this file uses. The real driver matches it.

export interface FsSnapshot {
  readonly id: string;
  readonly exists: boolean;
  data(): any;
}
export interface FsQuerySnapshot {
  readonly docs: FsSnapshot[];
}
export interface FsDocRef {
  readonly id: string;
  get(): Promise<FsSnapshot>;
  set(data: any): Promise<unknown>;
  delete(): Promise<unknown>;
}
export interface FsQuery {
  orderBy(field: string, direction?: 'asc' | 'desc'): FsQuery;
  limit(count: number): FsQuery;
  startAfter(snapshot: FsSnapshot): FsQuery;
  get(): Promise<FsQuerySnapshot>;
}
export interface FsCollection extends FsQuery {
  doc(id: string): FsDocRef;
}
export interface FsBatch {
  set(ref: FsDocRef, data: any): FsBatch;
  delete(ref: FsDocRef): FsBatch;
  commit(): Promise<unknown>;
}
export interface FsTransaction {
  get(ref: FsDocRef): Promise<FsSnapshot>;
  set(ref: FsDocRef, data: any): FsTransaction;
  delete(ref: FsDocRef): FsTransaction;
}
export interface FirestoreLike {
  collection(name: string): FsCollection;
  batch(): FsBatch;
  runTransaction<T>(work: (tx: FsTransaction) => Promise<T>): Promise<T>;
  terminate?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Settings and the real driver

export interface FirestoreSettings {
  /** Google Cloud / Firebase project id. */
  projectId: string;
  /** Prefix for the collection names. Default "sethucms". */
  prefix?: string;
  /**
   * A service-account key as JSON text, for hosts with no Google identity of
   * their own (Fly.io, a VPS). Omit on Google Cloud, where the platform
   * identity or GOOGLE_APPLICATION_CREDENTIALS is used.
   */
  credentialsJson?: string;
  /** host:port of the local Firestore emulator (development only). */
  emulatorHost?: string;
}

/** The collection-name prefix, validated. */
export function firestorePrefix(settings: { prefix?: string }): string {
  const prefix = settings.prefix ?? 'sethucms';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(prefix)) {
    throw new Error(
      'SETHUCMS_FIRESTORE_PREFIX must start with a letter and use only letters, digits, "_" and "-" (up to 41 characters)',
    );
  }
  return prefix;
}

/**
 * Connect to Firestore. The driver (`@google-cloud/firestore`) is loaded here,
 * so it is needed only when Firestore state is used.
 *
 * @throws Error if the credentials are not a service-account key, or the
 * driver is missing. Messages never repeat the credentials.
 */
export async function openFirestore(
  settings: FirestoreSettings,
): Promise<FirestoreLike> {
  let credentials: { client_email: string; private_key: string } | undefined;
  if (settings.credentialsJson) {
    try {
      const parsed = JSON.parse(settings.credentialsJson);
      if (
        typeof parsed?.client_email !== 'string' ||
        typeof parsed?.private_key !== 'string'
      ) {
        throw new Error('missing fields');
      }
      credentials = {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
      };
    } catch {
      throw new Error(
        'SETHUCMS_FIRESTORE_CREDENTIALS_JSON must be a Google service-account key (JSON with client_email and private_key)',
      );
    }
  }
  if (settings.emulatorHost) {
    // The driver reads this variable when it is created.
    process.env['FIRESTORE_EMULATOR_HOST'] = settings.emulatorHost;
  }
  // Loaded by name so the code compiles without the driver installed.
  const moduleName = '@google-cloud/firestore';
  let driver: { Firestore: new (options: object) => unknown };
  try {
    driver = (await import(moduleName)) as typeof driver;
  } catch {
    throw new Error(
      'Firestore state needs the "@google-cloud/firestore" package. Run: pnpm add @google-cloud/firestore (in apps/api)',
    );
  }
  return new driver.Firestore({
    projectId: settings.projectId,
    ignoreUndefinedProperties: true,
    ...(credentials ? { credentials } : {}),
  }) as FirestoreLike;
}
