import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

const LYSTR_STORES_URL = "https://lystr.ai/stores";

type ActionData =
  | { error: string; success?: never }
  | { success: true; error?: never };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findFirst({
    where: { shopDomain: session.shop },
  });

  return { connected: store?.connected ?? false };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

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

  const store = await prisma.store.findFirst({
    where: { apiKey },
  });

  if (!store) {
    return Response.json({ error: "Invalid API key." } satisfies ActionData,
      { status: 401 },
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

  await prisma.store.update({
    where: { id: store.id },
    data: {
      shopDomain: session.shop,
      accessToken: session.accessToken,
      connected: true,
    },
  });

  return Response.json({ success: true } satisfies ActionData);
};

export default function Index() {
  const { connected } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();

  const isConnected = connected || actionData?.success === true;

  return (
    <div style={{ minHeight: "90vh", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "6vh 1rem 2rem" }}>
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
          <img src="/lystrIcon.png" alt="Lystr" style={{ display: "block", width: "min(100%, 220px)", height: "auto" }}/>
        </div>

        {isConnected ? (
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "1rem" }}>
            <div className="lystr-connected-status">
              <span className="lystr-connected-dot" aria-hidden="true" />
              <s-text>Store connected successfully to Lystr-ai.</s-text>
            </div>
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
