import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  connectLystrStore,
  getLystrConnectorConfig,
  getLystrConnectorStatus,
} from "../lystr.server";
import {
  cancelCurrentAppPricingSubscription,
  cancelManualBillingSubscription,
  createManualBillingSubscription,
  getCurrentAppPricingSubscription,
  getCurrentShopifyBillingSubscription,
  getFreeShopifySubscription,
  getManualBillingReturnUrl,
  getAppPricingPlanSelectionUrl,
  isShopifyManualBillingEnabled,
} from "../shopify-app-pricing.server";
const PLAN_KEYS = ["free", "basic", "pro", "premium"] as const;
type BillingPlanKey = (typeof PLAN_KEYS)[number];
const PLAN_LABELS: Record<BillingPlanKey, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  premium: "Premium",
};

function isPlanKey(value: FormDataEntryValue | null): value is BillingPlanKey {
  return typeof value === "string" && PLAN_KEYS.includes(value as BillingPlanKey);
}

function formatPrice(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(value);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);

  if (!isShopifyManualBillingEnabled()) {
    throw redirect(getAppPricingPlanSelectionUrl(session.shop), { target: "_top" });
  }
  const { config } = await getLystrConnectorConfig();
  const currentSubscription = await getCurrentShopifyBillingSubscription({
    admin,
    config,
    request,
    shopDomain: session.shop,
  });
  const connectorStatus = await getLystrConnectorStatus({
    shopDomain: session.shop,
  }).catch(() => null);
  const connectorCancellationPending = Boolean(
    connectorStatus?.connector.accessAllowed &&
      connectorStatus.connector.status.trim().toUpperCase() === "CANCELED"
  );

  return {
    activePlanKey:
      currentSubscription?.planKey ?? connectorStatus?.connector.shopifyPlanKey ?? null,
    isCancellationPending:
      currentSubscription?.status?.trim().toUpperCase() === "CANCELLED" ||
      connectorCancellationPending,
    currency: config.currency,
    plans: PLAN_KEYS.map((planKey) => {
      const isFree = planKey === "free";

      return {
        credits: isFree ? 0 : Number(config.planCredits?.[planKey] ?? 0),
        key: planKey,
        label: PLAN_LABELS[planKey],
        price: isFree ? 0 : Number(config.planPrices?.[planKey] ?? 0),
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);

  if (!isShopifyManualBillingEnabled()) {
    return redirect(getAppPricingPlanSelectionUrl(session.shop), { target: "_top" });
  }
  const formData = await request.formData();
  const planKey = formData.get("planKey");

  if (!isPlanKey(planKey)) {
    return Response.json({ error: "Select a valid Lystr plan." }, { status: 400 });
  }

  try {
    const { config } = await getLystrConnectorConfig();
    const currentSubscription = await getCurrentShopifyBillingSubscription({
      admin,
      config,
      request,
      shopDomain: session.shop,
    });

    if (planKey === "free") {
      if (currentSubscription?.billingSource === "manual" && currentSubscription.id) {
        await cancelManualBillingSubscription({
          admin,
          subscriptionId: currentSubscription.id,
        });
      } else if (currentSubscription?.billingSource === "app_pricing") {
        await cancelCurrentAppPricingSubscription({ admin });
      }

      const localStore = await prisma.store.findFirst({
        where: { shopDomain: session.shop },
      });
      const freeSubscription = getFreeShopifySubscription(session.shop, config);

      if (!session.accessToken) {
        throw new Error("Shopify access token is missing for this store.");
      }

      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain: session.shop,
        shopifySubscription: freeSubscription,
      });

      return redirect("/app", { target: "_top" });
    }

    const legacySubscription = await getCurrentAppPricingSubscription({
      admin,
      config,
      request,
      shopDomain: session.shop,
    });
    const returnUrl = getManualBillingReturnUrl({
      cancelLegacySubscription: Boolean(legacySubscription),
      planKey,
    });
    const confirmationUrl = await createManualBillingSubscription({
      admin,
      config,
      planKey,
      returnUrl,
    });

    return redirect(confirmationUrl, { target: "_top" });
  } catch (error) {
    console.error("Failed to start Shopify billing.", error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Shopify could not start billing for this plan.",
      },
      { status: 400 }
    );
  }
};

export default function BillingPage() {
  const { activePlanKey, currency, isCancellationPending, plans } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string }>();

  return (
    <div
      style={{
        width: "100%",
        minHeight: "100%",
        overflowY: "auto",
        padding: "2rem 1.25rem",
        boxSizing: "border-box",
        background: "#fffefe",
        color: "#17191c",
      }}
    >
      <div style={{ width: "min(100%, 980px)", margin: "0 auto" }}>
        <h1 style={{ margin: 0, fontSize: "1.75rem", lineHeight: 1.2 }}>
          Choose your Lystr plan
        </h1>
        <p style={{ color: "#61666c", margin: "0.5rem 0 1.5rem" }}>
          Paid plans are billed every 30 days through Shopify.
        </p>
        {actionData?.error ? (
          <p
            role="alert"
            style={{
              padding: "0.75rem 1rem",
              border: "1px solid #e8a6a6",
              borderRadius: 6,
              color: "#8c1d18",
              background: "#fff4f4",
            }}
          >
            {actionData.error}
          </p>
        ) : null}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: "0.9rem",
          }}
        >
          {plans.map((plan) => {
            const isActive = activePlanKey === plan.key;
            const isReconnectPlan = isActive && isCancellationPending;
            const isConfigured = plan.key === "free" || plan.price > 0;
            const isDisabled = (isActive && !isReconnectPlan) || !isConfigured;

            return (
              <section
                key={plan.key}
                style={{
                  border: isActive ? "2px solid #f26a14" : "1px solid #d9dcdf",
                  borderRadius: 8,
                  padding: "1.1rem",
                  background: "#ffffff",
                  display: "grid",
                  gap: "0.75rem",
                  alignContent: "start",
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{plan.label}</h2>
                  <p style={{ margin: "0.35rem 0 0", color: "#61666c" }}>
                    {plan.price > 0
                      ? `${formatPrice(plan.price, currency)} every 30 days`
                      : "No recurring charge"}
                  </p>
                </div>
                <p style={{ margin: 0, minHeight: "2.5rem", color: "#373b3f" }}>
                  {plan.credits > 0
                    ? `${plan.credits.toLocaleString()} credits after each confirmed billing cycle`
                    : "Free access with no billing approval"}
                </p>
                <Form method="post">
                  <input type="hidden" name="planKey" value={plan.key} />
                  <button
                    type="submit"
                    disabled={isDisabled}
                    style={{
                      width: "100%",
                      minHeight: 40,
                      border: 0,
                      borderRadius: 6,
                      padding: "0.6rem 0.8rem",
                      color: isDisabled ? "#70757a" : "#ffffff",
                      background: isDisabled ? "#e8eaec" : "#17191c",
                      fontWeight: 700,
                      cursor: isDisabled ? "default" : "pointer",
                    }}
                  >
                    {isReconnectPlan
                      ? "Reconnect"
                      : isActive
                        ? "Current plan"
                        : isConfigured
                          ? "Select plan"
                          : "Not configured"}
                  </button>
                </Form>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
