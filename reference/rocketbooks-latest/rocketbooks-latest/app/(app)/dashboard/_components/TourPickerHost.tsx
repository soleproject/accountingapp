'use client';

import { TourPicker } from './TourPicker';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  firstName: string;
}

/**
 * Thin host so the server-rendered dashboard page can drop the picker
 * in without itself becoming a client component. The "show me around
 * the platform" handler kicks the layout-mounted GuidedTour via the
 * AssistantContext flag — runner survives the per-page navigation it
 * triggers (same pattern as the cool tour).
 */
export function TourPickerHost({ firstName }: Props) {
  const { startRegularTour } = useAssistant();
  return (
    <TourPicker
      firstName={firstName}
      onStartRegularTour={() => {
        startRegularTour();
      }}
    />
  );
}
