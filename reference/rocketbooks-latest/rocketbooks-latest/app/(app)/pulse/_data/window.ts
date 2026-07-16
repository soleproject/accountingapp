export type WindowDays = 30 | 45 | 60 | 90;
export const VALID_WINDOWS: readonly WindowDays[] = [30, 45, 60, 90] as const;

export function parseWindow(input: string | undefined): WindowDays {
  const n = Number(input);
  return VALID_WINDOWS.includes(n as WindowDays) ? (n as WindowDays) : 30;
}
