// The iLink protocol suite: crypto, header construction, inbound parsing,
// media sniffing, outbound media sends and the typing indicator.
//
// These used to live as six `.test.ts` files inside packages/ilink/src, so the
// one package with its own protocol quirks was also the one package whose tests
// sat outside tests/. They import through the public `@atri/ilink` entry point
// now, which additionally proves every helper the tests need is actually
// exported.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ILinkClient,
  ITEM_TYPE,
  UPLOAD_MEDIA_TYPE,
  aesEcbPaddedSize,
  buildILinkHeaders,
  decryptAes128Ecb,
  encodeAesKeyField,
  encryptAes128Ecb,
  extractMediaRefs,
  extractText,
  isAllowedMediaUrl,
  isMediaOnlyWithoutText,
  isVisionMime,
  mediaKindLabel,
  md5Hex,
  parseAesKey,
  randomAesKey,
  randomWechatUinHeader,
  sniffMediaMime,
} from '@atri/ilink';
import type { InboundMediaRef, WeixinMessage } from '@atri/ilink';

// ---------------------------------------------------------------------------
// crypto
// ---------------------------------------------------------------------------

describe('ilink crypto', () => {
  it('round-trips AES-128-ECB PKCS7', () => {
    const key = randomAesKey();
    const plain = Buffer.from('hello wechat sticker 😊', 'utf8');
    const cipher = encryptAes128Ecb(plain, key);
    assert.equal(cipher.length, aesEcbPaddedSize(plain.length));
    assert.deepEqual(decryptAes128Ecb(cipher, key), plain);
  });

  it('pads empty buffer to 16 bytes', () => {
    const key = randomAesKey();
    const cipher = encryptAes128Ecb(Buffer.alloc(0), key);
    assert.equal(cipher.length, 16);
    assert.deepEqual(decryptAes128Ecb(cipher, key), Buffer.alloc(0));
  });

  it('md5Hex is stable', () => {
    assert.equal(md5Hex(Buffer.from('abc')), '900150983cd24fb0d6963f7d28e17f72');
  });

  it('encode/parse aes_key field (base64 of hex ascii)', () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const field = encodeAesKeyField(key);
    assert.deepEqual(parseAesKey(field), key);
  });

  it('parseAesKey accepts raw 16-byte base64', () => {
    const key = randomAesKey();
    const field = key.toString('base64');
    assert.deepEqual(parseAesKey(field), key);
  });

  it('parseAesKey accepts bare hex', () => {
    const hex = '00112233445566778899aabbccddeeff';
    assert.deepEqual(parseAesKey(hex), Buffer.from(hex, 'hex'));
  });
});

// ---------------------------------------------------------------------------
// headers
// ---------------------------------------------------------------------------

describe('ilink headers', () => {
  it('generates base64 wechat uin', () => {
    const h = randomWechatUinHeader();
    assert.ok(h.length > 0);
    const decoded = Buffer.from(h, 'base64').toString('utf8');
    assert.match(decoded, /^\d+$/);
  });

  it('includes bearer when token present', () => {
    const h = buildILinkHeaders('tok');
    assert.equal(h.Authorization, 'Bearer tok');
    assert.equal(h.AuthorizationType, 'ilink_bot_token');
  });
});

// ---------------------------------------------------------------------------
// inbound text extraction
// ---------------------------------------------------------------------------

describe('extractText', () => {
  it('reads text items', () => {
    assert.equal(extractText({ item_list: [{ type: 1, text_item: { text: '你好' } }] }), '你好');
  });

  it('reads voice transcript when present', () => {
    assert.equal(
      extractText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } } as never] }),
      '语音转写',
    );
  });

  it('detects media-only without text', () => {
    const msg = { item_list: [{ type: 2, image_item: {} } as never] };
    assert.equal(extractText(msg), null);
    assert.equal(isMediaOnlyWithoutText(msg), true);
  });

  describe('includeVoiceTranscript', () => {
    const voiceMsg = { item_list: [{ type: 3, voice_item: { text: '语音转写' } } as never] };

    it('uses the transcript by default', () => {
      assert.equal(extractText(voiceMsg), '语音转写');
      assert.equal(extractText(voiceMsg, { includeVoiceTranscript: true }), '语音转写');
    });

    it('ignores the transcript when disabled', () => {
      assert.equal(extractText(voiceMsg, { includeVoiceTranscript: false }), null);
      // The voice note then counts as unreadable media, which is what makes the
      // worker answer "didn't catch that" instead of chatting.
      assert.equal(isMediaOnlyWithoutText(voiceMsg, { includeVoiceTranscript: false }), true);
    });

    it('still reads real text items when transcripts are disabled', () => {
      const mixed = {
        item_list: [
          { type: 1 as const, text_item: { text: '看这个' } },
          { type: 3, voice_item: { text: '语音转写' } } as never,
        ],
      };
      assert.equal(extractText(mixed, { includeVoiceTranscript: false }), '看这个');
      assert.equal(extractText(mixed), '看这个\n语音转写');
    });
  });
});

