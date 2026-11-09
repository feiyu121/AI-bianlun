import { mkdir, writeFile, rename, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

export async function readSave(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export class Storage {
  constructor(filename) { this.filename = filename; this.pending = Promise.resolve(); }
  save(value) {
    // 写入串行化，临时文件和目标文件在同一磁盘，rename 原子替换。
    const json = JSON.stringify(value, null, 2);
    const job = this.pending.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true });
      const tmp = this.filename + '.tmp';
      await writeFile(tmp, json, 'utf8');
      await rename(tmp, this.filename);
    });
    this.pending = job;
    return job;
  }
  async backup(value) {
    await this.save(value);
    const directory = path.join(path.dirname(this.filename), 'backups');
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, `session-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);
    await copyFile(this.filename, filename);
    return filename;
  }
}
