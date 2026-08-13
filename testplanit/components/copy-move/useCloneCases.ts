"use client";

import { useCallback, useRef, useState } from "react";
import type { CopyMoveJobResult } from "~/workers/copyMoveWorker";

/**
 * One-click cloning of test cases.
 *
 * A clone is a within-project copy: same project, same folder, names
 * disambiguated with a "(copy)" suffix. That is exactly what the copy-move
 * pipeline already does — including the RepositoryCaseLink(DUPLICATED_FROM)
 * provenance row and the DUPLICATED audit event it writes when source and
 * target project match — so this hook drives the same endpoints instead of
 * introducing a second deep-copy implementation. (Those two names come from
 * the persisted schema enums and stay as they are; the feature is "clone".)
 *
 * Unlike {@link useCopyMoveJob}, which exposes the job as wizard state, this
 * hook resolves a promise when the job settles so callers can wrap it in a
 * toast and refresh their list.
 */

const POLL_INTERVAL_MS = 750;
/** 750ms * 160 = 2 minutes — generous for the 1..N cases this action sends. */
const MAX_POLL_ATTEMPTS = 160;

export interface CloneCasesArgs {
  /** Cases to clone. They must all live in `folderId`. */
  caseIds: number[];
  projectId: number;
  folderId: number;
  /** Skips a lookup on the server when known (rows carry it). */
  repositoryId?: number;
}

export interface UseCloneCasesReturn {
  /**
   * Resolves with the finished job result. Rejects with a user-presentable
   * message when the submit is refused (403 / 503 queue down) or the job fails.
   */
  clone: (args: CloneCasesArgs) => Promise<CopyMoveJobResult>;
  isCloning: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useCloneCases(): UseCloneCasesReturn {
  const [isCloning, setIsCloning] = useState(false);
  // Guards against a second click landing while the first job is still in
  // flight (the menu item stays mounted while the toast is up).
  const inFlightRef = useRef(false);

  const clone = useCallback(async (args: CloneCasesArgs) => {
    if (inFlightRef.current) {
      throw new Error("A clone is already in progress");
    }
    inFlightRef.current = true;
    setIsCloning(true);

    try {
      const submitRes = await fetch("/api/repository/copy-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "copy",
          caseIds: args.caseIds,
          sourceProjectId: args.projectId,
          targetProjectId: args.projectId,
          targetFolderId: args.folderId,
          targetRepositoryId: args.repositoryId,
          // "rename" (never "skip"): a clone always collides with its own
          // source, so skipping would make the action silently do nothing.
          conflictResolution: "rename",
          // Shared step groups stay shared — a clone that forked them would
          // quietly detach the copy from later edits to the group.
          sharedStepGroupResolution: "reuse",
        }),
      });

      if (!submitRes.ok) {
        const data = await submitRes.json().catch(() => ({}));
        throw new Error(data.error || `Clone failed (${submitRes.status})`);
      }

      const { jobId } = await submitRes.json();

      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_INTERVAL_MS);

        const statusRes = await fetch(
          `/api/repository/copy-move/status/${jobId}`
        );
        if (!statusRes.ok) {
          // A transient status hiccup shouldn't abort a job that is very
          // likely still running — keep polling until the attempt budget runs
          // out and report a timeout instead.
          continue;
        }

        const data = await statusRes.json();
        if (data.state === "completed") {
          const result = data.result as CopyMoveJobResult | null;
          const firstError = result?.errors?.[0];
          if (firstError) {
            throw new Error(firstError.error);
          }
          if (!result || result.copiedCount === 0) {
            throw new Error("No test cases were cloned");
          }
          return result;
        }
        if (data.state === "failed") {
          throw new Error(data.failedReason || "Clone job failed");
        }
      }

      throw new Error("Clone job did not finish in time");
    } finally {
      inFlightRef.current = false;
      setIsCloning(false);
    }
  }, []);

  return { clone, isCloning };
}