// ---------------------------------------------------------------------------
// mime sniffing and inbound media refs
// ---------------------------------------------------------------------------

function bytes(...b: number[]): Buffer {
  return Buffer.from(b);
}

function withAscii(text: string, pad = 0): Buffer {
  const head = Buffer.alloc(pad);
  return Buffer.concat([head, Buffer.from(text, 'latin1')]);
}

describe('sniffMediaMime', () => {
  it('identifies images', () => {
    assert.equal(
      sniffMediaMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
      'image/png',
    );
    assert.equal(sniffMediaMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
    assert.equal(sniffMediaMime(withAscii('GIF89a....')), 'image/gif');
    assert.equal(sniffMediaMime(Buffer.concat([Buffer.from('RIFF____WEBPVP8 ')])), 'image/webp');
    assert.equal(sniffMediaMime(withAscii('BM______')), 'image/bmp');
  });

  it('identifies WeChat voice containers', () => {
    // Bare SILK tag and the variant with one leading byte both appear in the wild
    assert.equal(sniffMediaMime(withAscii('#!SILK_V3')), 'audio/silk');
    assert.equal(sniffMediaMime(withAscii('#!SILK_V3', 1)), 'audio/silk');
    assert.equal(sniffMediaMime(withAscii('#!AMR\n')), 'audio/amr');
  });

  it('splits ISO-BMFF into audio vs video by brand', () => {
    assert.equal(sniffMediaMime(Buffer.from('____ftypM4A ', 'latin1')), 'audio/mp4');
    assert.equal(sniffMediaMime(Buffer.from('____ftypisom', 'latin1')), 'video/mp4');
  });

  it('distinguishes RIFF/WAVE from RIFF/WEBP', () => {
    assert.equal(sniffMediaMime(Buffer.from('RIFF____WAVEfmt ', 'latin1')), 'audio/wav');
  });

  it('returns null for unknown or too-short buffers', () => {
    assert.equal(sniffMediaMime(Buffer.alloc(0)), null);
    assert.equal(sniffMediaMime(bytes(1, 2)), null);
    assert.equal(sniffMediaMime(Buffer.from('not media at all')), null);
  });
});

describe('isVisionMime', () => {
  it('accepts only what an OpenAI-compatible image_url can carry', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
      assert.equal(isVisionMime(m), true, m);
    for (const m of ['image/bmp', 'audio/silk', 'video/mp4', null, undefined])
      assert.equal(isVisionMime(m), false, String(m));
  });
});

describe('extractMediaRefs', () => {
  it('returns nothing for text-only messages', () => {
    const msg: WeixinMessage = { item_list: [{ type: 1, text_item: { text: '你好' } }] };
    assert.deepEqual(extractMediaRefs(msg), []);
  });

  it('reads image CDN coordinates', () => {
    const msg: WeixinMessage = {
      item_list: [
        {
          type: 2,
          image_item: {
            media: { encrypt_query_param: 'eqp-1', aes_key: 'a'.repeat(32), encrypt_type: 1 },
            mid_size: 4096,
          },
        },
      ],
    };
    const refs = extractMediaRefs(msg);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.kind, 'image');
    assert.equal(refs[0]!.index, 0);
    assert.equal(refs[0]!.encryptQueryParam, 'eqp-1');
    assert.equal(refs[0]!.aesKey, 'a'.repeat(32));
    assert.equal(refs[0]!.encryptType, 1);
    assert.equal(refs[0]!.cipherSize, 4096);
  });

  it('falls back to item-level aeskey and url', () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: 2, image_item: { aeskey: 'b'.repeat(32), url: 'https://cdn.example/img' } },
      ],
    };
    const refs = extractMediaRefs(msg);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.aesKey, 'b'.repeat(32));
    assert.equal(refs[0]!.fullUrl, 'https://cdn.example/img');
  });

  it('carries the iLink voice transcript through', () => {
    const msg: WeixinMessage = {
      item_list: [
        {
          type: 3,
          voice_item: { media: { encrypt_query_param: 'eqp-v' }, voice_text: '  语音转写  ' },
        },
      ],
    };
    const refs = extractMediaRefs(msg);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.kind, 'voice');
    assert.equal(refs[0]!.transcript, '语音转写');
  });

  it('skips media-less items', () => {
    const msg: WeixinMessage = { item_list: [{ type: 2, image_item: {} }] };
    assert.deepEqual(extractMediaRefs(msg), []);
  });

  it('probes sub-objects when the item type number is unexpected', () => {
    // Item types 4/5 are inferred; a mis-numbered item that plainly carries a
    // file_item must still be picked up rather than dropped on the number.
    const msg: WeixinMessage = {
      item_list: [
        {
          type: 9 as never,
          file_item: { media: { encrypt_query_param: 'eqp-f' }, file_name: 'report.pdf' },
        },
      ],
    };
    const refs = extractMediaRefs(msg);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.kind, 'file');
    assert.equal(refs[0]!.fileName, 'report.pdf');
  });

  it('keeps item order and index across a mixed message', () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: 1, text_item: { text: '看这个' } },
        { type: 2, image_item: { media: { encrypt_query_param: 'a' } } },
        { type: 2, image_item: { media: { encrypt_query_param: 'b' } } },
      ],
    };
    assert.deepEqual(
      extractMediaRefs(msg).map((r) => [r.index, r.encryptQueryParam]),
      [
        [1, 'a'],
        [2, 'b'],
      ],
    );
  });
});

