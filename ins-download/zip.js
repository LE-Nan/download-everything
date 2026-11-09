/* 极简 ZIP 打包（store 模式，无压缩）：content/offscreen 共用 */
var InsZip = (function () {
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // files: [{ name: string, data: Uint8Array }] -> Blob
  function build(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // UTF-8 文件名
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, nameBytes.length, true);
      parts.push(lh.buffer, nameBytes, f.data);
      central.push({ nameBytes, crc, size, offset });
      offset += 30 + nameBytes.length + size;
    }

    const cdStart = offset;
    for (const c of central) {
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, c.crc, true);
      ch.setUint32(20, c.size, true);
      ch.setUint32(24, c.size, true);
      ch.setUint16(28, c.nameBytes.length, true);
      ch.setUint32(42, c.offset, true);
      parts.push(ch.buffer, c.nameBytes);
      offset += 46 + c.nameBytes.length;
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, central.length, true);
    end.setUint16(10, central.length, true);
    end.setUint32(12, offset - cdStart, true);
    end.setUint32(16, cdStart, true);
    parts.push(end.buffer);

    return new Blob(parts, { type: "application/zip" });
  }

  return { build };
})();
