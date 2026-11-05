export interface ExtensionManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  homepage?: string;
  type: string[];
  minAppVersion?: string;
  capabilities?: {
    homeFeed?: boolean;
    browseCategories?: boolean;
    shareUrlTemplates?: Record<string, string>;
    [key: string]: any;
  };
  permissions?: {
    network?: string[];
    storage?: boolean;
    file?: boolean;
  };
  qualityOptions?: Array<{
    id: string;
    label: string;
    description: string;
    kind: string;
  }>;
  urlHandler?: {
    enabled: boolean;
    patterns: string[];
  };
  settings?: any[];
}

export interface RegistryExtension {
  id: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  download_url: string;
  sha256: string;
  category: string;
  tags: string[];
  updated_at: string;
  min_app_version: string;
  icon_url?: string;
}

export interface RegistryData {
  version: number;
  updated_at: string;
  extensions: RegistryExtension[];
}

export interface TrackMetadata {
  id: string;
  name: string;
  artists: string[] | string;
  album_name?: string;
  album_id?: string;
  duration_ms?: number;
  release_date?: string;
  isrc?: string;
  explicit?: boolean;
  cover_url?: string;
  [key: string]: any;
}
