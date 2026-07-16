/**
 * Public entry point for video calling. Import from `@/lib/video` everywhere —
 * never from `@/lib/video/daily`. This single binding is the provider seam:
 * swap Daily for another provider by pointing `videoProvider` at a different
 * implementation of `VideoProvider`. No call sites change.
 */
import { dailyProvider } from './daily';
import type { VideoProvider } from './types';

export const videoProvider: VideoProvider = dailyProvider;

export type {
  VideoProvider,
  VideoRoom,
  CreateRoomOptions,
  MeetingTokenOptions,
} from './types';
