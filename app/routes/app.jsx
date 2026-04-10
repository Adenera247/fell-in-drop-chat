import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { syncShopKnowledge } from "../services/shop-sync.server";

const SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Fire-and-forget background sync. Uses unauthenticated.admin(shop) which
 * reads the stored offline token from Prisma session storage — this client
 * works outside the request lifecycle, unlike the admin client returned by
 * authenticate.admin(request) which throws a 302 when the caller is no
 * longer in the request context.
 */
async function triggerBackgroundSync(shop) {
  try {
    const state = await prisma.shopSyncState.findUnique({ where: { shop } });
    const needsSync =
      !state ||
      state.syncStatus === "failed" ||
      !state.lastSyncedAt ||
      Date.now() - state.lastSyncedAt.getTime() > SYNC_MAX_AGE_MS;
    if (!needsSync) return;

    const { admin } = await unauthenticated.admin(shop);
    await syncShopKnowledge(admin, shop);
  } catch (err) {
    console.error(`[app.jsx] background sync failed for ${shop}:`, err.message || err);
  }
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // Fire-and-forget: trigger a shop knowledge sync on first load (or when
  // the last successful sync is older than 7 days). Runs in the background
  // so it never blocks the embed render.
  if (session?.shop) {
    triggerBackgroundSync(session.shop);
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
