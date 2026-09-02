// Re-export of the shared server-only domain classifier, which moved to
// @workspace/lib so the worker can evaluate domain-level classification too.
// Still server-only: importing it from a client module would bloat the browser
// bundle with the ~25k-entry editorial set.
export * from "@workspace/lib/citations/domain-categories.server";
