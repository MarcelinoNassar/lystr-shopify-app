import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/app-billing.module.css";
import {
  connectLystrStore,
  getLystrConnectorConfig,
  getLystrConnectorStatus,
  updateLystrConnectorPlanTransition,
  type LystrConnectorStatus,
  type ShopifySubscriptionForLystr,
} from "../lystr.server";
import {
  cancelManualBillingSubscription,
  createManualBillingSubscription,
  getAppPricingPlanSelectionUrl,
  getCurrentShopifyBillingSubscription,
  getFreeShopifySubscription,
  getManualBillingReturnUrl,
  getShopifyBillingSubscriptionById,
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
  return (
    typeof value === "string" && PLAN_KEYS.includes(value as BillingPlanKey)
  );
}

function formatPrice(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value?: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function getSubscriptionPrice(
  subscription?: ShopifySubscriptionForLystr | null,
) {
  const amount = Number(
    subscription?.lineItems?.[0]?.plan?.pricingDetails?.price?.amount,
  );

  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function getSubscriptionEnd(
  subscription: ShopifySubscriptionForLystr | null,
  connector: LystrConnectorStatus | null,
) {
  return subscription?.currentPeriodEnd ?? connector?.nextBillingDate ?? null;
}

function hasRemainingPaidAccess({
  connector,
  currentPlanKey,
  subscription,
}: {
  connector: LystrConnectorStatus | null;
  currentPlanKey: string | null;
  subscription: ShopifySubscriptionForLystr | null;
}) {
  if (!currentPlanKey || currentPlanKey === "free") {
    return false;
  }

  const status = (
    subscription?.status ??
    connector?.shopifySubscriptionStatus ??
    connector?.status
  )
    ?.trim()
    .toUpperCase();
  const periodEnd = getSubscriptionEnd(subscription, connector);
  const periodEndDate = periodEnd ? new Date(periodEnd) : null;

  return Boolean(
    connector?.accessAllowed &&
    status !== "FROZEN" &&
    status !== "DECLINED" &&
    status !== "EXPIRED" &&
    periodEndDate &&
    !Number.isNaN(periodEndDate.getTime()) &&
    periodEndDate.getTime() > Date.now(),
  );
}

async function getVerifiedCurrentSubscription({
  admin,
  connector,
  currentSubscription,
}: {
  admin: Parameters<typeof getShopifyBillingSubscriptionById>[0]["admin"];
  connector: LystrConnectorStatus | null;
  currentSubscription: ShopifySubscriptionForLystr | null;
}) {
  const storedSubscriptionId = connector?.shopifySubscriptionId?.trim();
  const storedPlanKey = connector?.shopifyPlanKey as
    | BillingPlanKey
    | null
    | undefined;

  if (
    storedSubscriptionId &&
    (!currentSubscription ||
      currentSubscription.id !== storedSubscriptionId ||
      currentSubscription.planKey !== storedPlanKey)
  ) {
    const storedSubscription = await getShopifyBillingSubscriptionById({
      admin,
      planKey: storedPlanKey ?? null,
      subscriptionId: storedSubscriptionId,
    }).catch((error) => {
      console.warn("Failed to verify the stored Shopify subscription.", error);
      return null;
    });

    if (storedSubscription) {
      return storedSubscription;
    }
  }

  return currentSubscription;
}

async function loadBillingState({
  accessToken,
  admin,
  request,
  shopDomain,
}: {
  accessToken?: string | null;
  admin: Parameters<typeof getCurrentShopifyBillingSubscription>[0]["admin"];
  request: Request;
  shopDomain: string;
}) {
  const [{ config }, statusResponse] = await Promise.all([
    getLystrConnectorConfig(),
    getLystrConnectorStatus({ shopDomain }).catch(() => null),
  ]);
  let connector = statusResponse?.connector ?? null;
  let currentSubscription = await getCurrentShopifyBillingSubscription({
    admin,
    config,
    request,
    shopDomain,
  });

  if (
    connector?.pendingShopifyPlanStatus === "APPROVED" &&
    connector.pendingShopifyPlanActivatesAt &&
    new Date(connector.pendingShopifyPlanActivatesAt).getTime() <= Date.now() &&
    (!connector.reconnectRequired ||
      new URL(request.url).searchParams.get("billing_return") === "1") &&
    currentSubscription?.planKey === connector.pendingShopifyPlanKey
  ) {
    const localStore = await prisma.store.findFirst({
      where: { shopDomain },
    });

    if (accessToken && connector?.storeId) {
      const result = await connectLystrStore({
        accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain,
        shopifySubscription: currentSubscription,
      }).catch(() => null);

      if (result?.connector) {
        connector = result.connector;
      }
    }
  }

  currentSubscription = await getVerifiedCurrentSubscription({
    admin,
    connector,
    currentSubscription,
  });

  return { config, connector, currentSubscription };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);

  if (!isShopifyManualBillingEnabled()) {
    throw redirect(getAppPricingPlanSelectionUrl(session.shop), {
      target: "_top",
    });
  }

  const { config, connector, currentSubscription } = await loadBillingState({
    accessToken: session.accessToken,
    admin,
    request,
    shopDomain: session.shop,
  });
  const currentPlanKey =
    (connector?.shopifyPlanKey as BillingPlanKey | null | undefined) ??
    (currentSubscription?.planKey as BillingPlanKey | null | undefined) ??
    null;
  const currentSubscriptionPrice =
    getSubscriptionPrice(currentSubscription) ||
    Number(connector?.monthlyPrice ?? 0);
  const remainingPaidAccess = hasRemainingPaidAccess({
    connector,
    currentPlanKey,
    subscription: currentSubscription,
  });
  const currentPeriodEnd = getSubscriptionEnd(currentSubscription, connector);
  const url = new URL(request.url);
  const reconnectRequested = url.searchParams.get("reconnect") === "1";

  if (
    connector?.reconnectRequired === true &&
    remainingPaidAccess &&
    !reconnectRequested
  ) {
    url.searchParams.set("reconnect", "1");
    throw redirect(`${url.pathname}${url.search}`);
  }

  return {
    currency: config.currency,
    currentPeriodEnd,
    currentPlanKey,
    currentPlanName: currentPlanKey ? PLAN_LABELS[currentPlanKey] : null,
    isReconnectMode:
      reconnectRequested ||
      (connector?.reconnectRequired === true && remainingPaidAccess),
    remainingPaidAccess,
    pendingPlanKey:
      (connector?.pendingShopifyPlanKey as BillingPlanKey | null | undefined) ??
      null,
    pendingPlanName: connector?.pendingShopifyPlanName ?? null,
    pendingPlanStatus: connector?.pendingShopifyPlanStatus ?? null,
    pendingPlanActivatesAt: connector?.pendingShopifyPlanActivatesAt ?? null,
    plans: PLAN_KEYS.map((planKey) => {
      const isFree = planKey === "free";
      const configuredPrice = isFree
        ? 0
        : Number(config.planPrices?.[planKey] ?? 0);
      const displayPrice =
        planKey === currentPlanKey && configuredPrice <= 0
          ? currentSubscriptionPrice
          : configuredPrice;

      return {
        credits: isFree ? 0 : Number(config.planCredits?.[planKey] ?? 0),
        isConfigured: isFree || configuredPrice > 0,
        key: planKey,
        label: PLAN_LABELS[planKey],
        price: displayPrice,
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);

  if (!isShopifyManualBillingEnabled()) {
    return redirect(getAppPricingPlanSelectionUrl(session.shop), {
      target: "_top",
    });
  }

  const formData = await request.formData();
  const planKey = formData.get("planKey");

  if (!isPlanKey(planKey)) {
    return Response.json(
      { error: "Select a valid Lystr plan." },
      { status: 400 },
    );
  }

  try {
    const { config, connector, currentSubscription } = await loadBillingState({
      accessToken: session.accessToken,
      admin,
      request,
      shopDomain: session.shop,
    });
    const localStore = await prisma.store.findFirst({
      where: { shopDomain: session.shop },
    });

    if (!session.accessToken || !connector?.storeId) {
      throw new Error("The Shopify store connection could not be verified.");
    }

    const currentPlanKey =
      (connector?.shopifyPlanKey as BillingPlanKey | null | undefined) ??
      (currentSubscription?.planKey as BillingPlanKey | null | undefined) ??
      null;
    const remainingPaidAccess = hasRemainingPaidAccess({
      connector,
      currentPlanKey,
      subscription: currentSubscription,
    });
    const currentPeriodEnd = getSubscriptionEnd(currentSubscription, connector);

    if (connector?.pendingShopifySubscriptionId) {
      const pendingSubscription = await getShopifyBillingSubscriptionById({
        admin,
        planKey:
          (connector.pendingShopifyPlanKey as
            | BillingPlanKey
            | null
            | undefined) ?? null,
        subscriptionId: connector.pendingShopifySubscriptionId,
      }).catch(() => null);
      const pendingStatus = pendingSubscription?.status?.trim().toUpperCase();

      if (!pendingSubscription) {
        throw new Error(
          "Lystr could not verify the pending Shopify subscription, so no duplicate charge was created. Reload and try again.",
        );
      }

      if (pendingStatus === "PENDING") {
        throw new Error(
          "A Shopify plan approval is already pending. Complete or decline that approval before starting another plan change.",
        );
      }

      if (pendingStatus === "ACTIVE" || pendingStatus === "ACCEPTED") {
        await connectLystrStore({
          accessToken: session.accessToken,
          apiKey: localStore?.apiKey ?? undefined,
          shopDomain: session.shop,
          shopifySubscription: pendingSubscription,
        });

        return redirect("/app/billing?reconnect=1");
      }

      if (pendingSubscription && pendingStatus) {
        await updateLystrConnectorPlanTransition({
          action: "clear",
          shopDomain: session.shop,
        });
      }
    }

    if (remainingPaidAccess && !currentSubscription) {
      throw new Error(
        "Lystr could not verify the existing Shopify subscription, so no new charge was created. Reload and try again.",
      );
    }

    if (
      remainingPaidAccess &&
      currentSubscription &&
      planKey === currentPlanKey
    ) {
      await updateLystrConnectorPlanTransition({
        action: "clear",
        shopDomain: session.shop,
      });
      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain: session.shop,
        shopifySubscription: currentSubscription,
      });

      return redirect("/app");
    }

    if (remainingPaidAccess && currentSubscription && currentPeriodEnd) {
      if (planKey === "free") {
        if (
          currentSubscription.billingSource === "manual" &&
          currentSubscription.status?.trim().toUpperCase() === "ACTIVE" &&
          currentSubscription.id
        ) {
          await cancelManualBillingSubscription({
            admin,
            subscriptionId: currentSubscription.id,
          });
        }

        await updateLystrConnectorPlanTransition({
          action: "schedule",
          activatesAt: currentPeriodEnd,
          planKey,
          shopDomain: session.shop,
          status: "SCHEDULED",
        });
        await connectLystrStore({
          accessToken: session.accessToken,
          apiKey: localStore?.apiKey ?? undefined,
          shopDomain: session.shop,
          shopifySubscription: {
            ...currentSubscription,
            status:
              currentSubscription.status?.trim().toUpperCase() === "ACTIVE"
                ? "CANCELLED"
                : currentSubscription.status,
          },
        });

        return redirect("/app/billing?reconnect=1&scheduled=1");
      }

      const price = Number(config.planPrices?.[planKey] ?? 0);

      const canDeferWithShopify =
        currentSubscription.billingSource === "manual" &&
        currentSubscription.status?.trim().toUpperCase() === "ACTIVE" &&
        Number.isFinite(price) &&
        price > 0;

      if (canDeferWithShopify) {
        const returnUrl = getManualBillingReturnUrl({
          cancelLegacySubscription: false,
          deferredPlanChange: true,
          planKey,
        });
        const pending = await createManualBillingSubscription({
          admin,
          config,
          planKey,
          replacementBehavior: "APPLY_ON_NEXT_BILLING_CYCLE",
          returnUrl,
        });

        await updateLystrConnectorPlanTransition({
          action: "schedule",
          activatesAt: currentPeriodEnd,
          pendingSubscriptionId: pending.subscriptionId,
          planKey,
          shopDomain: session.shop,
          status: "PENDING_APPROVAL",
        });

        return redirect(pending.confirmationUrl, { target: "_top" });
      }

      await updateLystrConnectorPlanTransition({
        action: "schedule",
        activatesAt: currentPeriodEnd,
        planKey,
        shopDomain: session.shop,
        status: "SCHEDULED",
      });
      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain: session.shop,
        shopifySubscription: currentSubscription,
      });

      return redirect("/app/billing?reconnect=1&scheduled=1");
    }

    if (planKey === "free") {
      await updateLystrConnectorPlanTransition({
        action: "clear",
        shopDomain: session.shop,
      });
      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain: session.shop,
        shopifySubscription: getFreeShopifySubscription(session.shop, config),
      });

      return redirect("/app");
    }

    const price = Number(config.planPrices?.[planKey] ?? 0);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(
        `${PLAN_LABELS[planKey]} billing price is not configured in Lystr.`,
      );
    }

    const returnUrl = getManualBillingReturnUrl({
      cancelLegacySubscription:
        currentSubscription?.billingSource === "app_pricing",
      planKey,
    });
    const pending = await createManualBillingSubscription({
      admin,
      config,
      planKey,
      replacementBehavior: "APPLY_IMMEDIATELY",
      returnUrl,
    });

    await updateLystrConnectorPlanTransition({
      action: "schedule",
      activatesAt: new Date().toISOString(),
      pendingSubscriptionId: pending.subscriptionId,
      planKey,
      shopDomain: session.shop,
      status: "PENDING_APPROVAL",
    });

    return redirect(pending.confirmationUrl, { target: "_top" });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("Failed to process Shopify billing selection.", error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Shopify could not process this billing selection.",
      },
      { status: 400 },
    );
  }
};

