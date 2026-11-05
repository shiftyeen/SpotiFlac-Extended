import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { ExtensionRunner } from './runtime/runner.js';
import type { ExtensionManifest, RegistryData, RegistryExtension } from './types.js';

const REGISTRY_URL = 'https://raw.githubusercontent.com/zarzet/SpotiFLAC-Extension/main/registry.json';

export class ExtensionManager {
  private extensionsDir: string;
  private runners = new Map<string, ExtensionRunner>();
  private manifests = new Map<string, ExtensionManifest>();
  private registryCache: RegistryData | null = null;

  constructor(baseDir: string = process.cwd()) {
    this.extensionsDir = path.resolve(baseDir, 'extensions');
    if (!fs.existsSync(this.extensionsDir)) {
      fs.mkdirSync(this.extensionsDir, { recursive: true });
    }
  }

  public async fetchRegistry(force: boolean = false): Promise<RegistryData> {
    if (this.registryCache && !force) return this.registryCache;
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) throw new Error(`Failed to fetch registry: ${res.statusText}`);
    this.registryCache = (await res.json()) as RegistryData;
    return this.registryCache;
  }

  public async loadInstalled(): Promise<void> {
    const entries = fs.readdirSync(this.extensionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const id = entry.name;
        try {
          await this.loadExtension(id);
          console.log(`[ExtensionManager] Loaded extension: ${id}`);
        } catch (e: any) {
          console.error(`[ExtensionManager] Failed to load extension ${id}:`, e.message);
        }
      }
    }
  }

  public async installExtension(id: string): Promise<ExtensionManifest> {
    const registry = await this.fetchRegistry();
    const item = registry.extensions.find((ext) => ext.id === id || ext.name === id);
    if (!item) throw new Error(`Extension '${id}' not found in registry`);

    console.log(`[ExtensionManager] Downloading ${item.display_name} (${item.download_url})...`);
    const resp = await fetch(item.download_url);
    if (!resp.ok) throw new Error(`Failed to download ${item.download_url}: HTTP ${resp.status}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const zip = new AdmZip(buffer);

    const targetDir = path.join(this.extensionsDir, item.id);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    zip.extractAllTo(targetDir, true);
    console.log(`[ExtensionManager] Extracted to ${targetDir}`);

    return await this.loadExtension(item.id);
  }

  public async loadExtension(id: string): Promise<ExtensionManifest> {
    const extDir = path.join(this.extensionsDir, id);
    const manifestPath = path.join(extDir, 'manifest.json');
    const indexPath = path.join(extDir, 'index.js');

    if (!fs.existsSync(manifestPath) || !fs.existsSync(indexPath)) {
      throw new Error(`Extension ${id} is missing manifest.json or index.js`);
    }

    const manifest: ExtensionManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // If an existing runner is active, destroy it
    const existingRunner = this.runners.get(id);
    if (existingRunner) {
      await existingRunner.destroy();
      this.runners.delete(id);
    }

    const runner = new ExtensionRunner({
      extPath: indexPath,
      manifest,
      settings: {},
      debug: false,
    });

    await runner.waitReady();
    this.runners.set(id, runner);
    this.manifests.set(id, manifest);

    return manifest;
  }

  public getRunner(id: string): ExtensionRunner | undefined {
    return this.runners.get(id);
  }

  public getManifest(id: string): ExtensionManifest | undefined {
    return this.manifests.get(id);
  }

  public getInstalled(): Array<{ id: string; manifest: ExtensionManifest }> {
    const list: Array<{ id: string; manifest: ExtensionManifest }> = [];
    for (const [id, manifest] of this.manifests.entries()) {
      list.push({ id, manifest });
    }
    return list;
  }

  public findProviderForUrl(url: string): string | null {
    for (const [id, manifest] of this.manifests.entries()) {
      if (manifest.urlHandler?.enabled && manifest.urlHandler.patterns) {
        for (const pattern of manifest.urlHandler.patterns) {
          if (url.includes(pattern)) return id;
        }
      }
    }
    return null;
  }

  public async autoUpdateAll(): Promise<Array<{ id: string; oldVersion: string; newVersion: string; updated: boolean }>> {
    console.log('[ExtensionManager] 🔄 Verificando actualizaciones automáticas de extensiones...');
    const results: Array<{ id: string; oldVersion: string; newVersion: string; updated: boolean }> = [];
    try {
      const registry = await this.fetchRegistry(true);
      for (const [id, currentManifest] of this.manifests.entries()) {
        const item = registry.extensions.find((ext) => ext.id === id || ext.name === id);
        if (item && item.version) {
          const currentVer = currentManifest.version || '0.0.0';
          const newVer = item.version;
          if (newVer !== currentVer) {
            console.log(`[ExtensionManager] 🚀 Actualizando '${id}': v${currentVer} -> v${newVer}`);
            try {
              await this.installExtension(id);
              results.push({ id, oldVersion: currentVer, newVersion: newVer, updated: true });
            } catch (err: any) {
              console.warn(`[ExtensionManager] Error al actualizar '${id}':`, err.message);
            }
          }
        }
      }
      if (results.length > 0) {
        console.log(`[ExtensionManager] ✅ Se actualizaron ${results.length} extensión(es) automáticamente.`);
      } else {
        console.log('[ExtensionManager] ✨ Todas las extensiones están al día.');
      }
    } catch (e: any) {
      console.warn('[ExtensionManager] No se pudo verificar el registro:', e.message);
    }
    return results;
  }

  public startAutoUpdater(intervalHours: number = 4): void {
    setTimeout(() => {
      this.autoUpdateAll().catch(() => {});
    }, 10000);

    setInterval(() => {
      this.autoUpdateAll().catch(() => {});
    }, intervalHours * 60 * 60 * 1000);
  }
}
