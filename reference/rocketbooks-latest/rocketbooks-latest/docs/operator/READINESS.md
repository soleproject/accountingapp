# Rocket Suite operator readiness surface

## Endpoints

- `GET /api/health` — lightweight app/runtime health. Returns 200 when the app handler is alive.
- `GET /api/readiness` — production-readiness checks. Verifies DB reachability with `select 1` and reports required/optional integration environment presence without printing secret values.

## Expected use

Before partner testing or after deploy:

```bash
curl -fsS https://app.rocketsuite.ai/api/health | jq .
curl -fsS https://app.rocketsuite.ai/api/readiness | jq .
```

`/api/readiness` may return HTTP 503 when required dependencies are missing or the DB cannot be reached. Optional integrations report missing envs in the JSON `checks` array so operators can see why a specific feature is disabled or degraded.

## Secret safety

The readiness response only reports variable names and high-level status. It never returns connection strings, API keys, webhook secrets, JWT secrets, customer records, or SQL text.

## Dispatch evidence

Implemented for Dispatch row `24dd9b27-a243-4ddc-8f04-5de26fc01216` after row `0d84d70f-42a4-4cb8-82a4-8821ce064521` restored real repo/build evidence.
