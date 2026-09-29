import { scanApplePromotions, type AppleProduct } from "./galaxus";
import {
  alertEmail,
  durableStoreConfigured,
  loadState,
  promotionsInState,
  saveState,
  type MonitorState,
  type SeenProduct,
} from "./promotion-store";

export type CheckResult = {
  ok: boolean;
  error?: string;
  checkedAt: string;
  observed: number;
  onPromotion: number;
  newlyEntered: AppleProduct[];
  emailed: boolean;
  emailError?: string;
  alertEmail: string | null;
  durable: boolean;
  baseline: boolean;
  catalogComplete: boolean;
  missing: string[];
};

function missingConfig(email: string | null): string[] {
  const missing: string[] = [];
  if (!email) missing.push("GALAXUS_ALERT_EMAIL or an address saved in chat");
  if (!process.env.RESEND_API_KEY?.trim()) missing.push("RESEND_API_KEY");
  if (!process.env.RESEND_FROM_ADDRESS?.trim()) missing.push("RESEND_FROM_ADDRESS");
  if (!durableStoreConfigured()) {
    missing.push(
      "a durable snapshot store: set GALAXUS_MONITOR_STATE_PATH to a persistent file, or BLOB_READ_WRITE_TOKEN. Without one, serverless cron runs cannot remember the previous price and will not email transitions",
    );
  }
  return missing;
}

function formatMoney(currency: string, amount: number): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function formatProduct(product: AppleProduct): string {
  const was =
    product.previousPrice !== null
      ? `, was ${formatMoney(product.currency, product.previousPrice)}`
      : "";
  const rebate =
    product.rebatePercent !== null
      ? ` (−${product.rebatePercent}%)`
      : product.previousPrice !== null && product.previousPrice > product.price
        ? ` (−${Math.round((1 - product.price / product.previousPrice) * 100)}%)`
        : "";
  return `${product.name} — ${formatMoney(product.currency, product.price)}${was}${rebate}\n${product.url}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function alertBody(products: AppleProduct[]): { text: string; html: string } {
  const lines = products.map(formatProduct);
  const text = [
    "These Apple products newly entered promotion on Galaxus (https://www.galaxus.com):",
    "",
    ...lines.flatMap((line) => [line, ""]),
    "Promotion means Galaxus now lists a previous price or a discount label after an earlier check saw the regular price.",
    "The check runs every 2 minutes and only emails new entries.",
  ].join("\n");

  const items = products
    .map((product) => {
      const was =
        product.previousPrice !== null
          ? `, was ${escapeHtml(formatMoney(product.currency, product.previousPrice))}`
          : "";
      return `<li><a href="${escapeHtml(product.url)}">${escapeHtml(product.name)}</a> — ${escapeHtml(formatMoney(product.currency, product.price))}${was}</li>`;
    })
    .join("");
  const html = `<p>These Apple products newly entered promotion on <a href="https://www.galaxus.com">Galaxus</a>:</p><ul>${items}</ul><p>Promotion means Galaxus now lists a previous price or a discount label after an earlier check saw the regular price. The check runs every 2 minutes and only emails new entries.</p>`;
  return { text, html };
}

function fromAddress(): string | null {
  const raw = process.env.RESEND_FROM_ADDRESS?.trim();
  if (!raw) return null;
  if (raw.includes("<")) return raw;
  return `Galaxus alerts <${raw}>`;
}

async function sendAlert(email: string, products: AppleProduct[]): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = fromAddress();
  if (!apiKey || !from) {
    return { ok: false, error: "Resend is not configured" };
  }
  const { text, html } = alertBody(products);
  const key = `galaxus-${new Date().toISOString().slice(0, 10)}-${products
    .map((product) => product.id)
    .sort()
    .join("-")
    .slice(0, 180)}`;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject:
          products.length === 1
            ? "Galaxus: 1 Apple product entered promotion"
            : `Galaxus: ${products.length} Apple products entered promotion`,
        text,
        html,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      return { ok: false, error: `Resend returned HTTP ${response.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Resend request failed" };
  }
}

function toAlertProduct(seen: SeenProduct, id: string): AppleProduct {
  return {
    id,
    name: seen.name,
    url: seen.url,
    price: seen.price,
    currency: seen.currency,
    previousPrice: seen.previousPrice,
    rebatePercent: seen.rebatePercent,
    onPromotion: true,
  };
}

