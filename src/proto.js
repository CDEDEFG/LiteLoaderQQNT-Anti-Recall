'use strict';
// 极简 protobuf/TLV 解码器。
// QQ 的 40800 消息体格式不规则（元素里还套着长度前缀 + 裸 JSON / XML），
// 所以这里只做"尽力解析"，遇到越界立刻停，绝不抛异常——一条坏消息不能拖垮整个导出。

function readVarint(buf, i) {
  let v = 0n, shift = 0n, b;
  do {
    if (i >= buf.length) throw new Error('eof');
    b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long'); // 防止死循环
  } while (b & 0x80);
  return [v, i];
}

/** 解析一层 protobuf，返回 [{field, wire, value}]。value: BigInt(0) / Buffer(2) / number(5) / BigInt(1) */
function decode(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    try {
      let tag;
      [tag, i] = readVarint(buf, i);
      const field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (wire === 0) {
        let v; [v, i] = readVarint(buf, i);
        out.push({ field, wire, value: v });
      } else if (wire === 2) {
        let l; [l, i] = readVarint(buf, i);
        const n = Number(l);
        if (n < 0 || i + n > buf.length) break;
        out.push({ field, wire, value: buf.subarray(i, i + n) });
        i += n;
      } else if (wire === 5) {
        if (i + 4 > buf.length) break;
        out.push({ field, wire, value: buf.readUInt32LE(i) });
        i += 4;
      } else if (wire === 1) {
        if (i + 8 > buf.length) break;
        out.push({ field, wire, value: buf.readBigUInt64LE(i) });
        i += 8;
      } else break; // 3/4 是已废弃的 group，直接放弃
    } catch (e) { break; }
  }
  return out;
}

/** 取某个 field 的最后一次出现（QQ 常把同名字段重复写，后者为准） */
function last(fields, f) {
  const a = fields.filter(x => x.field === f);
  return a.length ? a[a.length - 1] : null;
}

/** 取字符串值，没有就返回 '' */
function str(fields, f) {
  const x = last(fields, f);
  if (!x || x.wire !== 2) return '';
  return x.value.toString('utf8');
}

/** 取数值，没有就返回 null */
function num(fields, f) {
  const x = last(fields, f);
  if (!x) return null;
  return typeof x.value === 'bigint' ? Number(x.value) : x.value;
}

/** 取 Buffer，没有就返回 null */
function buf(fields, f) {
  const x = last(fields, f);
  return x && x.wire === 2 ? x.value : null;
}

module.exports = { readVarint, decode, last, str, num, buf };
