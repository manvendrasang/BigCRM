import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const MIN_PASSWORD_LENGTH = 12;

interface FieldErrors {
 organizationName?: string;
 name?: string;
 email?: string;
 password?: string;
 confirmPassword?: string;
}

export function Register(): JSX.Element {
 const { register, isLoading, error, clearError } = useAuth();
 const navigate = useNavigate();

 const [organizationName, setOrganizationName] = useState('');
 const [name, setName] = useState('');
 const [email, setEmail] = useState('');
 const [password, setPassword] = useState('');
 const [confirmPassword, setConfirmPassword] = useState('');

 const [isSubmitting, setIsSubmitting] = useState(false);
 const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
 const [formError, setFormError] = useState<string | null>(null);

 function validate(): FieldErrors {
 const next: FieldErrors = {};
 if (!organizationName.trim()) next.organizationName = 'Enter your organization name.';
 if (!name.trim()) next.name = 'Enter your name.';
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = 'Enter a valid email address.';
 if (password.length < MIN_PASSWORD_LENGTH) {
 next.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
 }
 if (confirmPassword !== password) next.confirmPassword = 'Passwords do not match.';
 return next;
 }

 async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
 event.preventDefault();
 if (isSubmitting) return;

 setFormError(null);
 clearError();

 const next = validate();
 setFieldErrors(next);
 if (Object.keys(next).length > 0) return;

 setIsSubmitting(true);
 try {
 await register({
 organizationName: organizationName.trim(),
 name: name.trim(),
 email: email.trim(),
 password,
 });
 // Registration never signs you in -- you must verify your email first.
 navigate('/login', { replace: true });
 } catch {
 // Safe message already surfaced by the provider.
 } finally {
 setIsSubmitting(false);
 }
 }

 const message = formError ?? error;
 const disabled = isSubmitting || isLoading;

 return (
 <main className="auth-page">
 <section className="card" aria-labelledby="register-heading">
 <h1 id="register-heading">Create your organization</h1>
 <p className="card-subtitle">You will be the owner of a new BigCRM workspace.</p>

 {message !== null && (
 <div className="alert alert-error" role="alert">
 {message}
 </div>
 )}

 <form onSubmit={(e) => { void handleSubmit(e); }} noValidate>
 <div className="field">
 <label htmlFor="organizationName">Organization name</label>
 <input
 id="organizationName"
 name="organizationName"
 type="text"
 autoComplete="organization"
 required
 value={organizationName}
 onChange={(event) => setOrganizationName(event.target.value)}
 disabled={disabled}
 aria-invalid={fieldErrors.organizationName !== undefined}
 />
 {fieldErrors.organizationName !== undefined && (
 <p className="field-error">{fieldErrors.organizationName}</p>
 )}
 </div>

 <div className="field">
 <label htmlFor="name">Your name</label>
 <input
 id="name"
 name="name"
 type="text"
 autoComplete="name"
 required
 value={name}
 onChange={(event) => setName(event.target.value)}
 disabled={disabled}
 aria-invalid={fieldErrors.name !== undefined}
 />
 {fieldErrors.name !== undefined && <p className="field-error">{fieldErrors.name}</p>}
 </div>

 <div className="field">
 <label htmlFor="register-email">Work email</label>
 <input
 id="register-email"
 name="email"
 type="email"
 autoComplete="username"
 required
 value={email}
 onChange={(event) => setEmail(event.target.value)}
 disabled={disabled}
 aria-invalid={fieldErrors.email !== undefined}
 />
 {fieldErrors.email !== undefined && <p className="field-error">{fieldErrors.email}</p>}
 </div>

 <div className="field">
 <label htmlFor="register-password">Password</label>
 <input
 id="register-password"
 name="password"
 type="password"
 autoComplete="new-password"
 required
 value={password}
 onChange={(event) => setPassword(event.target.value)}
 disabled={disabled}
 aria-invalid={fieldErrors.password !== undefined}
 />
 {fieldErrors.password !== undefined && <p className="field-error">{fieldErrors.password}</p>}
 </div>

 <div className="field">
 <label htmlFor="confirmPassword">Confirm password</label>
 <input
 id="confirmPassword"
 name="confirmPassword"
 type="password"
 autoComplete="new-password"
 required
 value={confirmPassword}
 onChange={(event) => setConfirmPassword(event.target.value)}
 disabled={disabled}
 aria-invalid={fieldErrors.confirmPassword !== undefined}
 />
 {fieldErrors.confirmPassword !== undefined && (
 <p className="field-error">{fieldErrors.confirmPassword}</p>
 )}
 </div>

 <button type="submit" className="btn btn-primary" disabled={disabled}>
 {isSubmitting ? 'Creating...' : 'Create organization'}
 </button>
 </form>

 <p className="card-footer">
 Already registered? <Link to="/login">Sign in</Link>
 </p>
 </section>
 </main>
 );
}

export default Register;