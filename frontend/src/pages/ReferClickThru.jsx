/**
 * Click-tracking redirect for shared referral links.
 *
 * Path: /r/:slug   (public, no auth)
 *
 * Fires a fire-and-forget POST to /api/public/refer-click to record
 * the click (de-duped 30-min on slug + IP server-side), then hands
 * off to /refer/:slug — the actual lead-capture landing page.
 *
 * The visitor never sees this component render for more than ~200ms.
 */
import { useEffect } from "react";
import { useParams, Navigate } from "react-router-dom";
import axios from "axios";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

export default function ReferClickThru() {
  const { slug } = useParams();

  useEffect(() => {
    if (!slug) return;
    // Fire-and-forget click log. Errors are non-fatal — visitor still
    // gets forwarded to /refer/:slug regardless of network state.
    axios.post(`${API}/public/refer-click`, { slug })
      .catch(() => { /* ignore — analytics only */ });
  }, [slug]);

  if (!slug) return <Navigate to="/refer" replace />;
  return <Navigate to={`/refer/${slug}`} replace />;
}
