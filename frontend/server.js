// Tiny static file server for the React SPA build.
//
// Why not `serve`? `serve-handler@6.1.7` (bundled with `serve@14`)
// calls `pathToRegExp.compile(...)` — an API removed in
// path-to-regexp v8. When yarn hoists a newer path-to-regexp from
// another dependency, `serve` crashes on the FIRST request with
// `TypeError: pathToRegExp.compile is not a function`.
//
// Express + a couple of `sendFile` fallbacks side-steps the entire
// path-to-regexp version soup and works on every Node ≥ 18.
/* eslint-disable no-console */
const path = require("path");
const express = require("express");

const app = express();
const buildDir = path.join(__dirname, "build");
const port = process.env.PORT || 8080;

// Long-cache immutable assets (CRA hashes filenames), no-cache the
// entry HTML so users pick up new deploys on next navigation.
app.use(
  express.static(buildDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      } else if (/\.(js|css|woff2?|ttf|eot|png|jpe?g|gif|svg|ico|webp|avif)$/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);

// SPA fallback — every unmatched GET returns index.html so React Router
// owns the URL. Middleware form (no path pattern) sidesteps
// path-to-regexp entirely regardless of Express major version.
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(buildDir, "index.html"));
});

app.listen(port, () => {
  console.log(`[static-server] listening on http://0.0.0.0:${port}`);
});
