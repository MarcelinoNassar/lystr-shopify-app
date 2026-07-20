import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getLystrConnectorConfig,
  syncLystrConnectorBilling,
} from "../lystr.server";
import { getCurrentShopifyBillingSubscription } from "../shopify-app-pricing.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, topic, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    return new Response();
  }

  try {
    const configResponse = await getLystrConnectorConfig();
    const activeSubscription = await getCurrentShopifyBillingSubscription({
      admin,
      config: configResponse.config,
      request,
      shopDomain: shop,
      throwOnPartnerApiError: true,
    });

    await syncLystrConnectorBilling({
      shopDomain: shop,
      shopifySubscription: activeSubscription,
      shopifyWebhookId: webhookId,
    });
  } catch (error) {
    console.error("Failed to sync Lystr Shopify subscription update.", error);
  }

  return new Response();
};
