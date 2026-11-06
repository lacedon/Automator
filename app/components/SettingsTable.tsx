import type { ReactNode } from 'react';

type Props = {
  label: string;
  headers: [string, string, string?];
  children: ReactNode;
};

/** Zebra-striped Settings entity list: Entity name, details, optional row actions. */
export function SettingsTable({ label, headers, children }: Props) {
  const [name, details, actions] = headers;
  return (
    <table className="table zebra-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{name}</th>
          <th scope="col">{details}</th>
          {actions !== undefined && (
            <th scope="col">
              <span className="sr-only">{actions}</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function SettingsTableRow({
  name,
  actions,
  children,
}: {
  name: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <tr>
      <th scope="row" className="entity-name">
        {name}
      </th>
      <td>{children}</td>
      {actions !== undefined && (
        <td>
          <div className="row-actions">{actions}</div>
        </td>
      )}
    </tr>
  );
}
