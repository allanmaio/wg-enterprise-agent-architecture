const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const APPLE_BRAND_ID = 47;
const OPERATION = "brandProductListRelayQuery";

export type AppleProduct = {
  id: string;
  name: string;
  url: string;
  price: number;
  currency: string;
  previousPrice: number | null;
  rebatePercent: number | null;
  onPromotion: boolean;
};

export type ScanResult = {
  ok: boolean;
  error?: string;
  host: string;
  products: AppleProduct[];
  cursor: string | null;
  catalogComplete: boolean;
  pages: number;
};

type Shop = {
  host: string;
  portalId: number;
  hash: string;
};

function brandGlobalId(databaseId: number): string {
  return Buffer.from(`Brand\ni${databaseId}`, "utf8").toString("base64");
}

function clean(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function absoluteUrl(host: string, relativeUrl: string): string {
  if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
    return relativeUrl;
  }
  return `${host}${relativeUrl.startsWith("/") ? "" : "/"}${relativeUrl}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function moneyAmount(value: unknown): { amount: number; currency: string } | null {
  const record = asRecord(value);
  if (!record || typeof record.amountInclusive !== "number") return null;
  const currency = typeof record.currency === "string" ? record.currency : "CHF";
  return { amount: record.amountInclusive, currency };
}

function readPrice(obj: Record<string, unknown>): {
  id: string;
  price: number;
  currency: string;
  previousPrice: number | null;
  rebatePercent: number | null;
  onPromotion: boolean;
} | null {
  if (typeof obj.databaseId !== "number") return null;
  const price = moneyAmount(obj.price);
  if (!price) return null;

  const instead = asRecord(obj.insteadOfPrice);
  const previous = instead ? moneyAmount(instead.price) : null;
  const rebate =
    instead && typeof instead.rebate === "number" ? instead.rebate : null;
  const labels = Array.isArray(obj.labels)
    ? obj.labels.filter((label): label is string => typeof label === "string")
    : [];
  const onPromotion =
    previous !== null || rebate !== null || labels.includes("DISCOUNT");

  return {
    id: String(obj.databaseId),
    price: price.amount,
    currency: price.currency,
    previousPrice: previous?.amount ?? null,
    rebatePercent: rebate,
    onPromotion,
  };
}

function readCard(
  obj: Record<string, unknown>,
  host: string,
): { id: string; name: string; url: string } | null {
  if (typeof obj.relativeUrl !== "string" || !obj.relativeUrl.includes("/product/")) {
    return null;
  }
  if (typeof obj.name !== "string" || obj.name.length === 0) return null;

  const fromTracking = typeof obj.trackingId === "number" ? String(obj.trackingId) : null;
  const fromUrl = obj.relativeUrl.match(/(\d{5,})(?:\?|#|$)/)?.[1] ?? null;
  const id = fromTracking ?? fromUrl;
  if (!id) return null;

  const extensions = asRecord(obj.nameExtensions);
  const properties =
    extensions && typeof extensions.properties === "string"
      ? clean(extensions.properties)
      : "";
  const title = clean(obj.name);
  const name = title.toLowerCase().startsWith("apple ")
    ? title
    : `Apple ${title}`;

  return {
    id,
    name: properties ? `${name} (${properties})` : name,
    url: absoluteUrl(host, obj.relativeUrl),
  };
}

function collectProducts(data: unknown, host: string): AppleProduct[] {
  const prices = new Map<string, ReturnType<typeof readPrice> & object>();
  const cards = new Map<string, { id: string; name: string; url: string }>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    const price = readPrice(obj);
    if (price) prices.set(price.id, price);
    const card = readCard(obj, host);
    if (card) cards.set(card.id, card);
    for (const child of Object.values(obj)) visit(child);
  };

  visit(data);

  const products: AppleProduct[] = [];
  for (const [id, price] of prices) {
    const card = cards.get(id);
    if (!card || !price) continue;
    products.push({
      id,
      name: card.name,
      url: card.url,
      price: price.price,
      currency: price.currency,
      previousPrice: price.previousPrice,
      rebatePercent: price.rebatePercent,
      onPromotion: price.onPromotion,
    });
  }
  return products;
}

function readPageInfo(data: unknown): { endCursor: string | null; hasNextPage: boolean } {
  let best: { endCursor: string | null; hasNextPage: boolean; edges: number } | null =
    null;

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    const edges = obj.edges;
    const pageInfo = asRecord(obj.pageInfo);
    if (Array.isArray(edges) && pageInfo && typeof pageInfo.hasNextPage === "boolean") {
      const hasProduct = edges.some((edge) => {
        const node = asRecord(asRecord(edge)?.node);
        return node !== null && typeof node.databaseId === "number";
      });
      if (hasProduct && (!best || edges.length > best.edges)) {
        best = {
          endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
          hasNextPage: pageInfo.hasNextPage,
          edges: edges.length,
        };
      }
    }
    for (const child of Object.values(obj)) visit(child);
  };

  visit(data);
  return best
    ? { endCursor: best.endCursor, hasNextPage: best.hasNextPage }
    : { endCursor: null, hasNextPage: false };
}

async function fetchText(url: string): Promise<{ url: string; text: string }> {
  const response = await fetch(url, {
    headers: { accept: "text/html,application/javascript,*/*", "user-agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Galaxus returned HTTP ${response.status} for ${url}`);
  }
  return { url: response.url, text: await response.text() };
}

