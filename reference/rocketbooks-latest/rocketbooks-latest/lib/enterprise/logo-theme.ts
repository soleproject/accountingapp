/**
 * Generate theme options matched to an enterprise's logo. Runs in the browser:
 * it samples the logo image on a canvas, pulls the dominant brand colors, and
 * builds three distinct ThemeConfig presets from them. Import + call only from
 * client code (uses Image/canvas at runtime).
 */
import type { ThemeConfig } from './theme';

export interface LogoThemeOption {
  name: string;
  /** preview swatches for the button */
  swatches: string[];
  config: ThemeConfig;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const i = parseInt(n, 16);
  return { r: (i >> 16) & 255, g: (i >> 8) & 255, b: i & 255 };
}
function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
  );
}
function mix(hex: string, target: string, t: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}
const shade = (hex: string, t: number) => mix(hex, '#000000', t);
const tint = (hex: string, t: number) => mix(hex, '#ffffff', t);

/** Pull the most prominent, saturated colors from an image data URL. */
function extractColors(src: string): Promise<string[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = 48;
      const h = 48;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve([]);
      ctx.drawImage(img, 0, 0, w, h);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, w, h).data;
      } catch {
        return resolve([]); // tainted canvas (non-data-URL cross-origin)
      }
      const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 200) continue; // transparent
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max > 238 && min > 238) continue; // near-white
        if (max < 28) continue; // near-black
        const sat = max === 0 ? 0 : (max - min) / max;
        if (sat < 0.18) continue; // grays
        const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
        const e = buckets.get(key);
        if (e) e.n++;
        else buckets.set(key, { n: 1, r, g, b });
      }
      const sorted = [...buckets.values()].sort((x, y) => y.n - x.n).slice(0, 5);
      resolve(sorted.map((c) => rgbToHex(c.r, c.g, c.b)));
    };
    img.onerror = () => resolve([]);
    img.src = src;
  });
}

/** Build up to three distinct theme options from a logo's colors. */
export async function extractLogoThemes(logoUrl: string): Promise<LogoThemeOption[]> {
  const colors = await extractColors(logoUrl);
  if (colors.length === 0) return [];
  const c1 = colors[0];
  const c2 = colors[1] ?? colors[0];

  const light: ThemeConfig = {
    accentBtn: c1,
    accentLink: c1,
    accentCheckbox: c1,
    accentRing: c1,
    sidebarIcon: c1,
    sidebarActiveBg: tint(c1, 0.88),
    sidebarActiveText: shade(c1, 0.45),
  };

  const darkBg = shade(c1, 0.82);
  const bold: ThemeConfig = {
    accentBtn: c2,
    accentLink: tint(c2, 0.55),
    accentCheckbox: c2,
    accentRing: c2,
    sidebarBg: darkBg,
    sidebarText: '#e5e7eb',
    sidebarIcon: tint(c1, 0.5),
    sidebarActiveBg: shade(c1, 0.55),
    sidebarActiveText: '#ffffff',
    topbarBg: darkBg,
    topbarText: '#e5e7eb',
    chatPanelBg: darkBg,
    chatUserBubble: shade(c1, 0.55),
    chatText: '#e5e7eb',
  };

  const twoTone: ThemeConfig = {
    accentBtn: c1,
    accentLink: c2,
    accentCheckbox: c1,
    accentRing: c1,
    sidebarIcon: c2,
    sidebarActiveBg: tint(c2, 0.85),
    sidebarActiveText: shade(c2, 0.45),
  };

  return [
    { name: 'From logo · Light', swatches: [c1, tint(c1, 0.88), '#ffffff'], config: light },
    { name: 'From logo · Bold', swatches: [darkBg, c2, '#e5e7eb'], config: bold },
    { name: 'From logo · Two-tone', swatches: [c1, c2, tint(c2, 0.85)], config: twoTone },
  ];
}
