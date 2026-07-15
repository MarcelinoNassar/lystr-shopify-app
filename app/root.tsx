import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

const APP_FONT =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export default function App() {
  return (
    <html
      lang="en"
      style={{
        height: "100%",
        width: "100%",
        overflow: "hidden",
        background: "#fffefe",
        fontFamily: APP_FONT,
      }}
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body
        style={{
          height: "100%",
          width: "100%",
          margin: 0,
          overflow: "hidden",
          background: "#fffefe",
          fontFamily: APP_FONT,
        }}
      >
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