async function resolveShop(cachedHash: string | null): Promise<Shop> {
  const start = process.env.GALAXUS_HOST?.trim() || "https://www.galaxus.com/en";
  const home = await fetchText(start);
  const host = new URL(home.url).origin;
  const portalMatch = home.text.match(/"portalId":(\d+)/);
  const portalId = portalMatch ? Number(portalMatch[1]) : 22;
  const brandPage = await fetchText(`${host}/en/brand/apple-${APPLE_BRAND_ID}`);
  const scriptMatch = brandPage.text.match(/src="([^"]*\/pages\/brand\/[^"]+\.js)"/);
  if (!scriptMatch) {
    if (cachedHash) return { host, portalId, hash: cachedHash };
    throw new Error("Could not find the Galaxus brand page script.");
  }
  const scriptUrl = scriptMatch[1].startsWith("http")
    ? scriptMatch[1]
    : new URL(scriptMatch[1], host).toString();
  const script = await fetchText(scriptUrl);
  const hashMatch = script.text.match(
    /params:\{id:"([a-f0-9]+)",metadata:\{owner:"[^"]*"\},name:"brandProductListRelayQuery"/,
  );
  if (!hashMatch) {
    if (cachedHash) return { host, portalId, hash: cachedHash };
    throw new Error("Could not read the current Galaxus product-list query.");
  }
  return { host, portalId, hash: hashMatch[1] };
}

async function queryProducts(
  shop: Shop,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${shop.host}/graphql/o/${shop.hash}/${OPERATION}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: shop.host,
      referer: `${shop.host}/en/brand/apple-${APPLE_BRAND_ID}`,
      "user-agent": USER_AGENT,
      "x-dg-graphql-client-name": "isomorph",
      "x-dg-language": "en-US",
      "x-dg-portal": String(shop.portalId),
    },
    body: JSON.stringify({ variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as {
    data?: unknown;
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    const message = body.errors.map((error) => error.message ?? "unknown error").join("; ");
    throw new Error(message);
  }
  if (!response.ok) {
    throw new Error(`Galaxus returned HTTP ${response.status} for ${OPERATION}`);
  }
  return body.data;
}

function pageVariables(
  after: string | null,
  filters: Array<Record<string, unknown>>,
  first: number,
): Record<string, unknown> {
  return {
    brandId: brandGlobalId(APPLE_BRAND_ID),
    first,
    after,
    asPath: `/en/brand/apple-${APPLE_BRAND_ID}`,
    filters,
    sortOrder: "RELEVANCE",
  };
}

export async function scanApplePromotions(options: {
  cursor?: string | null;
  maxPages?: number;
  pageSize?: number;
  budgetMs?: number;
  cachedHash?: string | null;
}): Promise<ScanResult & { hash: string | null }> {
  const maxPages = options.maxPages ?? 20;
  const pageSize = options.pageSize ?? 48;
  const budgetMs = options.budgetMs ?? 15_000;
  const started = Date.now();
  const products = new Map<string, AppleProduct>();
  let cursor = options.cursor ?? null;
  let catalogComplete = false;
  let pages = 0;
  let hash: string | null = options.cachedHash ?? null;

  try {
    const shop = await resolveShop(options.cachedHash ?? null);
    hash = shop.hash;

    const sale = await queryProducts(
      shop,
      pageVariables(null, [{ filterIdentifier: "off", optionIdentifiers: ["Sale"] }], 24),
    );
    for (const product of collectProducts(sale, shop.host)) products.set(product.id, product);

    while (pages < maxPages && Date.now() - started < budgetMs) {
      const data = await queryProducts(shop, pageVariables(cursor, [], pageSize));
      for (const product of collectProducts(data, shop.host)) products.set(product.id, product);
      pages += 1;
      const pageInfo = readPageInfo(data);
      if (!pageInfo.hasNextPage) {
        cursor = null;
        catalogComplete = true;
        break;
      }
      cursor = pageInfo.endCursor;
      if (!cursor) break;
    }

    return {
      ok: true,
      host: shop.host,
      products: [...products.values()],
      cursor,
      catalogComplete,
      pages,
      hash,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Galaxus check failed",
      host: "https://www.galaxus.ch",
      products: [...products.values()],
      cursor,
      catalogComplete: false,
      pages,
      hash,
    };
  }
}
