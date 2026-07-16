import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_GIT_COMMIT: process.env.NEXT_PUBLIC_GIT_COMMIT ?? '',
    ROCKETSUITE_BUILD_ID: process.env.ROCKETSUITE_BUILD_ID ?? '',
  },
  images: {
    // OpenNext on Cloudflare attempts to use an env.IMAGES binding for optimized
    // image routes. RocketSuite serves static local logos and does not have a
    // Cloudflare Images binding, so keep images unoptimized to avoid noisy
    // Worker warnings and serve assets directly from ASSETS.
    unoptimized: true,
  },
  // pdf.js (used server-side for tax-document text extraction) loads its worker
  // by dynamically importing a sibling module at runtime. When the bundler
  // inlines pdfjs-dist into the server chunk that worker file is never emitted,
  // so getDocument() throws "Setting up fake worker failed: Cannot find module
  // …/pdf.worker.mjs". Keep it external so it's required from node_modules,
  // where the worker resolves normally.
  serverExternalPackages: ['pdfjs-dist'],
  experimental: {
    serverActions: {
      // Default is 1 MB, which silently 413s receipt photos and PDF scans.
      // The receipt upload action enforces a 10 MB ceiling itself.
      bodySizeLimit: '12mb',
    },
  },
};

export default nextConfig;
