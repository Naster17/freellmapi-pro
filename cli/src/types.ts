export interface CatalogModel {
  id: string;
  name?: string;
  context_window?: number | null;
  context_length?: number | null;
  available?: boolean;
}

export interface GeneratedFile {
  path: string;
  format: 'json' | 'toml' | 'yaml' | 'env';
  value?: Record<string, unknown>;
  content?: string;
  sensitive?: boolean;
}

export interface GenerateContext {
  url: string;
  apiKey: string;
  profile: string;
  models: CatalogModel[];
  homeDir: string;
}

export interface Generation {
  files: GeneratedFile[];
  notes: string[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  category: 'code' | 'agent';
  configType: 'env' | 'file' | 'guide';
  protocol: string;
  baseUrlSupport: 'root' | '/v1';
  command: string;
  docsUrl: string;
  generate(ctx: GenerateContext): Generation;
}
