import { DASHBOARD_API_KEY_URL } from "./config.js";

export class DoubleDataAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly retryAfterSeconds: number | null = null,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "DoubleDataAPIError";
  }
}

export class MissingAPIKeyError extends Error {
  constructor() {
    super(
      "No DoubleData API key is configured. Run `npx -y github:doubledata-proxy/doubledata-mcp login` in a terminal, " +
        `or create a key at ${DASHBOARD_API_KEY_URL} (Team > API key) and set DOUBLEDATA_API_KEY.`,
    );
    this.name = "MissingAPIKeyError";
  }
}

export type Usage = {
  from: string;
  to: string;
  currency: "usd";
  totals: UsageTotals;
  credentials: Array<UsageTotals & { id: string; username: string; display_name: string; proxy_type: string; enabled: boolean }>;
};
export type UsageTotals = { bandwidth_bytes: number; requests: number; wallet_spent_cents: number };
export type Balance = { balance_cents: number; currency: "usd" };
export type ProxyType = "residential" | "datacenter" | "mobile";
export type Credential = {
  id: string;
  username: string;
  display_name: string;
  proxy_type: ProxyType;
  enabled: boolean;
  funding_source: "package_bytes" | "workspace_balance" | null;
  traffic_used_mb: number;
  limits_mb: { total: number; daily: number; weekly: number; monthly: number };
  created_at: string;
};
export type CredentialSecret = Credential & {
  password: string;
  connection: {
    gateways: Array<{ region: string; host: string; default: boolean }>;
    ports: { http: number; https: number | null; socks5: number };
  };
};
export type Invoice = {
  id: string;
  number: string | null;
  status: "open" | "paid" | "void" | "uncollectible";
  description: string | null;
  currency: string;
  total_cents: number;
  amount_paid_cents: number;
  amount_due_cents: number;
  created_at: string;
  paid_at: string | null;
  hosted_invoice_url: string | null;
  pdf_available: boolean;
};
export type InvoicePage = { invoices: Invoice[]; has_more: boolean; next_cursor: string | null };
export type TrafficLimits = {
  traffic_limit_mb?: number;
  daily_limit_mb?: number;
  weekly_limit_mb?: number;
  monthly_limit_mb?: number;
};
export type DownloadedFile = { bytes: Uint8Array; filename: string; contentType: string };
export type TrafficProduct = {
  id: string;
  proxy_type: string;
  name: string;
  description: string;
  amount_gb: number;
  price_per_gb_cents: number;
  total_cents: number;
  requires_verification: boolean;
};
export type PaymentMethod = { id: string; type: string; brand: string; last4: string; exp_month: number; exp_year: number; is_default: boolean };
export type TrafficOrder = {
  order: {
    id: string;
    product_id: string;
    proxy_type: string;
    amount_gb: number;
    price_per_gb_cents: number;
    total_cents: number;
    payment_source: "balance";
  };
  traffic_balance: { proxy_type: string; remaining_bytes: number };
};
export type TopUp = {
  top_up: { amount_cents: number; currency: string; payment_method_id: string; receipt_url: string | null };
  balance_cents: number | null;
};

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  // Sent as X-Request-ID. Purchases replay instead of charging twice when it repeats.
  requestId?: string;
};

type ClientOptions = {
  apiKey: string | null;
  apiUrl: string;
  fetch?: typeof fetch;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
};

const segment = (value: string) => encodeURIComponent(value);

