import type { LystrConnectorConfig, ShopifySubscriptionForLystr } from "./lystr.server";
import {
  getAppPricingPlanDefinitionByHandle,
  isAcceptedAppPricingPlanHandle,
  isFreeAppPricingPlanHandle,
} from "./shopify-app-pricing-plans.server";

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
const PARTNER_API_VERSION = "2026-07";

function normalizeHandle(value: string | null | undefined) {
  return value?.trim().toLowerCase() || "";
}

export function getShopifyAppHandle() {
  return process.env.SHOPIFY_APP_HANDLE?.trim() || DEFAULT_APP_HANDLE;
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

  if (!Number.isFinite(amount) || amount < 0) {
    return isFreeAppPricingPlanHandle(item?.handle) ? {
      amount: 0,
      currencyCode: currency || config.currency.toUpperCase(),
    } : null;
  }

  return {
    amount,
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
  const planDefinition = getAppPricingPlanDefinitionByHandle(planHandle);

  return {
    id: id || `shopify-app-pricing:${shopDomain}:${planHandle}`,
    name: planDefinition?.label ?? planHandle,
    planKey: planDefinition?.key ?? null,
    status: "ACTIVE",
    test: false,
    trialDays: 0,
    createdAt: startedAt ?? null,
    currentPeriodEnd: currentPeriodEnd ?? null,
    lineItems: [
      {
        id: planHandle,
        plan: {
          pricingDetails: {
            price: {
              amount: 0,
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
  const planDefinition = getAppPricingPlanDefinitionByHandle(planHandle);

  if (!subscription || !item || !planHandle || !planDefinition) {
    return null;
  }

  const price = getLineItemPrice(item, config);

  if (!price) {
    return null;
  }

  return {
    id:
      subscription.legacySubscriptionId ||
      `shopify-app-pricing:${shopDomain}:${planHandle}`,
    name: planDefinition.label,
    planKey: planDefinition.key,
    status: subscription.cancelAtEndOfCycle ? "CANCELLED" : "ACTIVE",
    test: false,
    trialDays: 0,
    trialEndsAt: subscription.trialEndsAt ?? null,
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
  throwOnPartnerApiError = false,
}: {
  admin: AdminGraphqlClient;
  config: LystrConnectorConfig;
  request: Request;
  shopDomain: string;
  throwOnPartnerApiError?: boolean;
}) {
  const redirectPlanHandle = getPlanHandleFromRequest(request);

  try {
    const partnerSubscription = await getPartnerActiveSubscription({ admin });
    const activeSubscription = subscriptionFromPartnerActiveSubscription({
      config,
      shopDomain,
      subscription: partnerSubscription,
    });

    if (activeSubscription) {
      return activeSubscription;
    }
  } catch (error) {
    console.warn("Failed to query Shopify App Pricing subscription.", error);

    if (throwOnPartnerApiError) {
      throw error;
    }
  }

  if (redirectPlanHandle && isFreeAppPricingPlanHandle(redirectPlanHandle)) {
    return subscriptionFromPlanHandle({
      config,
      planHandle: redirectPlanHandle,
      shopDomain,
    });
  }

  return null;
}
