import React from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import WorkspacePage from "./WorkspacePage";
import AuthorWorkspacePage from "./AuthorWorkspacePage";

/** Do not alter the existing admin Workspace component or its authority. */
export default function WorkspaceRoutePage() {
  const { user, loading } = useAuth();
  if (loading) return <main className="p-6">Loading Workspace…</main>;
  return user?.role === "author"
    ? <AuthorWorkspacePage />
    : <WorkspacePage />;
}
