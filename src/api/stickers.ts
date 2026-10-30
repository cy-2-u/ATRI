import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { Store } from '../db/index.js';
import type { Sticker } from '../core/index.js';
import { sniffMediaMime, isVisionMime } from '../ilink/media.js';

/** 表情目录：内置素材 + 自定义上传（存 settings 与 data/custom），最多
 *  同时启用 32 个，全量进提示词的稳定前缀。 */

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
  /** 解析目录内路径并证明没有越出所属基目录：目录正常只由 add() 写入，
   *  被篡改/恢复的数据库不能把图片读取变成任意读。 */
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
  /** 自定义表情可删除；内置只能停用。上传后只停用会把文件永远留在
   *  data/custom，反复上传→停用会无限膨胀且每次备份都带着孤儿。 */
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
    try {
      rmSync(this.resolveFile(item.file).path, { force: true });
    } catch {
      // 文件已不在：settings 才是权威。
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
