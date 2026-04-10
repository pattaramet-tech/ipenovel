import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpLink, TRPCClientError, loggerLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import "./index.css";

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    
    // Improved error logging with proper serialization
    const errorDetails = {
      path: (error as any)?.data?.path,
      message: (error as any)?.message,
      input: (error as any)?.data?.input,
      code: (error as any)?.code,
      queryKey: event.query.queryKey,
    };
    
    console.error("[API Query Error]", JSON.stringify(errorDetails, null, 2));
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    
    // Improved error logging with proper serialization
    const errorDetails = {
      path: (error as any)?.data?.path,
      message: (error as any)?.message,
      input: (error as any)?.data?.input,
      code: (error as any)?.code,
    };
    
    console.error("[API Mutation Error]", JSON.stringify(errorDetails, null, 2));
  }
});

// Use Vite's import.meta.env.DEV for dev detection
const isDevelopment = import.meta.env.DEV;

const trpcClient = trpc.createClient({
  links: [
    // Logger link to debug TRPC requests (dev-only)
    ...(isDevelopment ? [loggerLink({
      enabled: () => true,
      colorMode: "ansi",
    })] : []),
    
    // Use httpLink for development to see individual requests, httpBatchLink for production
    isDevelopment
      ? httpLink({
          url: "/api/trpc",
          transformer: superjson,
          fetch(input, init) {
            return globalThis.fetch(input, {
              ...(init ?? {}),
              credentials: "include",
            });
          },
        })
      : httpBatchLink({
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
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
