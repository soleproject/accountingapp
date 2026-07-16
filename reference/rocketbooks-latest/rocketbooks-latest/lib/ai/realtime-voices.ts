export const REALTIME_VOICES = [
  { value: 'alloy', label: 'Alloy', description: 'Neutral, balanced' },
  { value: 'ash', label: 'Ash', description: 'Warm, conversational' },
  { value: 'ballad', label: 'Ballad', description: 'Smooth, gentle' },
  { value: 'coral', label: 'Coral', description: 'Bright, expressive' },
  { value: 'echo', label: 'Echo', description: 'Clear, articulate' },
  { value: 'sage', label: 'Sage', description: 'Calm, thoughtful' },
  { value: 'shimmer', label: 'Shimmer', description: 'Light, energetic' },
  { value: 'verse', label: 'Verse', description: 'Engaging, dynamic' },
] as const;

export type RealtimeVoice = (typeof REALTIME_VOICES)[number]['value'];
export const DEFAULT_VOICE: RealtimeVoice = 'verse';
export const REALTIME_MODEL = 'gpt-realtime';
