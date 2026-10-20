import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { Store } from '@atri/db';
import type { Sticker } from '@atri/core';
import { sniffMediaMime, isVisionMime } from '@atri/ilink';

export class Stickers {
  private builtins?: Sticker[];
  constructor(
    readonly root: string,
    readonly dataDir: string,
    private readonly store: Store,
  ) {}
  private catalog(): Sticker[] {
    this.builtins ??= JSON.parse(
      readFileSync(join(this.root, 'assets', 'stickers', 'catalog.json'), 'utf8'),
    ) as Sticker[];
    return this.builtins;
  }
  list(includeDisabled = false): (Sticker & { disabled: boolean })[] {
    const disabled = new Set(this.store.getSetting<string[]>('stickers:disabled', []));
    return [...this.catalog(), ...this.store.getSetting<Sticker[]>('stickers:custom', [])]
      .map((s) => ({ ...s, disabled: disabled.has(s.slug) }))
      .filter((s) => includeDisabled || !s.disabled);
  }
  /** Resolve a catalog path and prove it stays inside its own base directory.
   *  The catalog is normally written only by add(), but a restored or tampered
   *  database must not be able to turn an image lookup into an arbitrary read. */
  private resolveFile(file: string): { base: string; path: string } {
    const base = file.startsWith('custom/')
      ? join(this.dataDir, 'custom')
      : join(this.root, 'assets', 'stickers');
    const path = resolve(base, file.startsWith('custom/') ? file.slice('custom/'.length) : file);
    if (path === resolve(base) || !path.startsWith(resolve(base) + sep))
      throw new Error('表情路径无效');
    return { base, path };
  }
  bytes(slug: string): Buffer {
    const item = this.list(true).find((s) => s.slug === slug);
    if (!item) throw new Error('表情不存在');
    const { path } = this.resolveFile(item.file);
    const bytes = readFileSync(path);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('表情文件过大');
    return bytes;
  }
  add(input: { slug: string; description: string; tags: string[]; base64: string }) {
    if (
      !/^[a-z0-9_-]{1,40}$/.test(input.slug) ||
      this.list(true).some((s) => s.slug === input.slug)
    )
      throw new Error('表情 slug 无效或已经存在');
    if (this.list().length >= 32) throw new Error('最多启用 32 个表情，请先停用不常用的素材');
    if (!input.description.trim() || input.description.length > 200)
      throw new Error('请填写不超过 200 字的表情含义');
    const bytes = Buffer.from(input.base64, 'base64'),
      mime = sniffMediaMime(bytes);
    if (!bytes.length || bytes.length > 3 * 1024 * 1024 || !isVisionMime(mime))
      throw new Error('支持 3 MB 以内的 PNG、JPEG、GIF、WebP');
    const file = `custom/${randomUUID()}.${mime!.split('/')[1]}`;
    mkdirSync(join(this.dataDir, 'custom'), { recursive: true });
    writeFileSync(join(this.dataDir, file), bytes);
    const list = this.store.getSetting<Sticker[]>('stickers:custom', []);
    list.push({
      slug: input.slug,
      description: input.description,
      tags: input.tags.slice(0, 8).map((tag) => tag.slice(0, 40)),
      file,
    });
    this.store.setSetting('stickers:custom', list);
  }
  disable(slug: string) {
    if (!this.list(true).some((s) => s.slug === slug)) throw new Error('表情不存在');
    this.store.setSetting('stickers:disabled', [
      ...new Set([...this.store.getSetting<string[]>('stickers:disabled', []), slug]),
    ]);
  }
  /** Custom stickers can be deleted outright; built-in ones only disabled.
   *  "Disable" on an uploaded file used to leave the image on disk forever, and
   *  the 32-item cap counts enabled stickers, so upload→disable→upload grew
   *  data/custom without bound and every backup carried the orphans. */
  remove(slug: string) {
    const custom = this.store.getSetting<Sticker[]>('stickers:custom', []);
    const item = custom.find((s) => s.slug === slug);
    if (!item) throw new Error('内置表情不能删除，只能停用');
    this.store.setSetting(
      'stickers:custom',
      custom.filter((s) => s.slug !== slug),
    );
    this.store.setSetting(
      'stickers:disabled',
      this.store.getSetting<string[]>('stickers:disabled', []).filter((s) => s !== slug),
    );
    // The file may already be gone; the setting is the source of truth.
    try {
      rmSync(this.resolveFile(item.file).path, { force: true });
    } catch {
      // Losing the file is not worth failing the delete.
    }
  }
  enable(slug: string) {
    const item = this.list(true).find((s) => s.slug === slug);
    if (!item) throw new Error('表情不存在');
    if (!item.disabled) return;
    if (this.list().length >= 32) throw new Error('最多启用 32 个表情，请先停用不常用的素材');
    this.store.setSetting(
      'stickers:disabled',
      this.store.getSetting<string[]>('stickers:disabled', []).filter((s) => s !== slug),
    );
  }
}
