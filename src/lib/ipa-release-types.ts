export type IpaMetadata = {
  name: string; bundle: string; version: string; build: string; sourceSha256: string;
  blankIdentity: boolean;
};
export type IpaRelease = {
  id: string; label: string; notes: string | null; source_sha256: string;
  size_bytes: string; metadata: IpaMetadata; state: "active" | "archived";
  version: number; created_at: string; installation_count?: string;
};
export type IpaReleaseList = { items: IpaRelease[]; total: number; page: number; pages: number };
