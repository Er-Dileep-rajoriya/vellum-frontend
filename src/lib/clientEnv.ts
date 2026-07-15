/**
 * The one place the browser learns where the backend is.
 *
 * `NEXT_PUBLIC_API_URL` is the ONLY backend coordinate the browser ever sees, and it is used two
 * ways: as the REST base (`${base}/api/...`) and, with `http`→`ws`, as the sync WebSocket origin
 * (`${base}/ws`). It is inlined at BUILD time — changing it in the host's env requires a rebuild,
 * not just a restart.
 *
 * This helper exists because the value was read inline in three places with a `?? "http://localhost:4000"`
 * fallback, and that fallback hid a production outage: when the variable was blank in the build, the
 * expression `"" ?? default` keeps `""`, so every call went to the app's OWN origin
 * (`vellum.paperflow.in/api/...`) and returned the Next.js 404 page — which looks like "the API is
 * down" rather than "the API URL is unset". Centralising it lets us:
 *
 *   1. strip a trailing slash, so `https://api.example.com/` does not become `https://api.example.com//api/...`;
 *   2. treat blank as unset (not as same-origin);
 *   3. fail LOUD in production instead of silently calling ourselves.
 */
export function apiBaseUrl(): string {
  const trimmed = process.env["NEXT_PUBLIC_API_URL"]?.trim().replace(/\/+$/, "") ?? "";

  if (trimmed !== "") return trimmed;

  // Dev convenience only: a local backend on the conventional port. Never reached in a real build,
  // where the variable is set.
  if (process.env.NODE_ENV !== "production") return "http://localhost:4000";

  // Production with a blank value is a misconfiguration, not a state to paper over. There is no
  // correct URL to return, so make the reason unmissable in the console rather than letting the
  // browser quietly hit its own origin and 404.
  console.error(
    "NEXT_PUBLIC_API_URL is empty in this build. The browser has no backend to call. " +
      "Set it to the API's public origin in the host env and REBUILD (it is inlined at build time).",
  );
  return "";
}

/** The sync WebSocket origin: the API base with the scheme swapped to ws/wss. */
export function wsBaseUrl(): string {
  return apiBaseUrl().replace(/^http/, "ws");
}
