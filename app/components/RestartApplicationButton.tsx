'use client';

import { useState } from 'react';
import { requestApplicationRestart } from '../actions/restart';
import { ConfirmDialog } from './ConfirmDialog';

export function RestartApplicationButton() {
  const [accepted, setAccepted] = useState(false);

  const restart = async () => {
    setAccepted(false);
    const result = await requestApplicationRestart();
    if (result.ok && result.value?.accepted) setAccepted(true);
    return result;
  };

  return (
    <>
      <ConfirmDialog
        label="Restart Application"
        message="Restart the application? Active work will drain before it starts again."
        confirmLabel="Restart"
        action={restart}
        danger
      />
      {accepted && (
        <p className="success-box" role="status">
          Restart accepted. Active work is draining before the application restarts.
        </p>
      )}
    </>
  );
}
