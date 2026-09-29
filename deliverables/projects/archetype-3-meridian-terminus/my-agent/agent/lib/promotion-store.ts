import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BLOB_PATHNAME = "galaxus/apple-promotions.json";
const BLOB_API = "https://vercel.com/api/blob";

export type SeenProduct = {
  onPromotion: boolean;
  pendingAlert: boolean;
  price: number;
  currency: string;
  previousPrice: number | null;
  rebatePercent: number | null;
  name: string;
  url: string;
  lastSeen: string;
};

export type MonitorState = {
  version: 1;
  updatedAt: string | null;
  cursor: string | null;
  alertEmail: string | null;
  operationHash: string | null;
  products: Record<string, SeenProduct>;
};

export function emptyState(): MonitorState {
  return {
    version: 1,
    updatedAt: null,
    cursor: null,
    alertEmail: null,
    operationHash: null,
    products: {},
  };
}

let memory: MonitorState | null = null;

function statePath(): string {
  return process.env.GALAXUS_MONITOR_STATE_PATH?.trim() || "/tmp/galaxus-apple-promotions.json";
}

function explicitStatePath(): boolean {
  return Boolean(process.env.GALAXUS_MONITOR_STATE_PATH?.trim());
}

function blobAuth(): { token: string; storeId: string } | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) return null;
  const storeId = token.split("_")[3];
  if (!storeId) return null;
  return { token, storeId };
}

export function durableStoreConfigured(): boolean {
  return explicitStatePath() || blobAuth() !== null;
}

function parseState(raw: string): MonitorState | null {
  try {
    const value = JSON.parse(raw) as Partial<MonitorState>;
    if (value.version !== 1 || !value.products || typeof value.products !== "object") {
      return null;
    }
    return {
      version: 1,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
      cursor: typeof value.cursor === "string" ? value.cursor : null,
      alertEmail: typeof value.alertEmail === "string" ? value.alertEmail : null,
      operationHash: typeof value.operationHash === "string" ? value.operationHash : null,
      products: value.products,
    };
  } catch {
    return null;
  }
}

async function readFileState(): Promise<MonitorState | null> {
  try {
    return parseState(await readFile(statePath(), "utf8"));
  } catch {
    return null;
  }
}

async function readBlobState(): Promise<MonitorState | null> {
  const auth = blobAuth();
  if (!auth) return null;
  try {
    const response = await fetch(
      `https://${auth.storeId}.private.blob.vercel-storage.com/${BLOB_PATHNAME}`,
      {
        headers: { authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return null;
    return parseState(await response.text());
  } catch {
    return null;
  }
}

async function writeFileState(body: string): Promise<boolean> {
  try {
    const path = statePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function writeBlobState(body: string): Promise<boolean> {
  const auth = blobAuth();
  if (!auth) return false;
  try {
    const response = await fetch(
      `${BLOB_API}/?pathname=${encodeURIComponent(BLOB_PATHNAME)}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${auth.token}`,
          "x-add-random-suffix": "0",
          "x-allow-overwrite": "1",
          "x-api-version": "12",
          "x-content-type": "application/json",
          "x-vercel-blob-access": "private",
          "x-vercel-blob-store-id": auth.storeId,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

function newer(left: MonitorState | null, right: MonitorState | null): MonitorState | null {
  if (!left) return right;
  if (!right) return left;
  const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
  const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
  return rightTime > leftTime ? right : left;
}

export async function loadState(): Promise<{ state: MonitorState; existed: boolean }> {
  if (memory) return { state: memory, existed: true };
  const loaded = newer(await readFileState(), await readBlobState());
  if (!loaded) return { state: emptyState(), existed: false };
  memory = loaded;
  return { state: loaded, existed: true };
}

export async function saveState(state: MonitorState): Promise<{ file: boolean; blob: boolean }> {
  state.updatedAt = new Date().toISOString();
  memory = state;
  const body = JSON.stringify(state);
  const [file, blob] = await Promise.all([writeFileState(body), writeBlobState(body)]);
  return { file, blob };
}

export function alertEmail(state: MonitorState): string | null {
  const fromEnv = process.env.GALAXUS_ALERT_EMAIL?.trim();
  if (fromEnv) return fromEnv;
  return state.alertEmail?.trim() || null;
}

export function promotionsInState(state: MonitorState, limit: number): SeenProduct[] {
  return Object.values(state.products)
    .filter((product) => product.onPromotion)
    .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen))
    .slice(0, limit);
}
