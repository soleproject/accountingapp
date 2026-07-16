'use client';

import dynamic from 'next/dynamic';

export const LazyAIAssistantSidecar = dynamic(
  () => import('./AIAssistantSidecar').then((module) => module.AIAssistantSidecar),
  { ssr: false },
);
