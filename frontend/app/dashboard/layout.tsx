import type { ReactNode } from "react";
import SolanaWalletProvider from "@/components/SolanaWalletProvider";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <SolanaWalletProvider>{children}</SolanaWalletProvider>;
}
