import type { LystrConnectorConfig, ShopifySubscriptionForLystr } from "./lystr.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<Response>;
};

type PartnerApiConfig = {
  organizationId: string;
  token: string;
};

type PartnerActiveSubscription = {
  billingPeriod?: string | null;
  cancelAtEndOfCycle?: boolean | null;
  currentBillingCycle?: {
    startTime?: string | null;
    endTime?: string | null;
  } | null;
  legacySubscriptionId?: string | null;
  trialEndsAt?: string | null;
  items?: PartnerSubscriptionItem[];
};

type PartnerSubscriptionItem = {
  handle?: string | null;
  price?: {
    __typename?: string;
    active?: boolean | null;
    amount?: number | string | null;
    currency?: string | null;
  } | null;
};

const DEFAULT_APP_HANDLE = "lystr-connect";
const DEFAULT_PLAN_HANDLES = ["lystr-connector-monthly", "pro-plan"];
const PARTNER_API_VERSION = "2026-07";

function normalizeHandle(value: string | null | undefined) {
  return value?.trim().toLowerCase() || "";
}

export function getShopifyAppHandle() {
  return process.env.SHOPIFY_APP_HANDLE?.trim() || DEFAULT_APP_HANDLE;
}

export function getAppPricingPlanHandles() {
  const raw =
    process.env.SHOPIFY_APP_PRICING_PLAN_HANDLES ||
    process.env.SHOPIFY_APP_PRICING_PLAN_HANDLE ||
    DEFAULT_PLAN_HANDLES.join(",");

  return raw
    .split(",")
    .map(normalizeHandle)
    .filter(Boolean);
}

export function isAcceptedAppPricingPlanHandle(planHandle: string | null | undefined) {
  const normalizedPlanHandle = normalizeHandle(planHandle);

  return (
    Boolean(normalizedPlanHandle) &&
    getAppPricingPlanHandles().includes(normalizedPlanHandle)
  );
}

export function getPlanHandleFromRequest(request: Request) {
  const url = new URL(request.url);
  const planHandle = normalizeHandle(url.searchParams.get("plan_handle"));

  return isAcceptedAppPricingPlanHandle(planHandle) ? planHandle : null;
}

function getStoreHandle(shopDomain: string) {
  return shopDomain.replace(/\.myshopify\.com$/i, "").split(".")[0];
}

export function getAppPricingPlanSelectionUrl(shopDomain: string) {
  const storeHandle = getStoreHandle(shopDomain);
  const appHandle = getShopifyAppHandle();

  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}

function getPartnerApiConfig(): PartnerApiConfig | null {
  const organizationId = (
    process.env.SHOPIFY_PARTNER_ORG_ID ||
    process.env.SHOPIFY_PARTNER_ORGANIZATION_ID ||
    ""
  ).trim();
  const token = process.env.SHOPIFY_PARTNER_ACCESS_TOKEN?.trim() || "";

  if (!organizationId || !token) {
    return null;
  }

  return {
    organizationId,
    token,
  };
}

async function getInstalledAppAndShopGids(admin: AdminGraphqlClient) {
  const response = await admin.graphql(`
    #graphql
    query LystrInstalledAppAndShopIds {
      shop {
        id
      }
      currentAppInstallation {
        app {
          id
        }
      }
    }
  `);
  const json = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        app?: {
          id?: string | null;
        } | null;
      } | null;
      shop?: { id?: string | null } | null;
    };
    errors?: unknown;
  };
  const appId = json.data?.currentAppInstallation?.app?.id;
  const shopId = json.data?.shop?.id;

  if (!appId) {
    throw new Error("Could not resolve Shopify app ID.");
  }

  if (!shopId) {
    throw new Error("Could not resolve Shopify shop ID.");
  }

  return { appId, shopId };
}

