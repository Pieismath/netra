"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getDashboard, getHealth } from "@/lib/api";
import type { DashboardData, ProxySession } from "@/lib/types";
import HostAuthGate from "@/components/HostAuthGate";

function fmtDate(iso?: string | null) {
  if (!iso) return "Pending";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTime(seconds: number) {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.max(0, seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function sessionLabel(session: ProxySession) {
  return session.session_type === "agent" ? "x402 API" : "Captive portal";
}

const PAGE_SIZE = 50;
const FAILURE_THRESHOLD = 3;
const BACKOFF_LADDER = [10_000, 30_000, 120_000, 300_000];
const NORMAL_INTERVAL = 5_000;

type Tab = "live" | "past";

export default function DashboardPage() {
  const [topListingId, setTopListingId] = useState<string>("host");

  return (
    <HostAuthGate hotspotId={topListingId}>
      {() => <DashboardInner onListingId={setTopListingId} />}
    </HostAuthGate>
  );
}

function DashboardInner({ onListingId }: { onListingId: (id: string) => void }) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [health, setHealth] = useState<{
    status: string;
    active_sessions: number;
    uptime_seconds: number;
    x402_ready?: boolean;
    filecoin_synapse_ready?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [tab, setTab] = useState<Tab>("live");
  const [sessionLimit, setSessionLimit] = useState(PAGE_SIZE);
  const [pastLimit, setPastLimit] = useState(PAGE_SIZE);
  const [artifactLimit, setArtifactLimit] = useState(PAGE_SIZE);

  const failureCountRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function refresh() {
      try {
        const [dashboardData, healthData] = await Promise.all([
          getDashboard(),
          getHealth(),
        ]);
        if (!mounted) return;
        setDashboard(dashboardData);
        setHealth(healthData);
        setError(null);
        failureCountRef.current = 0;
        setReconnecting(false);
      } catch (err) {
        if (!mounted) return;
        failureCountRef.current += 1;
        if (failureCountRef.current >= FAILURE_THRESHOLD) {
          setReconnecting(true);
        } else {
          setError(err instanceof Error ? err.message : "Failed to load dashboard");
        }
      } finally {
        if (!mounted) return;
        const failures = failureCountRef.current;
        const delay =
          failures < FAILURE_THRESHOLD
            ? NORMAL_INTERVAL
            : BACKOFF_LADDER[
                Math.min(failures - FAILURE_THRESHOLD, BACKOFF_LADDER.length - 1)
              ];
        timer = setTimeout(refresh, delay);
      }
    }

    refresh();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const activeSessions = useMemo(
    () => dashboard?.sessions.filter((session) => session.active) ?? [],
    [dashboard]
  );
  const completedSessions = useMemo(
    () => dashboard?.sessions.filter((session) => !session.active) ?? [],
    [dashboard]
  );
  const topListing = dashboard?.listings[0];

  useEffect(() => {
    if (topListing?.id) onListingId(topListing.id);
  }, [topListing?.id, onListingId]);

  const visibleActive = activeSessions.slice(0, sessionLimit);
  const visiblePast = completedSessions.slice(0, pastLimit);
  const visibleArtifacts = (dashboard?.recentArtifacts || []).slice(0, artifactLimit);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <div className="overflow-hidden rounded-[24px] border border-white/10 bg-[radial-gradient(circle_at_top_left,_rgba(34,197,94,0.2),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(14,165,233,0.18),_transparent_35%),linear-gradient(180deg,#0b1220,#090d15)] px-5 py-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:rounded-[32px] sm:px-8 sm:py-8">
        <div className="flex flex-col gap-6 md:flex-row md:flex-wrap md:items-start md:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs uppercase tracking-[0.3em] text-emerald-200/70">
              Host Dashboard
            </p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-4xl">
              Proof, reputation, and live hotspot operations.
            </h1>
            <p className="mt-4 text-sm leading-7 text-slate-300 sm:text-base">
              This view consolidates captive-portal sessions, x402 programmatic purchases, Solana payment proofs, and the latest CID-backed artifacts for judges.
            </p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.05] px-4 py-3 text-sm text-slate-200">
            <div>Proxy status: {health ? "online" : "loading"}</div>
            <div className="mt-1 text-slate-400">
              x402 {health?.x402_ready ? "ready" : "awaiting wallet"} · Filecoin{" "}
              {health?.filecoin_synapse_ready ? "Synapse configured" : "local CID mode"}
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 sm:mt-8 sm:grid-cols-4 sm:gap-4">
          {[
            {
              label: "Earned",
              value: `${dashboard?.summary.totalEarnedSol.toFixed(4) || "0.0000"} SOL`,
            },
            {
              label: "Active sessions",
              value: dashboard?.summary.activeSessions ?? 0,
            },
            {
              label: "Completed sessions",
              value: dashboard?.summary.completedSessions ?? 0,
            },
            {
              label: "Refunds",
              value: dashboard?.summary.refunds ?? 0,
            },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 sm:px-5 sm:py-4"
            >
              <div className="text-xl font-semibold text-white sm:text-2xl">{card.value}</div>
              <div className="mt-1 text-xs text-slate-500 sm:text-sm">{card.label}</div>
            </div>
          ))}
        </div>
      </div>

      {reconnecting && (
        <div
          role="status"
          className="mt-4 flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
        >
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          Reconnecting to control API…
        </div>
      )}

      {error && !reconnecting && (
        <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="space-y-6">
          <div className="rounded-[24px] border border-white/8 bg-[#0d1420] p-5 sm:rounded-[28px] sm:p-6">
            <div className="flex flex-wrap items-center gap-3 border-b border-white/10 pb-3">
              <TabButton active={tab === "live"} onClick={() => setTab("live")}>
                Live sessions ({activeSessions.length})
              </TabButton>
              <TabButton active={tab === "past"} onClick={() => setTab("past")}>
                Past sessions ({completedSessions.length})
              </TabButton>
              <span className="ml-auto text-xs uppercase tracking-[0.24em] text-slate-500">
                {reconnecting ? "Backoff active" : "Refreshes every 5s"}
              </span>
            </div>

            {tab === "live" ? (
              <div className="mt-4 space-y-3">
                {visibleActive.length === 0 ? (
                  <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5 text-sm text-slate-400">
                    No active sessions yet. Run the captive portal or x402 agent demo to populate this table.
                  </div>
                ) : (
                  visibleActive.map((session) => (
                    <div
                      key={session.session_id}
                      className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-semibold text-white">
                            {sessionLabel(session)} · {session.ip}
                          </div>
                          <div className="mt-1 break-all text-xs text-emerald-100/75">
                            Tx {session.tx_hash?.slice(0, 12)}... · CID{" "}
                            {session.filecoin.latestCid?.slice(0, 16)}...
                          </div>
                        </div>
                        <div className="text-left sm:text-right">
                          <div className="font-mono text-2xl text-white">
                            {fmtTime(session.seconds_remaining)}
                          </div>
                          <div className="text-xs uppercase tracking-[0.22em] text-emerald-100/70">
                            Remaining
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
                {activeSessions.length > sessionLimit && (
                  <ShowMoreButton
                    onClick={() => setSessionLimit((n) => n + PAGE_SIZE)}
                    remaining={activeSessions.length - sessionLimit}
                  />
                )}
              </div>
            ) : (
              <div className="mt-4">
                {visiblePast.length === 0 ? (
                  <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5 text-sm text-slate-400">
                    No past sessions yet.
                  </div>
                ) : (
                  <>
                    <div className="hidden overflow-hidden rounded-2xl border border-white/8 sm:block">
                      <table className="min-w-full divide-y divide-white/8 text-sm">
                        <thead className="bg-white/[0.03] text-left text-slate-400">
                          <tr>
                            <th className="px-4 py-3 font-medium">Type</th>
                            <th className="px-4 py-3 font-medium">Ended</th>
                            <th className="px-4 py-3 font-medium">Tx</th>
                            <th className="px-4 py-3 font-medium">CID</th>
                            <th className="px-4 py-3 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/8 bg-[#091019] text-slate-200">
                          {visiblePast.map((session) => (
                            <tr key={session.session_id}>
                              <td className="px-4 py-3">{sessionLabel(session)}</td>
                              <td className="px-4 py-3">{fmtDate(session.ended_at || session.paid_until)}</td>
                              <td className="px-4 py-3 font-mono text-xs">
                                {session.tx_hash ? `${session.tx_hash.slice(0, 12)}...` : "Pending"}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs">
                                {session.filecoin.latestCid
                                  ? `${session.filecoin.latestCid.slice(0, 18)}...`
                                  : "Pending"}
                              </td>
                              <td className="px-4 py-3 text-xs uppercase tracking-[0.18em] text-slate-400">
                                {session.status.replace("_", " ")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="space-y-3 sm:hidden">
                      {visiblePast.map((session) => (
                        <div
                          key={session.session_id}
                          className="rounded-2xl border border-white/8 bg-[#091019] p-4 text-sm"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-white">{sessionLabel(session)}</span>
                            <span className="text-xs uppercase tracking-[0.18em] text-slate-400">
                              {session.status.replace("_", " ")}
                            </span>
                          </div>
                          <div className="mt-2 text-xs text-slate-400">
                            {fmtDate(session.ended_at || session.paid_until)}
                          </div>
                          <div className="mt-2 break-all font-mono text-xs text-slate-300">
                            Tx {session.tx_hash?.slice(0, 18) || "Pending"}
                          </div>
                          <div className="mt-1 break-all font-mono text-xs text-slate-300">
                            CID {session.filecoin.latestCid?.slice(0, 24) || "Pending"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {completedSessions.length > pastLimit && (
                  <div className="mt-4">
                    <ShowMoreButton
                      onClick={() => setPastLimit((n) => n + PAGE_SIZE)}
                      remaining={completedSessions.length - pastLimit}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-6">
          <div className="rounded-[24px] border border-white/8 bg-[#0d1420] p-5 sm:rounded-[28px] sm:p-6">
            <h2 className="text-lg font-semibold text-white">Hotspot Reputation</h2>
            <div className="mt-4 space-y-3 text-sm text-slate-300">
              <Metric label="Listing" value={topListing?.name || "Local hotspot"} />
              <Metric
                label="Reliability score"
                value={`${topListing?.reputation?.reliabilityScore ?? 100}%`}
              />
              <Metric
                label="Successful sessions"
                value={String(topListing?.reputation?.successfulSessions ?? 0)}
              />
              <Metric label="Refunds" value={String(topListing?.reputation?.refunds ?? 0)} />
              <Metric
                label="Reputation CID"
                value={topListing?.filecoin?.latestReputationCid || "Pending"}
                mono
              />
            </div>
          </div>

          <div className="rounded-[24px] border border-white/8 bg-[#0d1420] p-5 sm:rounded-[28px] sm:p-6">
            <h2 className="text-lg font-semibold text-white">Recent Artifacts</h2>
            <div className="mt-4 space-y-3">
              {visibleArtifacts.length === 0 ? (
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm text-slate-400">
                  No artifacts yet.
                </div>
              ) : (
                visibleArtifacts.map((artifact) => (
                  <div
                    key={`${artifact.sessionId}-${artifact.cid}`}
                    className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-white">{artifact.kind}</span>
                      <span className="text-xs uppercase tracking-[0.18em] text-slate-500">
                        {artifact.synapse?.uploaded ? "Synapse uploaded" : "CID ready"}
                      </span>
                    </div>
                    <div className="mt-2 break-all font-mono text-xs text-sky-200">{artifact.cid}</div>
                    <div className="mt-2 text-xs text-slate-500">{fmtDate(artifact.createdAt)}</div>
                  </div>
                ))
              )}
              {(dashboard?.recentArtifacts.length ?? 0) > artifactLimit && (
                <ShowMoreButton
                  onClick={() => setArtifactLimit((n) => n + PAGE_SIZE)}
                  remaining={(dashboard?.recentArtifacts.length ?? 0) - artifactLimit}
                />
              )}
            </div>
          </div>

          <div className="rounded-[24px] border border-sky-500/20 bg-sky-500/10 p-5 sm:rounded-[28px] sm:p-6">
            <h2 className="text-lg font-semibold text-white">Judge Notes</h2>
            <div className="mt-3 space-y-2 text-sm text-sky-50/85">
              <p>Human traffic remains blocked at the proxy and pf layer until payment verification succeeds.</p>
              <p>Agent traffic uses HTTP 402 on the x402 endpoint before access or extension is granted.</p>
              <p>Session receipts and reputation objects are persisted as CID-backed artifacts for portability.</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-h-[44px] rounded-full px-4 py-2 text-sm font-semibold transition ${
        active
          ? "bg-emerald-400 text-slate-950"
          : "bg-white/5 text-slate-300 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

function ShowMoreButton({
  onClick,
  remaining,
}: {
  onClick: () => void;
  remaining: number;
}) {
  return (
    <button
      onClick={onClick}
      className="mt-3 min-h-[44px] w-full rounded-2xl border border-white/10 bg-white/[0.04] py-3 text-sm font-medium text-slate-200 transition hover:bg-white/[0.08]"
    >
      Show more ({remaining} more)
    </button>
  );
}

function Metric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={mono ? "max-w-[60%] break-all font-mono text-xs text-white" : "text-white"}>
        {value}
      </span>
    </div>
  );
}
