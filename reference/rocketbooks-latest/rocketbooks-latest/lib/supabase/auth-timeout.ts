// One auth-network budget across browser login, middleware validation, and page
// session resolution. Divergent budgets can accept a cookie in middleware and
// then reject the same user in the page, producing a silent login bounce.
export const SUPABASE_AUTH_TIMEOUT_MS = 10_000;
