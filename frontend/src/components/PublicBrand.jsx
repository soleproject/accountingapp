import { useEffect } from "react";
import { useBranding } from "@/lib/branding";

// Push a token page's resolved company brand into the global BrandingProvider
// (palette + title) — no-op for the platform default.
export function usePublicBrand(brand) {
  const ctx = useBranding();
  const setPublicBrand = ctx?.setPublicBrand;
  useEffect(() => {
    if (!brand?.whitelabel || !setPublicBrand) return;
    setPublicBrand({ firm_name: brand.brand_name, theme_preset: brand.theme_preset, theme_custom: brand.theme_custom, logos: {} });
    const prev = document.title;
    document.title = brand.brand_name;
    return () => { setPublicBrand(null); document.title = prev; };
  }, [brand?.whitelabel, brand?.brand_name, brand?.theme_preset, brand?.theme_custom, setPublicBrand]);
}

export function PublicBrandMark({ brand, size = "md", className = "" }) {
  const h = size === "sm" ? "h-6" : "h-8";
  if (brand?.whitelabel) {
    return brand.logo_url
      ? <img src={brand.logo_url} alt={brand.brand_name} className={`${h} w-auto object-contain ${className}`} data-testid="public-brand-logo" />
      : <span className={`font-heading font-bold text-slate-900 ${className}`} data-testid="public-brand-name">{brand.brand_name}</span>;
  }
  return <span className={`font-heading font-bold text-slate-900 ${className}`} data-testid="public-brand-name">SmartBooks</span>;
}

export function PublicBrandFooter({ brand, className = "" }) {
  const host = (brand?.app_url || "").replace(/^https?:\/\//, "");
  return (
    <div className={`text-[11px] text-slate-400 text-center ${className}`} data-testid="public-brand-footer">
      {brand?.whitelabel
        ? <>{brand.brand_name}{host ? <> · <span className="font-mono">{host}</span></> : null}</>
        : <>SmartBooks · <span className="font-mono">smartbookssoftware.ai</span></>}
    </div>
  );
}
