# Deployment

This stack does not include a bundled web server. The host web server should terminate TLS and forward requests to the loopback-bound dashboard and API services.

Default local endpoints:

- Dashboard: 127.0.0.1:3001
- API: 127.0.0.1:3000
- Grafana: 127.0.0.1:3002
- Prometheus: 127.0.0.1:9090

MongoDB and Redis are available only on private Docker networks.

Keep application ports bound to 127.0.0.1. Route dashboard traffic to port 3001 and preserve the /api path when forwarding API requests to port 3000. Configure streaming and long timeouts for export downloads.

In production, Swagger and OpenAPI are disabled inside the application. Startup fails if either documentation flag is enabled while NODE_ENV is production.
