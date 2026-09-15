import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { NetraClient } from "../src/client";
import type { HttpClient, HttpResponse } from "../src/http";
import type { Payer } from "../src/solana-payer";
import type { X402Challenge } from "../src/types";

const CONTROL_API = "http://localhost:3001";
const FAKE_SIGNATURE = "fake-tx-signature-base58";
const REFERENCE_PUBKEY = "11111111111111111111111111111112";
const HOST_WALLET = "HostWa11et00000000000000000000000000000000";

interface RecordedCall {
  method: "GET" | "POST" | "DELETE";
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

class FakeHttpClient implements HttpClient {
  calls: RecordedCall[] = [];
  responders: Array<(call: RecordedCall) => HttpResponse> = [];

  enqueue(responder: (call: RecordedCall) => HttpResponse): void {
    this.responders.push(responder);
  }

  private async dispatch(call: RecordedCall): Promise<HttpResponse> {
    this.calls.push(call);
    const responder = this.responders.shift();
    if (!responder) {
      throw new Error(
        `FakeHttpClient: no responder queued for ${call.method} ${call.url}`
      );
    }
    return responder(call);
  }

  async get<T>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    return (await this.dispatch({ method: "GET", url, headers })) as HttpResponse<T>;
  }
  async post<T>(
    url: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return (await this.dispatch({
      method: "POST",
      url,
      body,
      headers,
    })) as HttpResponse<T>;
  }
  async delete<T>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    return (await this.dispatch({ method: "DELETE", url, headers })) as HttpResponse<T>;
  }
}

class FakePayer implements Payer {
  challenges: X402Challenge[] = [];
  signature = FAKE_SIGNATURE;

  async signAndSend(challenge: X402Challenge): Promise<string> {
    this.challenges.push(challenge);
    return this.signature;
  }
}

function makeChallenge402(): HttpResponse {
  return {
    status: 402,
    data: {
      x402Version: 1,
      error: "payment_required",
      message: "Pay on Solana devnet to unlock hotspot access.",
      accepts: [
        {
          scheme: "exact",
          network: "solana-devnet",
          asset: "SOL",
          amount: "5000000",
          amountDisplay: "0.005000 SOL",
          payTo: HOST_WALLET,
          resource: "/x402/sessions/purchase",
          memo: `netra:${REFERENCE_PUBKEY}`,
          extra: {
            reference: REFERENCE_PUBKEY,
            listingId: "local-hotspot",
            minutes: 10,
            action: "purchase",
            sessionId: null,
          },
        },
      ],
      paymentContext: {
        reference: REFERENCE_PUBKEY,
        expiresAt: "2026-04-29T22:15:00.000Z",
        retryHeader: "Payment-Signature",
      },
    },
  };
}

function makeSuccess201(sessionId = "sess-1"): HttpResponse {
  return {
    status: 201,
    data: {
      ok: true,
      payment: {
        signature: FAKE_SIGNATURE,
        slot: 123,
        buyerWallet: "buyer-wallet",
        transferredLamports: 5_000_000,
        memoPresent: true,
        explorerUrl: "https://explorer.solana.com/tx/fake",
      },
      session: {
        ip: "127.0.0.1",
        session_id: sessionId,
        listing_id: "local-hotspot",
        status: "active",
        minutes_purchased: 10,
        paid_until: "2026-04-29T22:25:00.000Z",
        amount_lamports: 5_000_000,
        amount_sol: "0.005",
        buyer_wallet: "buyer-wallet",
        tx_hash: FAKE_SIGNATURE,
        payment_reference: REFERENCE_PUBKEY,
        session_type: "agent",
      },
      seconds_granted: 600,
    },
  };
}

function newClient(http: FakeHttpClient, payer: FakePayer): NetraClient {
  return new NetraClient({
    wallet: Keypair.generate(),
    controlApiUrl: CONTROL_API,
    ip: "127.0.0.1",
    http,
    payer,
    enableMdns: false,
  });
}

