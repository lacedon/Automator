'use client';

// Shown when a page or Server Action throws unexpectedly (for example SQLITE_BUSY); details are in the server log.
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="error-box" role="alert">
      <div className="error-title">Something went wrong</div>
      <p>{error.message || 'Unexpected error.'}</p>
      {error.digest !== undefined && (
        <p className="muted">Error digest {error.digest}: see the dashboard log for details.</p>
      )}
      <p>
        <button type="button" className="btn btn-secondary" onClick={() => retry()}>
          Try again
        </button>
      </p>
    </div>
  );
}
