import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <style>
        {`
          .lystr-footer s-link {
            color: #6d7175;
            font-size: 0.75rem;
            line-height: 1rem;
            --pc-link-color: #6d7175;
            --p-color-text-link: #6d7175;
            --p-color-text-link-hover: #4a4a4a;
            --p-color-text-link-active: #4a4a4a;
          }

          .lystr-footer s-link:hover {
            color: #4a4a4a;
            --pc-link-color: #4a4a4a;
            --p-color-text-link: #4a4a4a;
          }
        `}
      </style>
      <div
        style={{
          height: "100dvh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <s-app-nav>
          <s-link href="/app">Connect Store</s-link>
        </s-app-nav>
        <main
          style={{
            flex: "1 1 auto",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <Outlet />
        </main>
        <footer
          className="lystr-footer"
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "0.5rem 1rem 0.75rem",
            color: "#6d7175",
            fontSize: "0.75rem",
            lineHeight: "1rem",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <s-link
              href="https://lystr.ai/privacy-policy"
              target="_blank"
              tone="neutral"
            >
              <span style={{ color: "#6d7175", fontSize: "0.75rem" }}>
                Privacy Policy
              </span>
            </s-link>
            <s-text color="subdued" tone="neutral">
              |
            </s-text>
            <s-link
              href="https://lystr.ai/terms-of-service"
              tone="neutral"
            >
              <span style={{ color: "#6d7175", fontSize: "0.75rem" }}>
                Terms of Service
              </span>
            </s-link>
          </div>
        </footer>
      </div>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