describe("NetraClient.purchase x402 retry flow", () => {
  let http: FakeHttpClient;
  let payer: FakePayer;

  beforeEach(() => {
    http = new FakeHttpClient();
    payer = new FakePayer();
  });

  it("performs the 402 → sign → 2xx dance and returns a session", async () => {
    http.enqueue(() => makeChallenge402());
    http.enqueue(() => makeSuccess201());

    const client = newClient(http, payer);
    const result = await client.purchase("local-hotspot", 10);

    assert.equal(http.calls.length, 2);
    assert.equal(payer.challenges.length, 1);
    assert.equal(result.session.sessionId, "sess-1");
    assert.equal(result.session.amountLamports, 5_000_000);
    assert.equal(client.currentSession?.sessionId, "sess-1");

    const challengeCall = http.calls[0];
    assert.equal(challengeCall.method, "POST");
    assert.equal(challengeCall.url, `${CONTROL_API}/x402/sessions/purchase`);
    const challengeBody = challengeCall.body as Record<string, unknown>;
    assert.equal(challengeBody.listingId, "local-hotspot");
    assert.equal(challengeBody.minutes, 10);
    assert.equal(challengeBody.ip, "127.0.0.1");
    assert.equal(challengeBody.tier, "standard");
    assert.ok(typeof challengeBody.buyerWallet === "string");
    assert.equal((challengeBody as { reference?: unknown }).reference, undefined);

    const finalizeCall = http.calls[1];
    assert.equal(finalizeCall.method, "POST");
    assert.equal(finalizeCall.url, `${CONTROL_API}/x402/sessions/purchase`);
    assert.equal(finalizeCall.headers?.["Payment-Signature"], FAKE_SIGNATURE);
    const finalizeBody = finalizeCall.body as Record<string, unknown>;
    assert.equal(finalizeBody.reference, REFERENCE_PUBKEY);
    assert.equal(finalizeBody.listingId, "local-hotspot");
    assert.equal(finalizeBody.minutes, 10);

    const passedChallenge = payer.challenges[0];
    assert.equal(passedChallenge.payTo, HOST_WALLET);
    assert.equal(passedChallenge.amount, "5000000");
    assert.equal(passedChallenge.extra.reference, REFERENCE_PUBKEY);
  });

  it("falls back to paymentContext.reference if accepts[0].extra is missing it", async () => {
    http.enqueue(() => ({
      status: 402,
      data: {
        x402Version: 1,
        error: "payment_required",
        accepts: [
          {
            scheme: "exact",
            network: "solana-devnet",
            asset: "SOL",
            amount: "5000000",
            payTo: HOST_WALLET,
            extra: {
              reference: REFERENCE_PUBKEY,
              listingId: "local-hotspot",
              minutes: 10,
            },
          },
        ],
        paymentContext: {
          reference: REFERENCE_PUBKEY,
          expiresAt: "2026-04-29T22:15:00.000Z",
          retryHeader: "Payment-Signature",
        },
      },
    }));
    http.enqueue(() => makeSuccess201("sess-fallback"));

    const client = newClient(http, payer);
    const result = await client.purchase("local-hotspot", 10);
    const finalizeBody = http.calls[1].body as Record<string, unknown>;
    assert.equal(finalizeBody.reference, REFERENCE_PUBKEY);
    assert.equal(result.session.sessionId, "sess-fallback");
  });

  it("throws when the first response is not HTTP 402", async () => {
    http.enqueue(() => ({ status: 500, data: { error: "boom" } }));
    const client = newClient(http, payer);
    await assert.rejects(
      () => client.purchase("local-hotspot", 10),
      /Expected HTTP 402, received 500/
    );
    assert.equal(payer.challenges.length, 0);
  });

  it("throws when the finalize response is non-2xx", async () => {
    http.enqueue(() => makeChallenge402());
    http.enqueue(() => ({ status: 400, data: { error: "bad signature" } }));
    const client = newClient(http, payer);
    await assert.rejects(
      () => client.purchase("local-hotspot", 10),
      /Payment finalize failed: 400/
    );
  });

  it("rejects non-positive minutes without making any HTTP calls", async () => {
    const client = newClient(http, payer);
    await assert.rejects(() => client.purchase("local-hotspot", 0), /positive number/);
    assert.equal(http.calls.length, 0);
  });
});

describe("NetraClient.extend", () => {
  it("posts to /x402/sessions/{id}/extend with the same retry protocol", async () => {
    const http = new FakeHttpClient();
    const payer = new FakePayer();
    http.enqueue(() => makeChallenge402());
    http.enqueue(() => makeSuccess201("sess-1"));
    http.enqueue(() => makeChallenge402());
    http.enqueue(() => makeSuccess201("sess-1"));

    const client = newClient(http, payer);
    await client.purchase("local-hotspot", 10);
    const extended = await client.extend("sess-1", 5);

    const extendChallenge = http.calls[2];
    const extendFinalize = http.calls[3];
    assert.equal(
      extendChallenge.url,
      `${CONTROL_API}/x402/sessions/sess-1/extend`
    );
    assert.equal(
      extendFinalize.url,
      `${CONTROL_API}/x402/sessions/sess-1/extend`
    );
    assert.equal(extendFinalize.headers?.["Payment-Signature"], FAKE_SIGNATURE);
    assert.equal(extended.session.sessionId, "sess-1");
  });

  it("refuses to extend a session that is not the current one", async () => {
    const http = new FakeHttpClient();
    const payer = new FakePayer();
    const client = newClient(http, payer);
    await assert.rejects(() => client.extend("nonexistent", 5), /currentSession/);
  });
});

describe("NetraClient.disconnect", () => {
  it("calls DELETE /sessions/{ip} using the IP from the active session", async () => {
    const http = new FakeHttpClient();
    const payer = new FakePayer();
    http.enqueue(() => makeChallenge402());
    http.enqueue(() => makeSuccess201("sess-1"));
    http.enqueue(() => ({
      status: 200,
      data: {
        minutes_used: 4,
        minutes_remaining: 6,
        refund_amount: "0.003",
        refund_lamports: 3_000_000,
        refund_status: "submitted",
        refund_tx_hash: "refund-sig",
      },
    }));

    const client = newClient(http, payer);
    await client.purchase("local-hotspot", 10);
    const refund = await client.disconnect("sess-1");

    const disconnectCall = http.calls[2];
    assert.equal(disconnectCall.method, "DELETE");
    assert.equal(disconnectCall.url, `${CONTROL_API}/sessions/127.0.0.1`);
    assert.equal(refund.refundLamports, 3_000_000);
    assert.equal(refund.minutesUsed, 4);
    assert.equal(client.currentSession, null);
  });
});
