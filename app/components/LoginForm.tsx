'use client';

import { useActionState } from 'react';
import { signIn } from '../actions/auth';
import { ErrorBox } from './ErrorBox';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} className="login-form">
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          name="username"
          autoComplete="username"
          defaultValue={state?.values.username ?? ''}
          required
          autoFocus
        />
      </div>
      <div className="field">
        <label htmlFor="login-password">Password</label>
        <input id="login-password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state !== null && <ErrorBox error={state.error} />}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        Sign in
      </button>
    </form>
  );
}