function PlanIcon({ planKey }: { planKey: BillingPlanKey }) {
  const paths: Record<BillingPlanKey, JSX.Element> = {
    free: (
      <>
        <path d="M20 12v9H4v-9" />
        <path d="M2 7h20v5H2z" />
        <path d="M12 7v14M12 7H7.5a2.5 2.5 0 1 1 2.1-3.85L12 7Zm0 0h4.5a2.5 2.5 0 1 0-2.1-3.85L12 7Z" />
      </>
    ),
    basic: (
      <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2l-5-4.9 6.9-1L12 2Z" />
    ),
    pro: (
      <>
        <path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z" />
        <path d="M5 19h14" />
      </>
    ),
    premium: (
      <>
        <path d="m12 2 4 5h5l-9 15L3 7h5l4-5Z" />
        <path d="M8 7h8l-4 15L8 7Z" />
      </>
    ),
  };

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[planKey]}
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 2v3M17 2v3M3 9h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z" />
      <path d="m9 15 2 2 4-4" />
    </svg>
  );
}

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string }>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submittingPlanKey = navigation.formData?.get("planKey");
  const isSubmitting = navigation.state === "submitting";
  const isProcessing =
    navigation.state !== "idle" && isPlanKey(submittingPlanKey ?? null);
  const isReconnecting = Boolean(
    data.isReconnectMode && submittingPlanKey === data.currentPlanKey,
  );
  const currentEndLabel = formatDate(data.currentPeriodEnd);
  const pendingStartLabel = formatDate(data.pendingPlanActivatesAt);

  useEffect(() => {
    const refreshConfiguredPricing = () => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      ) {
        void revalidator.revalidate();
      }
    };

    window.addEventListener("focus", refreshConfiguredPricing);
    document.addEventListener("visibilitychange", refreshConfiguredPricing);

    return () => {
      window.removeEventListener("focus", refreshConfiguredPricing);
      document.removeEventListener(
        "visibilitychange",
        refreshConfiguredPricing,
      );
    };
  }, [revalidator]);

  if (isProcessing) {
    return (
      <main className={`${styles.page} ${styles.loadingPage}`} aria-busy="true">
        <section
          className={styles.loadingState}
          role="status"
          aria-live="polite"
        >
          <span className={styles.loadingSpinner} aria-hidden="true" />
          <h1>
            {isReconnecting
              ? "Reconnecting your store..."
              : "Processing your plan..."}
          </h1>
          <p>Please wait while Lystr confirms your billing and connection.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Choose your Lystr plan</h1>
          <p>
            Paid plans are billed every <strong>30 days</strong> through
            Shopify.
          </p>
        </div>
        <details className={styles.infoDetails}>
          <summary className={styles.infoButton}>
            <span aria-hidden="true">i</span>
            How billing works
          </summary>
          <div className={styles.infoPanel}>
            Shopify confirms every paid plan. Reconnecting an existing
            paid-through plan creates no new charge or credit reward.
          </div>
        </details>
      </header>

      {data.remainingPaidAccess && data.currentPlanName ? (
        <section
          className={styles.transitionSummary}
          aria-label="Current billing state"
        >
          <div>
            <span>Current plan</span>
            <strong>{data.currentPlanName}</strong>
          </div>
          <div>
            <span>Active until</span>
            <strong>{currentEndLabel ?? "Current billing-period end"}</strong>
          </div>
          {data.pendingPlanName ? (
            <div>
              <span>Next plan</span>
              <strong>{data.pendingPlanName}</strong>
              <small>
                Starts{" "}
                {pendingStartLabel
                  ? `after ${pendingStartLabel}`
                  : "after the current period"}
              </small>
            </div>
          ) : null}
        </section>
      ) : null}

      {actionData?.error ? (
        <p className={styles.error} role="alert">
          {actionData.error}
        </p>
      ) : null}

      <section className={styles.planGrid} aria-label="Lystr billing plans">
        {data.plans.map((plan) => {
          const isCurrent = data.currentPlanKey === plan.key;
          const isPending = data.pendingPlanKey === plan.key;
          const reconnectSamePlan =
            data.isReconnectMode && data.remainingPaidAccess && isCurrent;
          const currentWithoutReconnect =
            isCurrent && !data.isReconnectMode && data.remainingPaidAccess;
          const switchAfterPeriod = data.remainingPaidAccess && !isCurrent;
          const requiresNewCharge =
            plan.key !== "free" && !reconnectSamePlan && !switchAfterPeriod;
          const isDisabled =
            isSubmitting ||
            currentWithoutReconnect ||
            (requiresNewCharge && !plan.isConfigured);
          const buttonLabel =
            isSubmitting && submittingPlanKey === plan.key
              ? "Processing..."
              : reconnectSamePlan
                ? "Reconnect"
                : currentWithoutReconnect
                  ? "Current plan"
                  : switchAfterPeriod
                    ? "Switch after current period"
                    : plan.key === "free"
                      ? "Select plan"
                      : !plan.isConfigured
                        ? "Not configured"
                        : "Approve payment";

          return (
            <article
              className={`${styles.planCard} ${isCurrent ? styles.currentCard : ""}`}
              key={plan.key}
            >
              <div className={styles.cardTopline}>
                <span className={styles.planIcon}>
                  <PlanIcon planKey={plan.key} />
                </span>
                {plan.key === "basic" ? (
                  <span className={styles.recommended}>Recommended</span>
                ) : null}
              </div>
              <div>
                <h2>{plan.label}</h2>
                {plan.key === "free" ? (
                  <p className={styles.freePrice}>No recurring charge</p>
                ) : plan.isConfigured ? (
                  <p className={styles.price}>
                    <strong>{formatPrice(plan.price, data.currency)}</strong>
                    <span> every 30 days</span>
                  </p>
                ) : (
                  <p className={styles.unconfiguredPrice}>
                    Billing price not configured
                  </p>
                )}
              </div>
              <div className={styles.divider} />
              <p className={styles.credits}>
                {plan.credits > 0
                  ? `${plan.credits.toLocaleString()} credits after each confirmed billing cycle`
                  : "Free access with no billing approval"}
              </p>
              {plan.key !== "free" ? (
                <div className={styles.expiryNote}>
                  <CalendarIcon />
                  <span>Credits expire after 12 months</span>
                </div>
              ) : (
                <div className={styles.expirySpacer} />
              )}
              <p className={styles.pendingNote}>
                {isPending
                  ? data.pendingPlanStatus === "APPROVED"
                    ? "Approved for the next billing period"
                    : "Scheduled for the next billing period"
                  : "\u00a0"}
              </p>
              <Form method="post">
                <input type="hidden" name="planKey" value={plan.key} />
                <button
                  className={`${styles.planButton} ${reconnectSamePlan ? styles.reconnectButton : ""}`}
                  disabled={isDisabled}
                  type="submit"
                >
                  {buttonLabel}
                </button>
              </Form>
            </article>
          );
        })}
      </section>

      <aside className={styles.creditNotice}>
        <span className={styles.noticeIcon}>
          <CalendarIcon />
        </span>
        <div>
          <strong>
            Credits expire after 12 months from the date they are earned.
          </strong>
          <p>
            When you use credits, they are deducted from the oldest credits
            first.
          </p>
        </div>
      </aside>
    </main>
  );
}
