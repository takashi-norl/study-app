import 'server-only';

/** Read-only compatibility for existing deployments; never change persisted workspace or account IDs. */
export function workspaceIdSetting(): string {
  return process.env.WORKSPACE_ID?.trim() || process.env.FAMILY_ID?.trim() || 'family-primary';
}

/** A configured canonical value wins, including an invalid empty value that must fail closed. */
export function registeredAccountsSetting(): string | undefined {
  return process.env.REGISTERED_ACCOUNTS_JSON ?? process.env.ALLOWED_FAMILY_MEMBERS_JSON;
}

/** Preserve concurrency keys already used by in-flight workers and retry receipts. */
export function persistedPaidWorkSlotId(digest: string): string {
  return `family-paid-slot:${digest}`;
}
