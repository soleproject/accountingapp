export type FeedbackStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type FeedbackKindStr = 'bug' | 'recommendation';

type BadgeTone = 'green' | 'amber' | 'red' | 'blue' | 'zinc';

export function statusLabel(s: FeedbackStatus | string): string {
  switch (s) {
    case 'open':
      return 'Open';
    case 'in_progress':
      return 'In progress';
    case 'resolved':
      return 'Resolved';
    case 'closed':
      return 'Closed';
    default:
      return s;
  }
}

export function statusTone(s: FeedbackStatus | string): BadgeTone {
  switch (s) {
    case 'open':
      return 'red';
    case 'in_progress':
      return 'amber';
    case 'resolved':
      return 'green';
    case 'closed':
      return 'zinc';
    default:
      return 'zinc';
  }
}

export function kindLabel(k: FeedbackKindStr | string): string {
  return k === 'bug' ? 'Bug' : k === 'recommendation' ? 'Recommendation' : k;
}

export function kindTone(k: FeedbackKindStr | string): BadgeTone {
  return k === 'bug' ? 'red' : 'blue';
}

export const STATUS_OPTIONS: { value: FeedbackStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];
