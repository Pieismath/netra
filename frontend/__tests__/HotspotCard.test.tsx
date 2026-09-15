import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HotspotCard from "@/components/HotspotCard";
import type { HotspotListing } from "@/lib/types";

// QrCode renders into a canvas via the qrcode library, which jsdom does not
// fully implement. Stub it — the test cares about layout, not the QR pixels.
vi.mock("@/components/QrCode", () => ({
  default: () => null,
}));

// ConnectModal polls the proxy on mount. Mock the network layer so tests
// stay deterministic and don't make real fetches.
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
    reputation: {
      reliabilityScore: 92,
      successfulSessions: 12,
      refunds: 1,
      disconnectRate: 0.08,
    },
    ...overrides,
  };
}

describe("HotspotCard", () => {
  test("renders core listing fields", () => {
    render(<HotspotCard listing={buildListing()} />);

    expect(screen.getByRole("heading", { name: "Fishtown Commons" })).toBeDefined();
    expect(screen.getByText("Philadelphia, PA · Fishtown")).toBeDefined();
    expect(screen.getByText(/WiFi: ⚡Netra-Fishtown/)).toBeDefined();
    expect(screen.getByText("180").textContent).toBe("180");
    expect(screen.getByText("45").textContent).toBe("45");
    expect(screen.getByText("0.001").textContent).toBe("0.001");
    expect(screen.getByText("Reliability 92%")).toBeDefined();
    expect(screen.getByText(/Host: demo-host-fishtown/)).toBeDefined();
  });

  test("shows 'Available' badge and an enabled View Access button when status is available", () => {
    render(<HotspotCard listing={buildListing({ status: "available" })} />);
    expect(screen.getByText("Available")).toBeDefined();
    const button = screen.getByRole("button", { name: "View Access" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  test("shows 'Occupied' badge and disables the button when status is occupied", () => {
    render(<HotspotCard listing={buildListing({ status: "occupied" })} />);
    expect(screen.getByText("Occupied")).toBeDefined();
    const button = screen.getByRole("button", { name: "In use" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  test("falls back to 100% reliability when reputation is missing", () => {
    render(<HotspotCard listing={buildListing({ reputation: undefined })} />);
    expect(screen.getByText(/Reliability 100%/)).toBeDefined();
  });

  test("clicking 'View Access' opens the ConnectModal", () => {
    render(<HotspotCard listing={buildListing()} />);
    const button = screen.getByRole("button", { name: "View Access" });
    fireEvent.click(button);
    // ConnectModal renders a heading "Hotspot Access" plus the listing name as a heading.
    expect(screen.getByText(/Hotspot Access/i)).toBeDefined();
  });
});