describe('mediaKindLabel', () => {
  it('labels every kind', () => {
    assert.equal(mediaKindLabel('image'), '图片');
    assert.equal(mediaKindLabel('voice'), '语音');
    assert.equal(mediaKindLabel('video'), '视频');
    assert.equal(mediaKindLabel('file'), '文件');
  });
});

describe('isAllowedMediaUrl', () => {
  const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';

  it('allows the configured CDN base host', () => {
    assert.equal(
      isAllowedMediaUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1', { cdnBaseUrl: CDN }),
      true,
    );
  });

  it('allows other WeChat / QQ CDN subdomains', () => {
    for (const u of [
      'https://mmbiz.qpic.weixin.qq.com/a.jpg',
      'https://wx.qq.com/x',
      'https://other.cdn.weixin.qq.com/y',
    ])
      assert.equal(isAllowedMediaUrl(u, { cdnBaseUrl: CDN }), true, u);
  });

  it('rejects an arbitrary external host', () => {
    assert.equal(isAllowedMediaUrl('https://evil.example/payload.png', { cdnBaseUrl: CDN }), false);
  });

  it('rejects loopback, private ranges and cloud metadata', () => {
    // These are the SSRF targets that matter on a box that also talks to Redis.
    for (const host of [
      '127.0.0.1',
      'localhost',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.5.5',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      'metadata.google.internal',
      'redis.local',
      '[::1]',
    ])
      assert.equal(isAllowedMediaUrl(`http://${host}/x`, { cdnBaseUrl: CDN }), false, host);
  });

  it('still allows public 172.x outside the private block', () => {
    assert.equal(
      isAllowedMediaUrl('http://172.32.0.1/x', {
        cdnBaseUrl: CDN,
        extraHosts: ['172.32.0.1'],
      }),
      true,
    );
    assert.equal(isAllowedMediaUrl('http://172.15.0.1/x', { extraHosts: ['172.15.0.1'] }), true);
  });

  it('rejects non-http schemes and embedded credentials', () => {
    for (const u of [
      'file:///etc/passwd',
      'gopher://novac2c.cdn.weixin.qq.com/x',
      'data:image/png;base64,AAAA',
      'https://user:pass@novac2c.cdn.weixin.qq.com/x',
    ])
      assert.equal(isAllowedMediaUrl(u, { cdnBaseUrl: CDN }), false, u);
  });

  it('rejects unparseable input', () => {
    assert.equal(isAllowedMediaUrl('not a url', { cdnBaseUrl: CDN }), false);
    assert.equal(isAllowedMediaUrl('', { cdnBaseUrl: CDN }), false);
  });

  it('honours an explicit extra host', () => {
    assert.equal(
      isAllowedMediaUrl('https://my-mirror.test/x', {
        cdnBaseUrl: CDN,
        extraHosts: [' My-Mirror.test '],
      }),
      true,
    );
  });

  it('survives a malformed configured base', () => {
    assert.equal(isAllowedMediaUrl('https://x.weixin.qq.com/a', { cdnBaseUrl: '::::' }), true);
    assert.equal(isAllowedMediaUrl('https://evil.example/a', { cdnBaseUrl: '::::' }), false);
  });
});

