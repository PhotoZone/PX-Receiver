import type { Metadata } from "next";
import { IBM_Plex_Mono, Raleway } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { WorkerStoreProvider } from "@/lib/use-worker-store";

const raleway = Raleway({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "PX Receiver",
  description: "Cross-platform PX receiver desktop application",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${raleway.variable} ${ibmPlexMono.variable}`}>
      <body className="font-sans">
        <WorkerStoreProvider>
          <AppShell>{children}</AppShell>
        </WorkerStoreProvider>
      </body>
    </html>
  );
}
