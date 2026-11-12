'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { signIn } from '../actions/auth';
import { ErrorBox } from './ErrorBox';

export function LoginForm({ next }: { next: string }) {
  const t = useTranslations('Login');
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} className="login-form">
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="login-username">{t('username')}</label>
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
        <label htmlFor="login-password">{t('password')}</label>
        <input id="login-password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state !== null && <ErrorBox error={state.error} />}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {t('signIn')}
      </button>
    </form>
  );
}