// ---------------------------------------------------------------------------
// outbound media
// ---------------------------------------------------------------------------

interface MediaCall {
  url: string;
  path: string;
  body: Record<string, unknown> | null;
  raw: Uint8Array | null;
}

const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length) restorers.pop()!();
});

/**
 * Mocks the three hops a media send makes: getuploadurl (JSON), the CDN upload
 * (octet-stream, answers with x-encrypted-param), and sendmessage (JSON).
 */
function installMediaFetch(
  opts: { cdnDownload?: { body: Buffer; headers?: Record<string, string> } } = {},
): MediaCall[] {
  const calls: MediaCall[] = [];
  const original = globalThis.fetch;
  restorers.push(() => {
    globalThis.fetch = original;
  });

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const isJson = typeof init?.body === 'string';
    calls.push({
      url,
      path,
      body: isJson ? (JSON.parse(String(init!.body)) as Record<string, unknown>) : null,
      raw: isJson ? null : ((init?.body as Uint8Array) ?? null),
    });

    if (path.endsWith('/getuploadurl'))
      return jsonResponse({ ret: 0, upload_full_url: 'https://cdn.test/c2c/upload?x=1' });
    if (path.endsWith('/upload'))
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-encrypted-param': 'dl-param-1' }),
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    if (path.endsWith('/download')) {
      const d = opts.cdnDownload;
      if (!d) return jsonResponse({ ret: 0 });
      return {
        ok: true,
        status: 200,
        headers: new Headers(d.headers ?? {}),
        body: bufferToStream(d.body),
        arrayBuffer: async () => d.body,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }
    return jsonResponse({ ret: 0 });
  }) as typeof globalThis.fetch;

  return calls;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  // Two chunks, so the running byte cap is exercised mid-stream.
  const mid = Math.max(1, Math.floor(buf.length / 2));
  const parts = [buf.subarray(0, mid), buf.subarray(mid)];
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(parts[i]!));
      i++;
    },
  });
}

function mediaClient(overrides: Record<string, unknown> = {}): ILinkClient {
  return new ILinkClient({
    botToken: 'tok',
    baseUrl: 'https://ilink.test',
    cdnBaseUrl: 'https://cdn.test/c2c',
    ...overrides,
  });
}

function sentItem(calls: MediaCall[]): Record<string, unknown> {
  const send = calls.find((c) => c.path.endsWith('/sendmessage'));
  assert.ok(send, 'sendmessage was not called');
  const msg = send.body!.msg as { item_list: Array<Record<string, unknown>> };
  return msg.item_list[0]!;
}

