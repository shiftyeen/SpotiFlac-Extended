// ============================================================
// SpotiFLAC Extended — Node.js Launcher for PaaS Platforms
// ============================================================

const { spawn } = require('child_process');
const path = require('path');

const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || '8000';

console.log(`\n[SpotiFLAC Launcher] Starting SpotiFLAC Extended Python Server...`);
console.log(`Host: ${host} | Port: ${port}\n`);

const serverPyPath = path.join(__dirname, 'server.py');
const child = spawn('python', [serverPyPath, '--host', host, '--port', String(port)], {
  cwd: __dirname,
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  },
});

child.on('error', (err) => {
  console.error(`[SpotiFLAC Launcher] Error running python: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.log(`[SpotiFLAC Launcher] Process exited (code: ${code}, signal: ${signal})`);
  process.exit(code || 0);
});
