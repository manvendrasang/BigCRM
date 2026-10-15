import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { redirectTargetFrom } from '../lib/redirect';

export function Login(): JSX.Element {
  const { login, isAuthenticated, isLoading, error, clearError } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Already signed in — nothing to show on this page.
  // The destination is validated rather than trusted: `state.from` originates
  // from the URL, and an unvalidated redirect is an open redirect.
  if (!isLoading && isAuthenticated) {
    return <Navigate to={redirectTargetFrom(location.state)} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting) return;

    setFormError(null);
    clearError();

    // Client-side check only. The server re-validates everything and returns a
    // deliberately identical response for bad password and unknown account, so
    // this must not imply anything about account existence.
    if (!email.trim() || !password) {
      setFormError('Enter your email address and password.');
      return;
    }

    setIsSubmitting(true);
    try {
      await login(email.trim(), password);
      // On success the router swaps the route via the redirect above.
    } catch {
      // The provider already surfaced a safe message; nothing to add here.
    } finally {
      setIsSubmitting(false);
    }
  }

  const message = formError ?? error;
  const disabled = isSubmitting || isLoading;

  return (
    <main className="auth-page">
      <section className="card" aria-labelledby="login-heading">
        <h1 id="login-heading">Sign in to BigCRM</h1>
        <p className="card-subtitle">Manage your pipeline, contacts and deals in one place.</p>

        {message !== null && (
          <div className="alert alert-error" role="alert">
            {message}
          </div>
        )}

        <form onSubmit={(e) => { void handleSubmit(e); }} noValidate>
          <div className="field">
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={disabled}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={disabled}
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={disabled}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="card-footer">
          No account yet? <Link to="/register">Create an organization</Link>
        </p>
      </section>
    </main>
  );
}

export default Login;