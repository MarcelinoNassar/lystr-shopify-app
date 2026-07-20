import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncLystrCreditTopUp } from "../lystr.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, webhookId } = await authenticate.webhook(request);
  const purchase = (payload as {
    app_purchase_one_time?: {
      admin_graphql_api_id?: string | null;
    } | null;
  })?.app_purchase_one_time;
  const shopifyPurchaseId = purchase?.admin_graphql_api_id?.trim() ?? "";

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!shopifyPurchaseId) {
    return new Response();
  }

  await syncLystrCreditTopUp({
    shopDomain: shop,
    shopifyPurchaseId,
    shopifyWebhookId: webhookId,
  }).catch((error) => {
    console.error("Failed to sync Lystr Shopify credit top-up.", error);
  });

  return new Response();
};
