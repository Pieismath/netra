import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ConnectModal from "@/components/ConnectModal";
import type { HotspotListing } from "@/lib/types";

vi.mock("@/components/QrCode", () => ({
  default: () => null,
}));

vi.mock("@/lib/api", () => ({
  getMyIp: vi.fn(async () => ({ ip: "192.168.2.50" })),
  getSessions: vi.fn(async () => []),
  deleteSession: vi.fn(),
  getDashboard: vi.fn(),
  getHealth: vi.fn(),
  getListings: vi.fn(),
  createListing: vi.fn(),
  deleteListing: vi.fn(),
  createSession: vi.fn(),
}));

function buildListing(overrides: Partial<HotspotListing> = {}): HotspotListing {
  return {
    id: "demo-fishtown",
    name: "Fishtown Commons",
    ssid: "⚡Netra-Fishtown",
    location: "Philadelphia, PA · Fishtown",
    pricePerMinute: 0.001,
    signalStrength: 4,
    status: "available",
    host: "demo-host-fishtown",
    uploadMbps: 45,
    downloadMbps: 180,
    hostIp: "192.168.2.1",
    portalUrl: "http://192.168.2.1:8888/",
    reputation: {
      reliabilityScore: 92,
      successfulSessions: 12,
      refunds: 1,
      disconnectRate: 0.08,
    },
    ...overrides,
  };
}

describe("ConnectModal duration selector", () => {
  beforeEach(() => {
    // Reset any prior renders.
  });

  test("starts on the 10 minute option by default", async () => {
    render(<ConnectModal listing={buildListing()} onClose={() => {}} />);

    // Three duration buttons exist: 5, 10, 30.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "5 min" })).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "10 min" })).toBeDefined();
    expect(screen.getByRole("button", { name: "30 min" })).toBeDefined();

    // The 10-minute total cost (0.001 * 10 = 0.01) should appear in the
    // human-flow paragraph.  This is the strongest signal that "10" is the
    // active selection.
    expect(screen.getByText(/Pay 0\.0100 SOL for 10 minutes/)).toBeDefined();
  });

  test("clicking 5 min and 30 min updates the cost calculation", async () => {
    render(<ConnectModal listing={buildListing()} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "5 min" })).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "5 min" }));
    expect(screen.getByText(/Pay 0\.0050 SOL for 5 minutes/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "30 min" }));
    expect(screen.getByText(/Pay 0\.0300 SOL for 30 minutes/)).toBeDefined();
  });

  test("close button calls onClose", async () => {
    const onClose = vi.fn();
    render(<ConnectModal listing={buildListing()} onClose={onClose} />);

    // The close button is the only button rendering an "✕" glyph.
    await waitFor(() => {
      expect(screen.getByText("✕")).toBeDefined();
    });
    fireEvent.click(screen.getByText("✕"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("renders the curl example with the selected duration", async () => {
    render(<ConnectModal listing={buildListing()} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "5 min" })).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "30 min" }));
    // The curl example must include the selected minutes value.
    const code = screen.getByText(/curl -i -X POST/);
    expect(code.textContent).toContain('"minutes": 30');
    expect(code.textContent).toContain('"listingId": "demo-fishtown"');
  });
});
