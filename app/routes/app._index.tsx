import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  connectLystrStore,
  getLystrConnectorConfig,
  prepareLystrStoreConnection,
  syncLystrConnectorBilling,
  type LystrConnectorStatus,
} from "../lystr.server";
import {
  getAppPricingPlanSelectionUrl,
  getCurrentAppPricingSubscription,
} from "../shopify-app-pricing.server";

const LYSTR_STORES_URL = "https://lystr.ai/stores";

type ActionData =
  | { error: string; success?: never }
  | { success: true; error?: never };

function getConnectorMessage(status: string, remainingTrialDays: number) {
  switch (status) {
    case "TRIALING":
      return remainingTrialDays > 0
        ? `Free trial active. ${remainingTrialDays} day${remainingTrialDays === 1 ? "" : "s"} remaining.`
        : "Free trial active.";
    case "ACTIVE":
      return "Active Shopify connector subscription.";
    case "GRANDFATHERED":
      return "Existing installation is free during the migration period.";
    case "PAST_DUE":
      return "Payment failed. Shopify billing must be resolved before connector access resumes.";
    case "PAYMENT_REQUIRED":
      return "Payment approval is required before connector access resumes.";
    case "UNINSTALLED":
      return "Connector was uninstalled from this shop.";
    default:
      return "Shopify connector billing is not complete yet.";
  }
}

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const store = await prisma.store.findFirst({
    where: { shopDomain: session.shop },
  });
  const configResponse = await getLystrConnectorConfig();
  const activeSubscription = await getCurrentAppPricingSubscription({
    admin,
    config: configResponse.config,
    request,
    shopDomain: session.shop,
  });
  let connector: LystrConnectorStatus | null = null;

  if (store?.apiKey && session.accessToken) {
    if (activeSubscription) {
      const syncResult = await syncLystrConnectorBilling({
        shopDomain: session.shop,
        shopifySubscription: activeSubscription,
      });
      connector = syncResult.connector;

      if (syncResult.connector.accessAllowed) {
        await connectLystrStore({
          accessToken: session.accessToken,
          apiKey: store.apiKey,
          shopDomain: session.shop,
        });
        await prisma.store.update({
          where: { id: store.id },
          data: {
            accessToken: session.accessToken,
            connected: true,
          },
        });
      }
    }
  }

  return {
    appPricingUrl: getAppPricingPlanSelectionUrl(session.shop),
    config: configResponse.config,
    connected: Boolean(
      connector?.accessAllowed || (store?.connected && !connector)
    ),
    connector,
    hasPendingStore: Boolean(store?.apiKey),
    shopDomain: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const apiKeyValue = formData.get("apiKey");

  if (typeof apiKeyValue !== "string") {
    return Response.json(
      { error: "API key is required." } satisfies ActionData,
      {
        status: 400,
      },
    );
  }

  const apiKey = apiKeyValue.trim();

  if (!apiKey) {
    return Response.json(
      { error: "API key is required." } satisfies ActionData,
      {
        status: 400,
      },
    );
  }

  if (!session.shop) {
    return Response.json(
      { error: "No shop domain found for this session." } satisfies ActionData,
      { status: 400 },
    );
  }

  if (!session.accessToken) {
    return Response.json(
      { error: "No access token for this session." } satisfies ActionData,
      { status: 400 },
    );
  }

  const prepared = await prepareLystrStoreConnection({
    apiKey,
    shopDomain: session.shop,
  });
  const store = await prisma.store.update({
    where: { id: prepared.store.id },
    data: {
      shopDomain: session.shop,
      accessToken: session.accessToken,
      connected: false,
    },
  });
  const activeSubscription = await getCurrentAppPricingSubscription({
    admin,
    config: prepared.config,
    request,
    shopDomain: session.shop,
  });

  if (activeSubscription || prepared.config.monthlyPriceCents <= 0) {
    if (activeSubscription) {
      await syncLystrConnectorBilling({
        shopDomain: session.shop,
        shopifySubscription: activeSubscription,
      });
    }

    await connectLystrStore({
      accessToken: session.accessToken,
      apiKey,
      shopDomain: session.shop,
    });
    await prisma.store.update({
      where: { id: store.id },
      data: {
        connected: true,
      },
    });

    return Response.json({ success: true } satisfies ActionData);
  }

  if (prepared.connector.status === "GRANDFATHERED") {
    await connectLystrStore({
      accessToken: session.accessToken,
      apiKey,
      shopDomain: session.shop,
    });
    await prisma.store.update({
      where: { id: store.id },
      data: {
        connected: true,
      },
    });

    return Response.json({ success: true } satisfies ActionData);
  }

  return redirect(getAppPricingPlanSelectionUrl(session.shop), {
    target: "_top",
  });
};

export default function Index() {
  const { appPricingUrl, config, connected, connector, hasPendingStore } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();

  const isConnected = connected || actionData?.success === true;
  const status = connector?.status ?? (hasPendingStore ? "INCOMPLETE" : "");
  const statusMessage = connector
    ? getConnectorMessage(connector.status, connector.remainingTrialDays)
    : hasPendingStore
      ? "Approve Shopify billing to finish connecting this store."
      : "";

  return (
    <div style={{ flex: "1 1 auto", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "4vh 1rem 1rem", boxSizing: "border-box" }}>
      <style>
        {`
          @keyframes lystr-connected-pulse {
            0% {
              box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.38);
              transform: scale(1);
            }
            70% {
              box-shadow: 0 0 0 12px rgba(34, 197, 94, 0);
              transform: scale(1.04);
            }
            100% {
              box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
              transform: scale(1);
            }
          }

          .lystr-connected-status {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
          }

          .lystr-connected-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #22c55e;
            animation: lystr-connected-pulse 1.45s ease-out infinite;
            flex: 0 0 auto;
          }
        `}
      </style>
      <div style={{ width: "min(100%, 760px)", display: "flex", flexDirection: "column", alignItems: "stretch", gap: "1rem" }}>

        <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
          <img src="/lystrIcon.png" alt="Lystr Connect" style={{ display: "block", width: "min(100%, 220px)", height: "auto" }}/>
        </div>

        {isConnected ? (
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "1rem" }}>
            <div className="lystr-connected-status">
              <span className="lystr-connected-dot" aria-hidden="true" />
              <s-text>Store connected successfully to Lystr Connect.</s-text>
            </div>
            <s-text>{statusMessage}</s-text>
            <s-button
              href={LYSTR_STORES_URL}
              target="_blank"
              variant="primary"
              icon="external"
            >
              Redirect
            </s-button>
          </div>
        ) : (

          <Form method="post">
            <s-section>
              <s-text>
                Store creation in Lystr is free. The Shopify App Connector is billed per Shopify store at {formatMoney(config.monthlyPrice, config.currency)} every 30 days after a {config.freeTrialDays}-day trial. Successful connector payments add {config.creditsPerSuccessfulPayment} Lystr credits.
              </s-text>
              {status ? <s-text>{statusMessage}</s-text> : null}
              <s-text-field
                name="apiKey"
                label="Enter your API key"
                placeholder="API key"
                required
                error={actionData && "error" in actionData ? actionData.error : undefined}
              />

              <s-button type="submit" inlineSize="fill" variant="primary">
                Connect Store
              </s-button>
              {hasPendingStore ? (
                <s-button href={appPricingUrl} target="_top" inlineSize="fill">
                  Open Shopify pricing
                </s-button>
              ) : null}
            </s-section>
          </Form>
        )}
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
