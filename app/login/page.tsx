import { redirect } from 'next/navigation';
import { LoginForm } from '../components/LoginForm';
import { Logo } from '../components/Logo';
import { safeNext } from '../lib/safeNext';
import { currentUser } from '../lib/session';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if ((await currentUser()) !== null) redirect(next);
  return (
    <div className="login">
      <h1>
        <Logo /> Automator
      </h1>
      <LoginForm next={next} />
    </div>
  );
}
