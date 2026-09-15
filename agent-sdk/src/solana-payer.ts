import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { X402Challenge } from "./types";

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export interface Payer {
  signAndSend(challenge: X402Challenge, payer: Keypair): Promise<string>;
}

export class SolanaPayer implements Payer {
  constructor(private readonly connection: Connection) {}

  async signAndSend(challenge: X402Challenge, payer: Keypair): Promise<string> {
    const reference = new PublicKey(challenge.extra.reference);
    const recipient = new PublicKey(challenge.payTo);
    const lamports = Number(challenge.amount);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      throw new Error(`Invalid challenge amount: ${challenge.amount}`);
    }

    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");

    const transferIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports,
    });
    transferIx.keys.push({ pubkey: reference, isSigner: false, isWritable: false });

    const memoData = challenge.memo ?? `netra:${challenge.extra.reference}`;
    const memoIx = new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoData, "utf8"),
    });

    const tx = new Transaction({
      feePayer: payer.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }).add(transferIx, memoIx);

    return sendAndConfirmTransaction(this.connection, tx, [payer], {
      commitment: "confirmed",
    });
  }
}
