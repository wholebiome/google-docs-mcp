// Returns true when destructive (delete/trash) tools should be skipped at
// registration time. Toggled via the DISABLE_DESTRUCTIVE_TOOLS env var.
// Accepted truthy values (case-insensitive): "1", "true", "yes", "on".
export function destructiveDisabled(): boolean {
  const v = process.env.DISABLE_DESTRUCTIVE_TOOLS;
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}
