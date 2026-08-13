/**
 * Unit tests for the useCloneCases hook — the one-click "Clone" action's
 * client half. Covers the submit payload it derives from a case row, polling
 * to completion, and the failure paths the callers surface as toasts.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { useCloneCases } from "./useCloneCases";

function okResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response);
}

function errorResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

const ARGS = {
  caseIds: [42],
  projectId: 7,
  folderId: 3,
  repositoryId: 9,
};

const COMPLETED_RESULT = {
  copiedCount: 1,
  movedCount: 0,
  skippedCount: 0,
  droppedLinkCount: 0,
  errors: [],
  createdCaseIds: [99],
};

describe("useCloneCases", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockReset();
  });

  it("submits a within-project copy into the case's own folder", async () => {
    fetchMock
      .mockReturnValueOnce(okResponse({ jobId: "job-1" }))
      .mockReturnValue(
        okResponse({ state: "completed", result: COMPLETED_RESULT })
      );

    const { result } = renderHook(() => useCloneCases());

    let promise: Promise<unknown>;
    act(() => {
      promise = result.current.clone(ARGS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/repository/copy-move");
    expect(JSON.parse(init.body)).toEqual({
      operation: "copy",
      caseIds: [42],
      sourceProjectId: 7,
      targetProjectId: 7,
      targetFolderId: 3,
      targetRepositoryId: 9,
      // "rename", never "skip" — a clone always collides with its source
      conflictResolution: "rename",
      sharedStepGroupResolution: "reuse",
    });
  });

  it("resolves with the job result once the job completes", async () => {
    fetchMock
      .mockReturnValueOnce(okResponse({ jobId: "job-1" }))
      .mockReturnValueOnce(okResponse({ state: "active" }))
      .mockReturnValue(
        okResponse({ state: "completed", result: COMPLETED_RESULT })
      );

    const { result } = renderHook(() => useCloneCases());

    let promise: Promise<any>;
    act(() => {
      promise = result.current.clone(ARGS);
    });

    let resolved: any;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      resolved = await promise;
    });

    expect(resolved.createdCaseIds).toEqual([99]);
    await waitFor(() => expect(result.current.isCloning).toBe(false));
  });

  it("rejects with the server message when the submit is refused", async () => {
    fetchMock.mockReturnValueOnce(
      errorResponse(503, { error: "Background job queue is not available" })
    );

    const { result } = renderHook(() => useCloneCases());

    let settled: Promise<unknown>;
    await act(async () => {
      settled = result.current.clone(ARGS).catch((e: Error) => e);
      await settled;
    });

    await expect(settled!).resolves.toMatchObject({
      message: "Background job queue is not available",
    });
    expect(result.current.isCloning).toBe(false);
  });

  it("rejects when the job fails", async () => {
    fetchMock
      .mockReturnValueOnce(okResponse({ jobId: "job-1" }))
      .mockReturnValue(
        okResponse({ state: "failed", failedReason: "Job cancelled by user" })
      );

    const { result } = renderHook(() => useCloneCases());

    let settled: Promise<unknown>;
    act(() => {
      // Capture the rejection synchronously — attaching the assertion later
      // would surface it as an unhandled rejection first.
      settled = result.current.clone(ARGS).catch((e: Error) => e);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    await expect(settled!).resolves.toMatchObject({
      message: "Job cancelled by user",
    });
  });

  it("rejects when the job completes without cloning anything", async () => {
    fetchMock
      .mockReturnValueOnce(okResponse({ jobId: "job-1" }))
      .mockReturnValue(
        okResponse({
          state: "completed",
          result: { ...COMPLETED_RESULT, copiedCount: 0, createdCaseIds: [] },
        })
      );

    const { result } = renderHook(() => useCloneCases());

    let settled: Promise<unknown>;
    act(() => {
      settled = result.current.clone(ARGS).catch((e: Error) => e);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    await expect(settled!).resolves.toMatchObject({
      message: "No test cases were cloned",
    });
  });

  it("refuses a second clone while one is still in flight", async () => {
    fetchMock
      .mockReturnValueOnce(okResponse({ jobId: "job-1" }))
      .mockReturnValue(
        okResponse({ state: "completed", result: COMPLETED_RESULT })
      );

    const { result } = renderHook(() => useCloneCases());

    let first: Promise<unknown>;
    let second: Promise<unknown>;
    act(() => {
      first = result.current.clone(ARGS);
      second = result.current.clone(ARGS).catch((e: Error) => e);
    });

    await expect(second!).resolves.toMatchObject({
      message: "A clone is already in progress",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await first!;
    });
    // Only the first click reached the API.
    expect(
      fetchMock.mock.calls.filter(
        (call: unknown[]) => call[0] === "/api/repository/copy-move"
      )
    ).toHaveLength(1);
  });
});
