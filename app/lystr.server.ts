const LYSTR_CONNECTOR_SECRET_HEADER = "x-lystr-connector-secret";

export type LystrConnectorConfig = {
  creditsPerSuccessfulPayment: number;
  currency: string;
  freeTrialDays: number;
  migrationBillingStartsAt: string;
  monthlyPrice: number;
  monthlyPriceCents: number;
  planName: string;
};

export type LystrConnectorStatus = {
  accessAllowed: boolean;
  billingApprovalRequired: boolean;
  billingStatus?: string | null;
  creditsPerSuccessfulPayment: number;
  currency: string;
  grandfatheredBillingStartsAt?: string | null;
  isGrandfathered?: boolean;
  lastSuccessfulPaymentAt?: string | null;
  latestCreditsGranted?: number;
  monthlyPrice: number;
  monthlyPriceCents: number;
  nextBillingDate?: string | null;
  remainingTrialDays: number;
  shopifyPlanHandle?: string | null;
  shopifySubscriptionId?: string | null;
  shopifySubscriptionStatus?: string | null;
  status: string;
  trialEndsAt: string | null;
  trialStartedAt: string | null;
};

export type LystrStoreSummary = {
  id: string;
  name: string;
  shopDomain: string | null;
};

export type ShopifySubscriptionForLystr = {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  test?: boolean | null;
  trialDays?: number | null;
  createdAt?: string | null;
  currentPeriodEnd?: string | null;
  lineItems?: {
    id?: string | null;
    plan?: {
      pricingDetails?: {
        price?: {
          amount?: number | string | null;
          currencyCode?: string | null;
        } | null;
      } | null;
    } | null;
  }[];
};

type LystrApiResponse<T> = T & {
  error?: string;
};

function getLystrApiBaseUrl() {
  return (
    process.env.LYSTR_API_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://lystr.ai"
  );
}

function getConnectorSecret() {
  const secret = process.env.LYSTR_CONNECTOR_SHARED_SECRET?.trim();

  if (!secret) {
    throw new Error("LYSTR_CONNECTOR_SHARED_SECRET is not configured.");
  }

  return secret;
}

async function requestLystr<T>(path: string, init?: RequestInit) {
  const url = `${getLystrApiBaseUrl()}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      [LYSTR_CONNECTOR_SECRET_HEADER]: getConnectorSecret(),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as LystrApiResponse<T>;

  if (!response.ok) {
    throw new Error(
      data.error ||
        `Lystr API request failed for ${path} (${response.status} ${response.statusText}).`
    );
  }

  return data as T;
}

export async function getLystrConnectorConfig() {
  return requestLystr<{ config: LystrConnectorConfig }>(
    "/api/shopify-connector/config"
  );
}

export async function prepareLystrStoreConnection(input: {
  apiKey: string;
  shopDomain: string;
}) {
  return requestLystr<{
    config: LystrConnectorConfig;
    connector: LystrConnectorStatus;
    store: LystrStoreSummary;
  }>("/api/shopify-connector/stores/prepare", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function connectLystrStore(input: {
  accessToken: string;
  apiKey: string;
  shopDomain: string;
}) {
  return requestLystr<{
    config: LystrConnectorConfig;
    connector: LystrConnectorStatus;
    store: LystrStoreSummary;
  }>("/api/shopify-connector/stores/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function syncLystrConnectorBilling(input: {
  shopDomain: string;
  shopifySubscription: ShopifySubscriptionForLystr | null;
  shopifyWebhookId?: string | null;
}) {
  return requestLystr<{
    config: LystrConnectorConfig;
    connector: LystrConnectorStatus;
    creditGrant?: unknown;
  }>("/api/shopify-connector/billing/sync", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function markLystrConnectorUninstalled(input: {
  shopDomain: string;
  shopifyWebhookId?: string | null;
}) {
  return requestLystr<{ connector: LystrConnectorStatus | null }>(
    "/api/shopify-connector/uninstalled",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
}