// A thin, typed REST client. Safe methods retry rate limits and transient
// outages; mutations never retry because the server may already have applied them.
export class DoubleDataClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
  }

  get hasAPIKey() {
    return Boolean(this.options.apiKey);
  }

  private async send(path: string, options: RequestOptions = {}): Promise<Response> {
    if (!this.options.apiKey) throw new MissingAPIKeyError();
    const method = options.method ?? "GET";
    const url = new URL(`${this.options.apiUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: "application/json, application/pdf",
      "User-Agent": this.options.userAgent ?? "doubledata-mcp",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.requestId) headers["X-Request-ID"] = options.requestId;

    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const retryable = method === "GET" && (response.status === 429 || response.status === 503);
      if (response.ok || !retryable || attempt >= this.maxRetries) {
        if (!response.ok) throw await toError(response);
        return response;
      }
      const retryAfter = Number(response.headers.get("Retry-After"));
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt);
    }
  }

  private async json<T>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.send(path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  getBalance() {
    return this.json<Balance>("/balance");
  }

  getUsage(query: { from?: string; to?: string; username?: string; credential_id?: string } = {}) {
    return this.json<Usage>("/usage", { query });
  }

  listCredentials() {
    return this.json<{ credentials: Credential[]; total: number }>("/proxies");
  }

  getCredential(username: string) {
    return this.json<CredentialSecret>(`/proxies/${segment(username)}`);
  }

  createCredential(input: { name: string; proxy_type: ProxyType }) {
    return this.json<CredentialSecret>("/proxies", { method: "POST", body: input });
  }

  deleteCredential(username: string) {
    return this.json<void>(`/proxies/${segment(username)}`, { method: "DELETE" });
  }

  getTrafficLimits(username: string) {
    return this.json<Record<string, unknown>>(`/proxies/${segment(username)}/limits`);
  }

  setTrafficLimits(username: string, limits: TrafficLimits) {
    return this.json<Record<string, unknown>>(`/proxies/${segment(username)}/limits`, { method: "PUT", body: limits });
  }

  listInvoices(query: { limit?: number; starting_after?: string; status?: string } = {}) {
    return this.json<InvoicePage>("/invoices", { query });
  }

  getInvoice(invoiceId: string) {
    return this.json<Invoice>(`/invoices/${segment(invoiceId)}`);
  }

  async downloadInvoicePDF(invoiceId: string): Promise<DownloadedFile> {
    const response = await this.send(`/invoices/${segment(invoiceId)}/pdf`);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      filename: match?.[1] ?? `${invoiceId}.pdf`,
      contentType: response.headers.get("Content-Type") ?? "application/pdf",
    };
  }

  listTrafficProducts() {
    return this.json<{ products: TrafficProduct[] }>("/traffic/products");
  }

  buyTraffic(productId: string, requestId: string) {
    return this.json<TrafficOrder>("/traffic/orders", { method: "POST", body: { product_id: productId }, requestId });
  }

  listPaymentMethods() {
    return this.json<{ payment_methods: PaymentMethod[] }>("/payment-methods");
  }

  addFunds(input: { amount_cents: number; payment_method_id?: string }, requestId: string) {
    return this.json<TopUp>("/balance/top-ups", { method: "POST", body: input, requestId });
  }

  ispCatalog() {
    return this.json<Record<string, unknown>>("/isp/catalog");
  }

  ispQuote(input: Record<string, unknown>) {
    return this.json<Record<string, unknown>>("/isp/quotes", { method: "POST", body: input });
  }

  ispOrder(quoteId: string) {
    return this.json<Record<string, unknown>>("/isp/orders", { method: "POST", body: { quote_id: quoteId } });
  }

  ispOrderStatus(orderId: string) {
    return this.json<Record<string, unknown>>(`/isp/orders/${segment(orderId)}`);
  }

  ispSubscriptions() {
    return this.json<{ subscriptions: Array<Record<string, unknown>> }>("/isp/subscriptions");
  }

  ispCancelRenewal(subscriptionId: string) {
    return this.json<Record<string, unknown>>(`/isp/subscriptions/${segment(subscriptionId)}`, { method: "DELETE" });
  }

  ispProxies(subscriptionId: string) {
    return this.json<{ proxies: Array<Record<string, unknown>> }>(`/isp/subscriptions/${segment(subscriptionId)}/proxies`);
  }

  ispRotate(subscriptionId: string, ips: string[]) {
    return this.json<Record<string, unknown>>(`/isp/subscriptions/${segment(subscriptionId)}/rotations`, { method: "POST", body: { ips } });
  }

  ispRotationStatus(rotationId: string) {
    return this.json<Record<string, unknown>>(`/isp/rotations/${segment(rotationId)}`);
  }

  ispGetAuthorization(subscriptionId: string) {
    return this.json<Record<string, unknown>>(`/isp/subscriptions/${segment(subscriptionId)}/ip-authorization`);
  }

  ispSetAuthorization(subscriptionId: string, ip: string) {
    return this.json<Record<string, unknown>>(`/isp/subscriptions/${segment(subscriptionId)}/ip-authorization`, { method: "PUT", body: { ip } });
  }

  ispRemoveAuthorization(subscriptionId: string) {
    return this.json<Record<string, unknown>>(`/isp/subscriptions/${segment(subscriptionId)}/ip-authorization`, { method: "DELETE" });
  }
}

async function toError(response: Response) {
  const requestId = response.headers.get("X-Request-ID");
  const retryAfter = Number(response.headers.get("Retry-After"));
  let code = "http_error";
  let message = `DoubleData API returned HTTP ${response.status}.`;
  let details: Record<string, unknown> | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    details = body.error?.details ?? null;
  } catch {
    // Non-JSON errors keep the generic message.
  }
  if (response.status === 401) {
    message = `${message} The API key is missing, revoked or rotated. Create a new one at ${DASHBOARD_API_KEY_URL}.`;
  }
  return new DoubleDataAPIError(response.status, code, message, requestId, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null, details);
}
