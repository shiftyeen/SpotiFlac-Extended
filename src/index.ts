import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { ExtensionManager } from './manager.js';
import { registerRoutes } from './routes/api.js';
import { AutoTurnstileSolver } from './runtime/auto-solver.js';
import { RetentionCleaner } from './services/retention-cleaner.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  const publicDir = path.resolve(process.cwd(), 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
  });

  const manager = new ExtensionManager();
  await manager.loadInstalled();
  manager.startAutoUpdater(4);
  AutoTurnstileSolver.startSessionKeeper(manager, 10);
  RetentionCleaner.startAutoPurge(30 * 60 * 1000, 24 * 60 * 60 * 1000);

  registerRoutes(app, manager);

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n======================================================`);
    console.log(` WaveX API & Explorer running at: http://localhost:${PORT}`);
    console.log(`======================================================\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

bootstrap();
