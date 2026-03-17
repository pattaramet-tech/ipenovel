import { TRPCClientError } from "@trpc/client";

/**
 * Hook for displaying error messages to users
 * Extracts meaningful error messages from tRPC errors
 */
export function useErrorHandler() {
  const handleError = (error: unknown, fallbackMessage: string = "Something went wrong") => {
    let errorMessage = fallbackMessage;

    // Handle tRPC errors
    if (error instanceof TRPCClientError) {
      // Use the error message from the server if available
      if (error.message) {
        errorMessage = error.message;
      } else if (error.data?.code === "UNAUTHORIZED") {
        errorMessage = "Please log in to continue";
      } else if (error.data?.code === "FORBIDDEN") {
        errorMessage = "You don't have permission to perform this action";
      } else if (error.data?.code === "NOT_FOUND") {
        errorMessage = "The item you're looking for was not found";
      } else if (error.data?.code === "CONFLICT") {
        errorMessage = error.message || "This item already exists";
      } else if (error.data?.code === "BAD_REQUEST") {
        errorMessage = error.message || "Invalid request. Please check your input.";
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    // Log error for debugging
    console.error("[ERROR]", errorMessage, error);

    return errorMessage;
  };

  return { handleError };
}

/**
 * Extract user-friendly error message from tRPC error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof TRPCClientError) {
    if (error.message) return error.message;
    if (error.data?.code === "UNAUTHORIZED") return "Please log in to continue";
    if (error.data?.code === "FORBIDDEN") return "You don't have permission";
    if (error.data?.code === "NOT_FOUND") return "Item not found";
    if (error.data?.code === "CONFLICT") return error.message || "This item already exists";
    if (error.data?.code === "BAD_REQUEST") return error.message || "Invalid request";
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
