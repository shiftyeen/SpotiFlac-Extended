import { ExtensionManager } from '../src/manager.js';

async function installAll() {
  console.log('Fetching registry and installing all extensions...');
  const manager = new ExtensionManager();
  const registry = await manager.fetchRegistry();

  console.log(`Found ${registry.extensions.length} extensions in registry.`);

  for (const ext of registry.extensions) {
    console.log(`\nInstalling ${ext.display_name} (${ext.id})...`);
    try {
      const manifest = await manager.installExtension(ext.id);
      console.log(` Successfully installed ${manifest.displayName || manifest.name} (v${manifest.version})`);
    } catch (err: any) {
      console.error(` Failed to install ${ext.id}:`, err.message);
    }
  }

  console.log('\nAll extensions installation process completed!');
  process.exit(0);
}

installAll().catch((err) => {
  console.error('Fatal error during installation:', err);
  process.exit(1);
});
