import { cp, mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'react/vite.config.mjs', '--configLoader', 'runner']);

// Vite成果物へ、現行画面が参照する画像・公開設定・補助ページを同じパスで配置する。
await mkdir('dist/assets', { recursive: true });
for (const entry of await readdir('assets')) {
  await cp(`assets/${entry}`, `dist/assets/${entry}`, { recursive: true, force: true });
}
await cp('manifest.json', 'dist/manifest.json', { force: true });
console.log('React版フロントエンドをdistへ出力しました。');
