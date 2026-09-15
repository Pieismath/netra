import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { DashboardData } from "@/lib/types";

const getDashboardMock = vi.fn();
const getHealthMock = vi.fn();

vi.mock("@/lib/api", () => ({
  getDashboard: (...args: unknown[]) => getDashboardMock(...args),
  getHealth: (...args: unknown[]) => getHealthMock(...args),
  getMyIp: vi.fn(),
  getSessions: vi.fn(),
  deleteSession: vi.fn(),
  getListings: vi.fn(),
  createListing: vi.fn(),
  deleteListing: vi.fn(),
  createSession: vi.fn(),
}));

// HostAuthGate is wallet-gated; in tests just render the children directly
// with a fake token so we exercise DashboardInner's polling behavior.
vi.mock("@/components/HostAuthGate", () => ({
  __esModule: true,
  default: ({
    children,
  }: {
    hotspotId: string;
    children: (token: { pubkey: string; hotspotId: string; signature: string; nonce: string; issuedAt: number }) => React.ReactNode;
  }) => {
    return (
      <>
        {children({
          pubkey: "TEST_PK",
          hotspotId: "host",
          signature: "sig",
          nonce: "nonce",
          issuedAt: Date.now(),
        })}
      </>
    );
  },
}));

// Suppress recharts/css warnings — the test only cares about polling cadence.
import DashboardPage from "@/app/dashboard/page";

const SAMPLE_DASHBOARD: DashboardData = {
  summary: {
    totalListings: 1,
    activeSessions: 0,
    completedSessions: 0,
    totalEarnedSol: 0,
    refunds: 0,
  },
  listings: [],
  sessions: [],
  recentArtifacts: [],
};

const SAMPLE_HEALTH = {
  status: "ok",
  active_sessions: 0,
  uptime_seconds: 1,
  total_sessions: 0,
  total_listings: 1,
  x402_ready: true,
  filecoin_synapse_ready: false,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  getDashboardMock.mockReset();
  getHealthMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushPromises() {
  // Run all microtasks. Fake timers freeze setTimeout but await still works.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Dashboard polling backoff", () => {
  test("polls at the normal 5s interval while the proxy is healthy", async () => {
    getDashboardMock.mockResolvedValue(SAMPLE_DASHBOARD);
    getHealthMock.mockResolvedValue(SAMPLE_HEALTH);

    render(<DashboardPage />);

    // Initial fetch on mount.
    await act(async () => {
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(1);
    expect(getHealthMock).toHaveBeenCalledTimes(1);

    // Advance under 5s — no new fetch yet.
    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(1);

    // Cross the 5s boundary — second fetch fires.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(2);

    // Another 5s tick — third fetch.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(3);
  });

  test("after 3 consecutive failures the next poll waits 10s (backoff ladder step 0)", async () => {
    // First call succeeds, then 3 in a row fail. The 4th call should be
    // delayed by 10s instead of 5s.
    getDashboardMock
      .mockResolvedValueOnce(SAMPLE_DASHBOARD) // initial mount
      .mockRejectedValueOnce(new Error("boom 1"))
      .mockRejectedValueOnce(new Error("boom 2"))
      .mockRejectedValueOnce(new Error("boom 3"))
      .mockResolvedValue(SAMPLE_DASHBOARD); // recovery
    getHealthMock
      .mockResolvedValueOnce(SAMPLE_HEALTH)
      .mockRejectedValueOnce(new Error("boom 1"))
      .mockRejectedValueOnce(new Error("boom 2"))
      .mockRejectedValueOnce(new Error("boom 3"))
      .mockResolvedValue(SAMPLE_HEALTH);

    render(<DashboardPage />);
    await act(async () => {
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(1);

    // Failure 1 (after 5s normal interval).
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(2);

    // Failure 2 (after another 5s).
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(3);

    // Failure 3 (after another 5s) — third failure has now happened, so the
    // NEXT scheduled call uses BACKOFF_LADDER[0] = 10_000ms.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(4);

    // 5s into the 10s window — no new call yet.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(4);

    // Cross the 10s mark — next call fires (recovery).
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await flushPromises();
    });
    expect(getDashboardMock).toHaveBeenCalledTimes(5);
  });

  test("renders the loading state until the first fetch resolves", async () => {
    let resolveDashboard: (value: DashboardData) => void = () => {};
    getDashboardMock.mockReturnValue(
      new Promise<DashboardData>((resolve) => {
        resolveDashboard = resolve;
      })
    );
    getHealthMock.mockResolvedValue(SAMPLE_HEALTH);

    const { container } = render(<DashboardPage />);
    expect(container.textContent).toContain("Proxy status: loading");

    await act(async () => {
      resolveDashboard(SAMPLE_DASHBOARD);
      await flushPromises();
    });

    expect(container.textContent).toContain("Earned");
    expect(container.textContent).toContain("Proxy status: online");
  });
});
