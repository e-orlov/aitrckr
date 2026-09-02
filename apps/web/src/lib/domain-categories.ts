// Re-export of the shared citation taxonomy, which moved to @workspace/lib so
// the worker can evaluate domain-level classification too. Kept at this path so
// web imports (and future upstream merges touching them) stay unchanged.
export * from "@workspace/lib/citations/domain-categories";