export async function runPromotionCheck(): Promise<CheckResult> {
  const { state, existed } = await loadState();
  const email = alertEmail(state);
  const checkedAt = new Date().toISOString();
  const scan = await scanApplePromotions({
    cursor: state.cursor,
    cachedHash: state.operationHash,
    maxPages: numberEnv("GALAXUS_MAX_PAGES", 20),
    pageSize: numberEnv("GALAXUS_PAGE_SIZE", 48),
    budgetMs: numberEnv("GALAXUS_SCAN_BUDGET_MS", 15_000),
  });

  if (!scan.ok && scan.products.length === 0) {
    return {
      ok: false,
      error: scan.error,
      checkedAt,
      observed: 0,
      onPromotion: 0,
      newlyEntered: [],
      emailed: false,
      alertEmail: email,
      durable: durableStoreConfigured(),
      baseline: !existed,
      catalogComplete: false,
      missing: missingConfig(email),
    };
  }

  const pendingIds = new Set<string>();
  for (const product of scan.products) {
    const previous = state.products[product.id];
    const entered = product.onPromotion && previous !== undefined && !previous.onPromotion;
    const retry = product.onPromotion && previous?.pendingAlert === true;
    if (entered || retry) pendingIds.add(product.id);
    state.products[product.id] = {
      onPromotion: product.onPromotion,
      pendingAlert: entered || retry,
      price: product.price,
      currency: product.currency,
      previousPrice: product.previousPrice,
      rebatePercent: product.rebatePercent,
      name: product.name,
      url: product.url,
      lastSeen: checkedAt,
    };
  }

  state.cursor = scan.catalogComplete ? null : scan.cursor;
  if (scan.hash) state.operationHash = scan.hash;

  const newlyEntered = [...pendingIds].map((id) => {
    const seen = state.products[id];
    return toAlertProduct(seen, id);
  });

  let emailed = false;
  let emailError: string | undefined;
  const canSend = Boolean(email && process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM_ADDRESS?.trim());
  if (newlyEntered.length > 0 && canSend && email) {
    const sent = await sendAlert(email, newlyEntered);
    emailed = sent.ok;
    emailError = sent.error;
    if (sent.ok) {
      for (const id of pendingIds) state.products[id].pendingAlert = false;
    }
  }

  await saveState(state);

  return {
    ok: scan.ok,
    error: scan.error,
    checkedAt,
    observed: scan.products.length,
    onPromotion: scan.products.filter((product) => product.onPromotion).length,
    newlyEntered,
    emailed,
    emailError,
    alertEmail: email,
    durable: durableStoreConfigured(),
    baseline: !existed,
    catalogComplete: scan.catalogComplete,
    missing: missingConfig(email),
  };
}

export async function currentPromotions(options: {
  refresh?: boolean;
  limit?: number;
}): Promise<{
  promotions: Array<Pick<SeenProduct, "name" | "url" | "price" | "currency" | "previousPrice" | "rebatePercent">>;
  alertEmail: string | null;
  pendingAlerts: number;
  durable: boolean;
  missing: string[];
  error?: string;
  partial: boolean;
}> {
  const limit = options.limit ?? 30;
  const { state } = await loadState();
  const email = alertEmail(state);
  const pendingAlerts = Object.values(state.products).filter(
    (product) => product.pendingAlert && product.onPromotion,
  ).length;
  if (!options.refresh) {
    return {
      promotions: promotionsInState(state, limit).map((product) => ({
        name: product.name,
        url: product.url,
        price: product.price,
        currency: product.currency,
        previousPrice: product.previousPrice,
        rebatePercent: product.rebatePercent,
      })),
      alertEmail: email,
      pendingAlerts,
      durable: durableStoreConfigured(),
      missing: missingConfig(email),
      partial: state.cursor !== null,
    };
  }

  const scan = await scanApplePromotions({
    cachedHash: state.operationHash,
    maxPages: 8,
    pageSize: 48,
    budgetMs: 12_000,
  });
  const promotions = scan.products
    .filter((product) => product.onPromotion)
    .slice(0, limit)
    .map((product) => ({
      name: product.name,
      url: product.url,
      price: product.price,
      currency: product.currency,
      previousPrice: product.previousPrice,
      rebatePercent: product.rebatePercent,
    }));
  return {
    promotions,
    alertEmail: email,
    pendingAlerts,
    durable: durableStoreConfigured(),
    missing: missingConfig(email),
    error: scan.ok ? undefined : scan.error,
    partial: !scan.catalogComplete,
  };
}

export async function saveAlertEmail(email: string): Promise<{
  alertEmail: string;
  missing: string[];
  emailed: boolean;
  emailError?: string;
  pending: number;
}> {
  const { state } = await loadState();
  state.alertEmail = email;
  const pending = Object.entries(state.products).filter(
    ([, product]) => product.pendingAlert && product.onPromotion,
  );
  let emailed = false;
  let emailError: string | undefined;
  if (
    pending.length > 0 &&
    process.env.RESEND_API_KEY?.trim() &&
    process.env.RESEND_FROM_ADDRESS?.trim()
  ) {
    const sent = await sendAlert(
      email,
      pending.map(([id, product]) => toAlertProduct(product, id)),
    );
    emailed = sent.ok;
    emailError = sent.error;
    if (sent.ok) {
      for (const [id] of pending) state.products[id].pendingAlert = false;
    }
  }
  await saveState(state);
  return {
    alertEmail: email,
    missing: missingConfig(email),
    emailed,
    emailError,
    pending: pending.length,
  };
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
