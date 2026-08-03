import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import { redirectToLoginIfUnauthorized } from "@/_core/hooks/globalUnauthorizedRedirect";
import { LanguageProvider } from "@/contexts/LanguageContext";
import "./index.css";

const queryClient = new QueryClient();

// Path-aware - see globalUnauthorizedRedirect.ts / unauthorizedRedirect.ts's
// docstrings, the same rule useAuth.ts's redirectOnUnauthenticated effect
// and AdminLayout.tsx use. A UNAUTHORIZED call on /admin/* (expired/missing
// session - there is no more separate local admin login, see
// security/remove-local-admin-password-login) returns to the literal
// /login page, not the dynamic OAuth flow; every other route keeps going to
// OAuth, unchanged. FORBIDDEN and any other error never redirect at all.
// getLoginUrl() is only ever invoked for the "oauth" target - never
// unconditionally.
const handleQueryOrMutationError = (error: unknown) => {
  if (typeof window === "undefined") return;
  redirectToLoginIfUnauthorized(
    error,
    window.location.pathname,
    (url) => {
      window.location.href = url;
    },
    getLoginUrl
  );
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    handleQueryOrMutationError(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    handleQueryOrMutationError(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </QueryClientProvider>
  </trpc.Provider>
);
