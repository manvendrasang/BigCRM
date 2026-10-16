import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
 ApiError,
 api,
 clearTokens,
 resetUnauthenticatedHandler,
 setAccessToken,
 setUnauthenticatedHandler,
} from './api';
import { clearSessionActive, markSessionActive, wasSignedOutOnOpen } from './sessionWindow';

/** The subset of the server's `PublicUser` the UI actually renders. */
export interface SessionUser {
 id: string;
 email: string;
 name: string;
 emailVerified: boolean;
 mfaEnabled: boolean;
}

/** The server's `Actor`: identity plus tenant and role. */
export interface Actor {
 userId: string;
 organizationId: string;
 role: string;
 sessionId: string;
 email: string;
 name: string;
}

/**
 * Normalises the two session shapes the server returns into one `Actor`.
 *
 * `/auth/login`, `/auth/refresh` and `/auth/me` all answer with
 * `{ user, organizationId, role, sessionId? }` at the TOP level -- there is no
 * nested `actor` object. Reading `response.actor` therefore yielded
 * `undefined`, which surfaced as every user being labelled "Member" in the
 * header and a blank organization card on the dashboard.
 */
function toActor(
 response: { user: SessionUser; organizationId?: string; role?: string; sessionId?: string },
): Actor | null {
 const userId = response.user?.id;
 if (!userId) return null;
 return {
 userId,
 organizationId: response.organizationId ?? '',
 role: response.role ?? 'member',
 sessionId: response.sessionId ?? '',
 email: response.user.email,
 name: response.user.name,
 };
}

interface SessionResponse {
 user: SessionUser;
 organizationId?: string;
 role?: string;
 accessToken?: string;
 /** Present only when the account has MFA enabled and a second factor is due. */
 mfaRequired?: boolean;
}

type MeResponse = SessionResponse & { sessionId?: string };

export interface AuthContextValue {
 user: SessionUser | null;
 actor: Actor | null;
 isAuthenticated: boolean;
 isLoading: boolean;
 login: (email: string, password: string) => Promise<void>;
 logout: () => Promise<void>;
 clearError: () => void;
 error: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function describe(error: unknown): string {
 if (error instanceof ApiError) return error.message;
 return 'Something went wrong. Please try again.';
}

/**
 * Session state for the whole app.
 *
 * The session cookie is `HttpOnly`, so JavaScript cannot bootstrap itself from
 * storage. Instead `GET /api/v1/auth/me` runs once on mount: if the cookie is
 * still valid the server answers with the user and we restore the session; if
 * not, the endpoint 401s and `api` transparently attempts a refresh first. This
 * is why a page reload does not sign the user out.
 */
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
 const [user, setUser] = useState<SessionUser | null>(null);
 const [actor, setActor] = useState<Actor | null>(null);
 const [isLoading, setIsLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);

 // `api` escalates to `onUnauthenticated` when a 401 cannot be recovered by a
 // refresh. The default handler performs a full `location.assign`, which tears
 // down the document: the provider remounts, re-probes `/auth/me`, 401s again,
 // and reloads forever. That is the login-page redirect loop. Handling it in
 // React instead clears the session and lets `ProtectedRoute` render a
 // client-side `<Navigate>` -- no reload, and the router keeps its state.
 useEffect(() => {
 setUnauthenticatedHandler(() => {
 setUser(null);
 setActor(null);
 setIsLoading(false);
 });
 return () => {
 resetUnauthenticatedHandler();
 };
 }, []);

 useEffect(() => {
 let cancelled = false;

 // A tab that booted after the window was closed must not reuse the session the
 // dead window left behind. `initSessionWindow` has already fired the logout
 // beacon; probing `/auth/me` here would race it (the cookie stays valid for a
 // few more milliseconds), so the dashboard could render and then vanish.
 // Short-circuiting the probe does not soften the sign-out -- the server
 // revokes the session regardless; it only avoids displaying a session that is
 // already over.
 if (wasSignedOutOnOpen()) {
 clearTokens();
 setUser(null);
 setActor(null);
 setIsLoading(false);
 return;
 }

 // `void` + an explicit catch: without this the IIFE's rejection is an
 // unhandled promise rejection, which in a browser surfaces as a console error
 // and leaves `isLoading` stuck true forever.
 void (async () => {
 try {
 const me = await api.get<MeResponse>('/auth/me', { skipRefresh: false });
 if (cancelled) return;
 setUser(me.user);
 setActor(toActor(me));
 // The cookie outlived the page (a refresh, or the tab was never closed), so a
 // session is live again and a future tab close has to end it.
 markSessionActive();
 } catch {
 // No usable session. Not an error worth showing on first paint.
 if (!cancelled) {
 clearTokens();
 clearSessionActive();
 setUser(null);
 setActor(null);
 }
 } finally {
 if (!cancelled) setIsLoading(false);
 }
 })();

 return () => {
 cancelled = true;
 };
 }, []);

 const login = useCallback(async (email: string, password: string) => {
 setError(null);
 try {
 const session = await api.post<SessionResponse>('/auth/login', { email, password });

 // MFA: the server answers `{ mfaRequired: true, expiresIn }` with NO user
 // and NO token -- the HttpOnly `bigcrm_mfa` cookie authorises only the
 // second factor. Treating that as a session made `isAuthenticated` true
 // (`undefined !== null`) and dropped the user into an empty shell that
 // 401'd on every subsequent call. It is not an error, so it must not
 // throw; it is simply not an authenticated session yet.
 if (session.mfaRequired) {
 clearTokens();
 setUser(null);
 setActor(null);
 return;
 }

 // Memory only -- see the note at the top of api.ts. Never persisted.
 setAccessToken(session.accessToken ?? null);
 setUser(session.user);
 setActor(toActor(session));
 // A session now exists, so closing this window must end it. Set here rather
 // than derived from `actor` because a transient loss of the actor (a failed
 // request, a 401 during a refresh) does not mean the cookie is gone, and
 // clearing the marker then would silently disable the sign-out.
 markSessionActive();
 } catch (err) {
 const message = describe(err);
 setError(message);
 throw err;
 }
 }, []);

 const logout = useCallback(async () => {
 try {
 await api.post('/auth/logout', undefined, { skipRefresh: true });
 } catch {
 // Revoking server-side is best-effort; the local session must still end.
 } finally {
 clearTokens();
 clearSessionActive();
 setUser(null);
 setActor(null);
 }
 }, []);

 const clearError = useCallback(() => setError(null), []);

 const value = useMemo<AuthContextValue>(
 () => ({
 user,
 actor,
 isAuthenticated: user !== null,
 isLoading,
 login,
 logout,
 clearError,
 error,
 }),
 [user, actor, isLoading, login, logout, clearError, error],
 );

 return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Reads the auth context. Throws if used outside `AuthProvider`. */
export function useAuth(): AuthContextValue {
 const context = useContext(AuthContext);
 if (context === null) throw new Error('useAuth must be used within an AuthProvider');
 return context;
}