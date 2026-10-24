// An in-memory PostgreSQL WASM instance, with a real wire protocol and pgvector.
// This exercises SQL and transactions, not Docker deployment or multi-user concurrency.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = resolve(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const port = Number(process.env.KIWI_PG_TEST_PORT || 55432);
const db = await PGlite.create({ extensions: { vector } });
const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 2 });
try {
  await server.start();
  console.log((await db.query('SELECT version()')).rows[0]);
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(existsSync(python) ? python : 'python', ['-X', 'utf8', '-m', 'pytest', 'backend/tests/test_postgres.py', '-q', '-o', 'cache_dir=.local/pytest-cache-pg'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, KIWI_TEST_DATABASE_URL: `postgresql+psycopg://postgres@127.0.0.1:${port}/kiwi_test?sslmode=disable` },
    });
    child.on('error', reject);
    child.on('exit', resolveCode);
  });
  process.exitCode = code ?? 1;
  console.log((await db.query("SELECT extversion AS pgvector_version FROM pg_extension WHERE extname='vector'")).rows[0]);
} finally {
  await server.stop();
  await db.close();
}
