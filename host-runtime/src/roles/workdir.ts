import path from "node:path";
import { TaskFailed } from "../exec-types.js";

/**
 * Resolve a task workdir.
 *
 * Two shapes are allowed:
 *   - inside this attempt's workspace (the historical behavior);
 *   - inside a deployment-declared project root from BUILDER_PROJECT_ROOTS.
 *
 * The second shape is what makes role dispatch possible on a generic builder:
 * a builder mounts the project tree once (/work, /repo, /artifacts, ...) and
 * the operator-assigned role decides which subtree a task may use.
 */
export function resolveWorkdir(root: string, rel: string): string {
  if (!rel || rel === ".") return root;
  const base = path.resolve(root);
  // The admin app fills in the container workspace root by default (/opt/platform/workspace),
  // while the actual execution directory is workspace/<attempt_id>; map the root path to this attempt's directory.
  const workspaceRoot = path.dirname(base);
  const requested = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, rel);
  const abs =
    requested === workspaceRoot
      ? base
      : requested.startsWith(workspaceRoot + path.sep)
        ? path.resolve(base, path.relative(workspaceRoot, requested))
        : requested;
  // Same constraint as safeJoin, but the builder has full permissions, so only staying inside the workspace is required.
  // A deployment may also mount a per-role project work tree; BUILDER_PROJECT_ROOTS lists the
  // container paths that a task is allowed to use as a workdir (comma-separated).
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    const allowed = projectRoots().some((allowedRoot) => abs === allowedRoot || abs.startsWith(allowedRoot + path.sep));
    if (!allowed) {
      throw new TaskFailed("BUILD_WORKDIR_INVALID", `Workdir escapes the boundary: ${rel}`);
    }
  }
  return abs;
}

/** Container paths mounted from the host project tree that tasks may build in. */
export function projectRoots(): string[] {
  return (process.env.BUILDER_PROJECT_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

export function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