async function getPartnerActiveSubscription({
  admin,
}: {
  admin: AdminGraphqlClient;
}) {
  const partnerConfig = getPartnerApiConfig();

  if (!partnerConfig) {
    return null;
  }

  const { appId, shopId } = await getInstalledAppAndShopGids(admin);
  const response = await fetch(
    `https://partners.shopify.com/${partnerConfig.organizationId}/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": partnerConfig.token,
      },
      body: JSON.stringify({
        query: `
          query LystrActiveSubscription($appId: ID!, $shopId: ID!) {
            activeSubscription(appId: $appId, shopId: $shopId) {
              billingPeriod
              cancelAtEndOfCycle
              trialEndsAt
              legacySubscriptionId
              currentBillingCycle {
                startTime
                endTime
              }
              items {
                handle
                price {
                  __typename
                  active
                  currency
                  ... on FlatRatePrice {
                    amount
                  }
                }
              }
            }
          }
        `,
        variables: {
          appId,
          shopId,
        },
      }),
    }
  );
  const json = (await response.json()) as {
    data?: { activeSubscription?: PartnerActiveSubscription | null };
    errors?: { message?: string }[];
  };

  if (!response.ok || json.errors?.length) {
    throw new Error(
      json.errors?.[0]?.message || "Shopify Partner API request failed."
    );
  }

  return json.data?.activeSubscription ?? null;
}

function getAcceptedPartnerSubscriptionItem(
  subscription: PartnerActiveSubscription | null
) {
  if (!subscription?.items?.length) {
    return null;
  }

  return (
    subscription.items.find((item) =>
      isAcceptedAppPricingPlanHandle(item.handle)
    ) ?? null
  );
}

function getLineItemPrice(
  item: PartnerSubscriptionItem | null,
  config: LystrConnectorConfig
) {
  const amount = Number(item?.price?.amount);
  const currency = item?.price?.currency?.trim().toUpperCase();

  return {
    amount: Number.isFinite(amount) && amount >= 0 ? amount : config.monthlyPrice,
    currencyCode: currency || config.currency.toUpperCase(),
  };
}

function subscriptionFromPlanHandle({
  config,
  currentPeriodEnd,
  id,
  planHandle,
  shopDomain,
  startedAt,
}: {
  config: LystrConnectorConfig;
  currentPeriodEnd?: string | null;
  id?: string | null;
  planHandle: string;
  shopDomain: string;
  startedAt?: string | null;
}): ShopifySubscriptionForLystr {
  return {
    id: id || `shopify-app-pricing:${shopDomain}:${planHandle}`,
    name: planHandle,
    status: "ACTIVE",
    test: false,
    trialDays: config.freeTrialDays,
    createdAt: startedAt ?? null,
    currentPeriodEnd: currentPeriodEnd ?? null,
    lineItems: [
      {
        id: planHandle,
        plan: {
          pricingDetails: {
            price: {
              amount: config.monthlyPrice,
              currencyCode: config.currency.toUpperCase(),
            },
          },
        },
      },
    ],
  };
}

function subscriptionFromPartnerActiveSubscription({
  config,
  shopDomain,
  subscription,
}: {
  config: LystrConnectorConfig;
  shopDomain: string;
  subscription: PartnerActiveSubscription | null;
}) {
  const item = getAcceptedPartnerSubscriptionItem(subscription);
  const planHandle = normalizeHandle(item?.handle);

  if (!subscription || !item || !planHandle) {
    return null;
  }

  const price = getLineItemPrice(item, config);

  return {
    id:
      subscription.legacySubscriptionId ||
      `shopify-app-pricing:${shopDomain}:${planHandle}`,
    name: planHandle,
    status: subscription.cancelAtEndOfCycle ? "CANCELLED" : "ACTIVE",
    test: false,
    trialDays: config.freeTrialDays,
    createdAt: subscription.currentBillingCycle?.startTime ?? null,
    currentPeriodEnd: subscription.currentBillingCycle?.endTime ?? null,
    lineItems: [
      {
        id: planHandle,
        plan: {
          pricingDetails: {
            price,
          },
        },
      },
    ],
  } satisfies ShopifySubscriptionForLystr;
}

export async function getCurrentAppPricingSubscription({
  admin,
  config,
  request,
  shopDomain,
}: {
  admin: AdminGraphqlClient;
  config: LystrConnectorConfig;
  request: Request;
  shopDomain: string;
}) {
  const redirectPlanHandle = getPlanHandleFromRequest(request);

  if (redirectPlanHandle) {
    return subscriptionFromPlanHandle({
      config,
      planHandle: redirectPlanHandle,
      shopDomain,
    });
  }

  try {
    const partnerSubscription = await getPartnerActiveSubscription({ admin });

    return subscriptionFromPartnerActiveSubscription({
      config,
      shopDomain,
      subscription: partnerSubscription,
    });
  } catch (error) {
    console.warn("Failed to query Shopify App Pricing subscription.", error);
    return null;
  }
}
