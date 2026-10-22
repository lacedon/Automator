import Link from 'next/link';
import type { RunRow } from '@core/index';
import { formatDateTime, formatTook } from '../lib/format';
import { EmptyState } from './EmptyState';
import { RunPill } from './Pill';

export function RunsTable({ runs }: { runs: RunRow[] }) {
  if (runs.length === 0) return <EmptyState>No Runs yet.</EmptyState>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>#</th>
          <th>Trigger</th>
          <th>Started</th>
          <th>Took</th>
          <th>Outcome</th>
          <th>Summary</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>
              <Link href={`/runs/${run.id}`}>{run.id}</Link>
            </td>
            <td>{run.trigger}</td>
            <td className="nowrap">{run.startedAt === null ? '—' : formatDateTime(run.startedAt)}</td>
            <td className="nowrap">{run.tookMs === null ? '—' : formatTook(run.tookMs)}</td>
            <td>
              <RunPill run={run} />
            </td>
            <td className="cell-text">
              <Link href={`/runs/${run.id}`} className="plain-link">
                {run.summary ?? run.error?.message ?? '—'}
              </Link>
            </td>
            <td className="nowrap">
              {run.transcriptPath !== null && (
                <a href={`/files/run/${run.id}/transcript.md`} target="_blank" rel="noreferrer">
                  transcript
                </a>
              )}
              {run.transcriptPath !== null && run.resultPath !== null && ' · '}
              {run.resultPath !== null && (
                <a href={`/files/run/${run.id}/result.json`} target="_blank" rel="noreferrer">
                  result
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
