/** Prometheus metrics. Opt-in and unauthenticated only when explicitly enabled. */
import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { env } from '../config/env.ts';

const registry = new Registry();
registry.setDefaultLabels({ service: 'bigcrm-api', env: env.envName });

export const httpRequests = new Counter({
 name: 'http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'status'], registers: [registry],
});
export const httpDuration = new Histogram({
 name: 'http_request_duration_seconds', help: 'HTTP latency', labelNames: ['method', 'route'],
 buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
});
export const authFailures = new Counter({
 name: 'auth_failures_total', help: 'Auth failures', labelNames: ['reason'], registers: [registry],
});
export const permissionDenials = new Counter({
 name: 'permission_denials_total', help: 'RBAC denials', labelNames: ['permission'], registers: [registry],
});
export const tenantDenials = new Counter({
 name: 'tenant_denials_total', help: 'Cross-tenant access denials', labelNames: ['resource'], registers: [registry],
});
export const rateLimited = new Counter({
 name: 'rate_limited_total', help: 'Rate-limited requests', labelNames: ['bucket'], registers: [registry],
});
export const dbQueryDuration = new Histogram({
 name: 'db_query_duration_seconds', help: 'DB latency', labelNames: ['op'],
 buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 3], registers: [registry],
});
export const jobsProcessed = new Counter({
 name: 'jobs_processed_total', help: 'Background jobs', labelNames: ['job', 'outcome'], registers: [registry],
});
export const queueDepth = new Gauge({ name: 'queue_depth', help: 'Pending jobs', registers: [registry] });

export const metricsText = async (): Promise<string> => registry.metrics();
export const metricsRegistry = registry;
