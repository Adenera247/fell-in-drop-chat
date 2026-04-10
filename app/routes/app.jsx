import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncShopKnowledge } from "../services/shop-sync.server";

const SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Fire-and-forget: trigger a shop knowledge sync on first load (or when
  // the last successful sync is older than 7 days). This runs in the
  // background so it never blocks the embed render.
  if (session?.shop) {
    prisma.shopSyncState
      .findUnique({ where: { shop: session.shop } })
      .then((state) => {
        const needsSync =
          !state ||
          state.syncStatus === "failed" ||
          !state.lastSyncedAt ||
          Date.now() - state.lastSyncedAt.getTime() > SYNC_MAX_AGE_MS;
        if (needsSync) {
          syncShopKnowledge(admin, session.shop).catch((err) =>
            console.error(`[app.jsx] background sync failed for ${session.shop}:`, err)
          );
        }
      })
      .catch((err) =>
        console.error(`[app.jsx] shopSyncState lookup failed for ${session.shop}:`, err)
      );
  }

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
