/** Small shared helpers for the v1 route modules. */
import express from 'express';
import { badRequest } from '../../lib/errors.ts';
import type { ActorRef } from '../../services/records.ts';
import type { Actor } from '../../services/auth.ts';
/**
 * Wraps an async handler so a rejected promise reaches Express's error pipeline.
 *
 * Without this, a `throw` inside an async handler becomes an unhandled rejection:
 * the client gets a hung socket instead of a 500, and the failure is invisible.
 */
export function asyncRoute(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Narrows the authenticated actor into the shape the services take. */
export function actorRef(req: express.Request): ActorRef {
  const actor = req.actor;
  if (!actor) throw badRequest('Not authenticated.');
  return {
    userId: actor.userId,
    organizationId: actor.organizationId,
    role: actor.role,
    email: actor.email,
  };
}

export function actor(req: express.Request): Actor {
  if (!req.actor) throw badRequest('Not authenticated.');
  return req.actor;
}

/** express.Request metadata threaded into audit rows. */
export const meta = (req: express.Request) => ({
  ip: req.clientIp,
  userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
  requestId: req.requestId,
});

/** Reads a bounded integer query parameter. */
export function intParam(req: express.Request, name: string, fallback: number, max: number): number {
  const raw = req.query[name];
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 0), max);
}

export const strParam = (req: express.Request, name: string): string | undefined => {
  const raw = req.query[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v : undefined;
};

/**
 * Collects `?field=value` pairs into a filter object.
 *
 * Only keys that pass `allowed` are kept, and an unrecognised key is an explicit
 * 400 rather than a silent drop — a client that typos a filter must be told, or
 * it will believe it filtered by something it did not.
 */
export function filterParams(req: express.Request, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'limit' || k === 'offset' || k === 'sort' || k === 'order' || k === 'q' || k === 'includeDeleted') continue;
    if (!allowed.includes(k)) throw badRequest(`Unknown filter '${k}'.`);
    const val = Array.isArray(v) ? v[0] : v;
    if (typeof val === 'string' && val !== '') out[k] = val;
  }
  return out;
}
