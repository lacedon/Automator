import type { Database } from '../db/open';
import { err, ok, type Result } from '../domain/result';
import { DEFAULT_COLOR_SCHEME, isColorSchemeId, resolveColorScheme, type ColorSchemeId } from './colorSchemes';

const COLOR_SCHEME = 'colorScheme';

// Application-wide settings and per-user settings, both stored in the database as key/value pairs so more
// settings can be added later.
export class SettingsService {
  constructor(private readonly db: Database) {}

  applicationColorScheme(): ColorSchemeId {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(COLOR_SCHEME) as
      { value: string } | undefined;
    return isColorSchemeId(row?.value) ? row.value : DEFAULT_COLOR_SCHEME;
  }

  setApplicationColorScheme(scheme: string): Result<void> {
    if (!isColorSchemeId(scheme))
      return err({ code: 'INVALID_INPUT', field: 'colorScheme', message: 'Unknown color scheme' });
    this.db
      .prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(COLOR_SCHEME, scheme);
    return ok(undefined);
  }

  // The user's own choice, or null when they use the application default.
  userColorScheme(userId: number): ColorSchemeId | null {
    const row = this.db
      .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, COLOR_SCHEME) as { value: string } | undefined;
    return isColorSchemeId(row?.value) ? row.value : null;
  }

  // `null` clears the user's choice so the application default applies again.
  setUserColorScheme(userId: number, scheme: string | null): Result<void> {
    if (scheme === null) {
      this.db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, COLOR_SCHEME);
      return ok(undefined);
    }
    if (!isColorSchemeId(scheme))
      return err({ code: 'INVALID_INPUT', field: 'colorScheme', message: 'Unknown color scheme' });
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(userId, COLOR_SCHEME, scheme);
    return ok(undefined);
  }

  // What a given user (or a signed-out visitor, with null) actually sees.
  effectiveColorScheme(userId: number | null): ColorSchemeId {
    return resolveColorScheme(userId === null ? null : this.userColorScheme(userId), this.applicationColorScheme());
  }
}