const mediaPeer = { toUserId: 'peer-1', contextToken: 'ctx-1' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('sendVoice', () => {
  it('uploads with media_type 4 and emits a voice_item', async () => {
    const calls = installMediaFetch();
    await mediaClient().sendVoice({
      ...mediaPeer,
      voice: Buffer.from('#!SILK_V3 audio'),
      durationMs: 2500,
    });

    const upload = calls.find((c) => c.path.endsWith('/getuploadurl'))!;
    assert.equal(upload.body!.media_type, UPLOAD_MEDIA_TYPE.voice);
    assert.equal(upload.body!.media_type, 4);
    assert.deepEqual(upload.body!.base_info, { channel_version: '1.0.2' });

    const item = sentItem(calls);
    assert.equal(item.type, ITEM_TYPE.voice);
    assert.equal(item.type, 3);
    const voice = item.voice_item as Record<string, unknown>;
    const media = voice.media as Record<string, unknown>;
    assert.equal(media.encrypt_query_param, 'dl-param-1');
    assert.equal(media.encrypt_type, 1);
    assert.equal(voice.duration_ms, 2500);
    assert.equal(voice.voice_length, 2500);
    assert.ok(typeof voice.mid_size === 'number' && voice.mid_size > 0);
  });

  it('omits duration fields when unknown', async () => {
    const calls = installMediaFetch();
    await mediaClient().sendVoice({ ...mediaPeer, voice: Buffer.from('abc') });
    const voice = sentItem(calls).voice_item as Record<string, unknown>;
    assert.equal('duration_ms' in voice, false);
    assert.equal('voice_length' in voice, false);
  });

  it('rejects an empty buffer before any network call', async () => {
    const calls = installMediaFetch();
    await assert.rejects(
      () => mediaClient().sendVoice({ ...mediaPeer, voice: Buffer.alloc(0) }),
      /buffer is empty/,
    );
    assert.equal(calls.length, 0);
  });

  it('rejects oversized payloads before uploading', async () => {
    const calls = installMediaFetch();
    // mediaMaxBytes has a 1KB floor, so stay above it to exercise the check.
    await assert.rejects(
      () =>
        mediaClient({ mediaMaxBytes: 2048 }).sendVoice({ ...mediaPeer, voice: Buffer.alloc(4096) }),
      /media too large/,
    );
    assert.equal(calls.length, 0);
  });
});

describe('sendVideo / sendFile', () => {
  it('sendVideo uses media_type 2 and the inferred video item type', async () => {
    const calls = installMediaFetch();
    await mediaClient().sendVideo({ ...mediaPeer, video: Buffer.from('vid'), durationMs: 9 });
    assert.equal(calls.find((c) => c.path.endsWith('/getuploadurl'))!.body!.media_type, 2);
    const item = sentItem(calls);
    assert.equal(item.type, ITEM_TYPE.video);
    assert.ok(item.video_item);
  });

  it('sendFile uses media_type 3 and carries the file name', async () => {
    const calls = installMediaFetch();
    await mediaClient().sendFile({
      ...mediaPeer,
      file: Buffer.from('hello'),
      fileName: ' notes.txt ',
    });
    assert.equal(calls.find((c) => c.path.endsWith('/getuploadurl'))!.body!.media_type, 3);
    const file = sentItem(calls).file_item as Record<string, unknown>;
    assert.equal(file.file_name, 'notes.txt');
    assert.equal(file.file_size, 5);
  });

  it('sendFile requires a name', async () => {
    installMediaFetch();
    await assert.rejects(
      () => mediaClient().sendFile({ ...mediaPeer, file: Buffer.from('x'), fileName: '  ' }),
      /fileName is required/,
    );
  });

  it('honours an item type override so ops can correct the inferred numbers', async () => {
    const calls = installMediaFetch();
    await mediaClient().sendVideo({ ...mediaPeer, video: Buffer.from('vid'), itemType: 5 });
    assert.equal(sentItem(calls).type, 5);
  });
});

describe('downloadMedia', () => {
  const aesKeyHex = '0123456789abcdef0123456789abcdef';

  it('decrypts CDN bytes and sniffs the mime', async () => {
    const cipher = encryptAes128Ecb(PNG, parseAesKey(aesKeyHex));
    installMediaFetch({ cdnDownload: { body: cipher } });

    const ref: InboundMediaRef = {
      kind: 'image',
      index: 0,
      encryptQueryParam: 'eqp',
      aesKey: aesKeyHex,
      encryptType: 1,
    };
    const out = await mediaClient().downloadMedia(ref);

    assert.equal(out.kind, 'image');
    assert.equal(out.mime, 'image/png');
    assert.deepEqual(out.data, PNG);
  });

  it('builds the download URL from the CDN base and the encrypted param', async () => {
    const cipher = encryptAes128Ecb(PNG, parseAesKey(aesKeyHex));
    const calls = installMediaFetch({ cdnDownload: { body: cipher } });
    await mediaClient().downloadMedia({
      kind: 'image',
      index: 0,
      encryptQueryParam: 'a b&c',
      aesKey: aesKeyHex,
    });
    const dl = calls.find((c) => c.path.endsWith('/download'))!;
    assert.ok(dl.url.startsWith('https://cdn.test/c2c/download?'));
    assert.ok(dl.url.includes(encodeURIComponent('a b&c')));
  });

  it('prefers an absolute full_url when it points at the CDN', async () => {
    const calls = installMediaFetch({ cdnDownload: { body: PNG } });
    await mediaClient().downloadMedia({
      kind: 'image',
      index: 0,
      fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download?z=1',
    });
    const dl = calls.find((c) => c.path.endsWith('/download'))!;
    assert.equal(dl.url, 'https://novac2c.cdn.weixin.qq.com/c2c/download?z=1');
  });

  it('ignores an off-CDN full_url and rebuilds from our own base', async () => {
    // full_url arrives on an inbound message, so honouring it unchecked would
    // be an SSRF primitive against whatever this box can reach.
    const calls = installMediaFetch({ cdnDownload: { body: PNG } });
    await mediaClient().downloadMedia({
      kind: 'image',
      index: 0,
      fullUrl: 'http://169.254.169.254/latest/meta-data/',
      encryptQueryParam: 'eqp',
    });
    const dl = calls.find((c) => c.path.endsWith('/download'))!;
    assert.ok(
      dl.url.startsWith('https://cdn.test/c2c/download?'),
      `should have rebuilt from the CDN base, got ${dl.url}`,
    );
    assert.ok(!calls.some((c) => c.url.includes('169.254.169.254')));
  });

  it('refuses an off-CDN full_url with no fallback rather than fetching it', async () => {
    const calls = installMediaFetch({ cdnDownload: { body: PNG } });
    await assert.rejects(
      () =>
        mediaClient().downloadMedia({ kind: 'image', index: 0, fullUrl: 'http://127.0.0.1:6379/' }),
      /full_url host not allowed/,
    );
    assert.equal(calls.length, 0, 'must not have issued any request');
  });

  it('does not echo the rejected URL back, only its host', async () => {
    installMediaFetch();
    await assert.rejects(
      () =>
        mediaClient().downloadMedia({
          kind: 'image',
          index: 0,
          fullUrl: 'http://10.0.0.9/secret-path?token=abc',
        }),
      (err: Error) => {
        assert.match(err.message, /10\.0\.0\.9/);
        assert.ok(!err.message.includes('secret-path'));
        assert.ok(!err.message.includes('token=abc'));
        return true;
      },
    );
  });

  it('honours an explicit mediaHostAllowlist', async () => {
    const calls = installMediaFetch({ cdnDownload: { body: PNG } });
    await mediaClient({ mediaHostAllowlist: ['mirror.test'] }).downloadMedia({
      kind: 'image',
      index: 0,
      fullUrl: 'https://mirror.test/download?z=1',
    });
    assert.equal(
      calls.find((c) => c.path.endsWith('/download'))!.url,
      'https://mirror.test/download?z=1',
    );
  });

  it('accepts plaintext bytes when a vestigial aes_key fails to decrypt', async () => {
    installMediaFetch({ cdnDownload: { body: PNG } });
    const out = await mediaClient().downloadMedia({
      kind: 'image',
      index: 0,
      encryptQueryParam: 'eqp',
      aesKey: aesKeyHex,
      encryptType: 1,
    });
    assert.equal(out.mime, 'image/png');
    assert.deepEqual(out.data, PNG);
  });

  it('skips decryption when encrypt_type is 0', async () => {
    installMediaFetch({ cdnDownload: { body: PNG } });
    const out = await mediaClient().downloadMedia({
      kind: 'image',
      index: 0,
      encryptQueryParam: 'eqp',
      aesKey: aesKeyHex,
      encryptType: 0,
    });
    assert.deepEqual(out.data, PNG);
  });

  it('rejects on the mid_size hint without fetching', async () => {
    const calls = installMediaFetch({ cdnDownload: { body: PNG } });
    await assert.rejects(
      () =>
        mediaClient().downloadMedia(
          { kind: 'image', index: 0, encryptQueryParam: 'eqp', cipherSize: 9999 },
          { maxBytes: 2048 },
        ),
      /media too large/,
    );
    assert.equal(calls.length, 0);
  });

  it('rejects on a declared Content-Length over the cap', async () => {
    installMediaFetch({ cdnDownload: { body: PNG, headers: { 'content-length': '9999' } } });
    await assert.rejects(
      () =>
        mediaClient().downloadMedia(
          { kind: 'image', index: 0, encryptQueryParam: 'eqp' },
          { maxBytes: 1024 },
        ),
      /media too large/,
    );
  });

  it('aborts mid-stream when the body exceeds the cap despite no Content-Length', async () => {
    installMediaFetch({ cdnDownload: { body: Buffer.alloc(9000, 7) } });
    await assert.rejects(
      () =>
        mediaClient().downloadMedia(
          { kind: 'image', index: 0, encryptQueryParam: 'eqp' },
          { maxBytes: 2048 },
        ),
      /exceeded 2048 bytes/,
    );
  });

  it('requires somewhere to fetch from', async () => {
    installMediaFetch();
    await assert.rejects(
      () => mediaClient().downloadMedia({ kind: 'image', index: 0 }),
      /neither full_url nor encrypt_query_param/,
    );
  });
});

// ---------------------------------------------------------------------------
// typing indicator
// ---------------------------------------------------------------------------

interface TypingCall {
  path: string;
  body: Record<string, unknown>;
}

type Reply = { status?: number; body: unknown };
type Handler = (path: string, body: Record<string, unknown>) => Reply;

function installTypingFetch(handler: Handler): TypingCall[] {
  const calls: TypingCall[] = [];
  const original = globalThis.fetch;
  restorers.push(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    const reply = handler(path, body);
    const status = reply.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: new Headers(),
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

function typingClient(overrides: Record<string, unknown> = {}): ILinkClient {
  return new ILinkClient({ botToken: 'tok', baseUrl: 'https://ilink.test', ...overrides });
}

const typingPeer = { toUserId: 'peer-1', contextToken: 'ctx-1' };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('typing indicator protocol', () => {
  it('fetches a ticket then sends status 1 by default', async () => {
    const calls = installTypingFetch((path) =>
      path.endsWith('/getconfig')
        ? { body: { ret: 0, typing_ticket: 'tkt-abc' } }
        : { body: { ret: 0 } },
    );

    await typingClient().sendTyping(typingPeer);

    assert.deepEqual(
      calls.map((c) => c.path),
      ['/ilink/bot/getconfig', '/ilink/bot/sendtyping'],
    );
    assert.equal(calls[0]!.body.ilink_user_id, 'peer-1');
    assert.equal(calls[0]!.body.context_token, 'ctx-1');
    assert.equal(calls[1]!.body.typing_ticket, 'tkt-abc');
    assert.equal(calls[1]!.body.status, 1);
  });

  it('startTyping sends 1 and stopTyping sends 2', async () => {
    const calls = installTypingFetch((path) =>
      path.endsWith('/getconfig')
        ? { body: { ret: 0, typing_ticket: 'tkt' } }
        : { body: { ret: 0 } },
    );
    const c = typingClient();

    await c.startTyping(typingPeer);
    await c.stopTyping(typingPeer);

    assert.deepEqual(
      calls.filter((x) => x.path.endsWith('/sendtyping')).map((x) => x.body.status),
      [1, 2],
    );
  });

  it('caches the ticket across calls (one getconfig per peer)', async () => {
    const calls = installTypingFetch((path) =>
      path.endsWith('/getconfig')
        ? { body: { ret: 0, typing_ticket: 'tkt' } }
        : { body: { ret: 0 } },
    );
    const c = typingClient();

    await c.startTyping(typingPeer);
    await c.startTyping(typingPeer);
    await c.startTyping(typingPeer);

    assert.equal(
      calls.filter((x) => x.path.endsWith('/getconfig')).length,
      1,
      'ticket should be reused',
    );
    assert.equal(c.getCachedTypingTicket('peer-1'), 'tkt');
  });

  it('collapses concurrent ticket fetches into one getconfig', async () => {
    const gate = deferred<void>();
    let getConfigCalls = 0;
    installTypingFetch((path) => {
      if (path.endsWith('/getconfig')) {
        getConfigCalls++;
        return { body: { ret: 0, typing_ticket: 'tkt' } };
      }
      return { body: { ret: 0 } };
    });
    // Hold the first getconfig open so the second caller has to join it.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/getconfig')) await gate.promise;
      return original(input as string, init);
    }) as typeof globalThis.fetch;

    const c = typingClient();
    const both = Promise.all([c.startTyping(typingPeer), c.startTyping(typingPeer)]);
    gate.resolve();
    await both;

    assert.equal(getConfigCalls, 1);
  });

  it('keeps separate tickets per peer', async () => {
    const calls = installTypingFetch((path, body) =>
      path.endsWith('/getconfig')
        ? { body: { ret: 0, typing_ticket: `tkt-${body.ilink_user_id}` } }
        : { body: { ret: 0 } },
    );
    const c = typingClient();

    await c.startTyping({ toUserId: 'a', contextToken: 'ctx' });
    await c.startTyping({ toUserId: 'b', contextToken: 'ctx' });

    assert.equal(c.getCachedTypingTicket('a'), 'tkt-a');
    assert.equal(c.getCachedTypingTicket('b'), 'tkt-b');
    assert.equal(calls.filter((x) => x.path.endsWith('/getconfig')).length, 2);
  });

  it('does not fetch a ticket just to stop typing', async () => {
    const calls = installTypingFetch(() => ({ body: { ret: 0 } }));

    await typingClient().stopTyping(typingPeer);

    assert.deepEqual(
      calls.map((c) => c.path),
      ['/ilink/bot/sendtyping'],
      'stop with no cached ticket must not pay a getconfig round trip',
    );
    assert.equal(calls[0]!.body.status, 2);
    assert.equal(calls[0]!.body.typing_ticket, undefined);
  });

  it('still sends typing when getconfig fails', async () => {
    const calls = installTypingFetch((path) =>
      path.endsWith('/getconfig')
        ? { status: 500, body: { ret: -1, errmsg: 'boom' } }
        : { body: { ret: 0 } },
    );

    await typingClient().startTyping(typingPeer);

    const typing = calls.filter((x) => x.path.endsWith('/sendtyping'));
    assert.equal(typing.length, 1);
    assert.equal(typing[0]!.body.typing_ticket, undefined);
    assert.equal(typing[0]!.body.status, 1);
  });

  it('refreshes a stale cached ticket once and retries', async () => {
    let issued = 0;
    let revoked = false;
    const calls = installTypingFetch((path, body) => {
      if (path.endsWith('/getconfig')) {
        issued++;
        return { body: { ret: 0, typing_ticket: `tkt-${issued}` } };
      }
      if (revoked && body.typing_ticket === 'tkt-1')
        return { body: { ret: -3, errmsg: 'invalid typing_ticket' } };
      return { body: { ret: 0 } };
    });
    const c = typingClient();

    await c.startTyping(typingPeer); // primes tkt-1
    assert.equal(c.getCachedTypingTicket('peer-1'), 'tkt-1');
    calls.length = 0;
    revoked = true; // server drops tkt-1 out from under the cache

    await c.startTyping(typingPeer);

    assert.deepEqual(
      calls.map((x) => x.path),
      ['/ilink/bot/sendtyping', '/ilink/bot/getconfig', '/ilink/bot/sendtyping'],
    );
    assert.equal(calls[2]!.body.typing_ticket, 'tkt-2');
    assert.equal(c.getCachedTypingTicket('peer-1'), 'tkt-2');
  });

  it('gives up after one retry instead of looping', async () => {
    let issued = 0;
    const calls = installTypingFetch((path) => {
      if (path.endsWith('/getconfig')) {
        issued++;
        return { body: { ret: 0, typing_ticket: `tkt-${issued}` } };
      }
      return { body: { ret: -3, errmsg: 'always invalid' } };
    });
    const c = typingClient();

    await assert.rejects(() => c.startTyping(typingPeer), /always invalid/);

    // first send (tkt-1) → refresh → second send (tkt-2) → stop
    assert.equal(calls.filter((x) => x.path.endsWith('/sendtyping')).length, 2);
    assert.equal(calls.filter((x) => x.path.endsWith('/getconfig')).length, 2);
  });

  it('honours an explicitly supplied ticket without calling getconfig', async () => {
    const calls = installTypingFetch(() => ({ body: { ret: 0 } }));

    await typingClient().startTyping({ ...typingPeer, typingTicket: 'manual' });

    assert.deepEqual(
      calls.map((c) => c.path),
      ['/ilink/bot/sendtyping'],
    );
    assert.equal(calls[0]!.body.typing_ticket, 'manual');
  });

  it('expires cached tickets after the configured TTL', async () => {
    const calls = installTypingFetch((path) =>
      path.endsWith('/getconfig')
        ? { body: { ret: 0, typing_ticket: 'tkt' } }
        : { body: { ret: 0 } },
    );
    // Floor is 60s, so ask for the minimum and then move the clock past it.
    const c = typingClient({ typingTicketTtlMs: 1 });
    await c.startTyping(typingPeer);
    assert.equal(calls.filter((x) => x.path.endsWith('/getconfig')).length, 1);

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      assert.equal(c.getCachedTypingTicket('peer-1'), null);
      await c.startTyping(typingPeer);
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls.filter((x) => x.path.endsWith('/getconfig')).length, 2);
  });

  it('bounds the ticket cache', async () => {
    installTypingFetch((path, body) =>
      path.endsWith('/getconfig')
        ? { body: { ret: 0, typing_ticket: `tkt-${body.ilink_user_id}` } }
        : { body: { ret: 0 } },
    );
    // Floor is 64 entries regardless of a smaller request.
    const c = typingClient({ typingTicketMaxEntries: 1 });
    for (let i = 0; i < 70; i++) await c.startTyping({ toUserId: `p${i}`, contextToken: 'ctx' });

    // Oldest evicted, newest retained — never unbounded growth.
    assert.equal(c.getCachedTypingTicket('p0'), null);
    assert.equal(c.getCachedTypingTicket('p69'), 'tkt-p69');
  });

  it('invalidateTypingTicket forces the next fetch', async () => {
    const calls = installTypingFetch((path) =>
      path.endsWith('/getconfig')
        ? { body: { ret: 0, typing_ticket: 'tkt' } }
        : { body: { ret: 0 } },
    );
    const c = typingClient();

    await c.startTyping(typingPeer);
    c.invalidateTypingTicket('peer-1');
    await c.startTyping(typingPeer);

    assert.equal(calls.filter((x) => x.path.endsWith('/getconfig')).length, 2);
  });

  it('requires a bot token', async () => {
    installTypingFetch(() => ({ body: { ret: 0 } }));
    const c = new ILinkClient({ baseUrl: 'https://ilink.test' });
    await assert.rejects(() => c.startTyping(typingPeer), /bot_token is required/);
  });
});
