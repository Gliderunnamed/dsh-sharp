/**
 * 极简 asar 读取器（只读，够用就行）。
 *
 *   node tools/asar.mjs list    <archive> [prefix]
 *   node tools/asar.mjs size    <archive> [prefix]
 *   node tools/asar.mjs extract <archive> <prefix> <destDir>
 *
 * asar 布局：
 *   [0..7]   两个 pickle：uint32=4, uint32=headerPickleSize(N)
 *   [8..8+N] 一个 pickle：uint32=jsonLength(M), 然后 M 字节 JSON
 *   之后是各文件的原始内容，按 JSON 里 offset/size 定位。
 */

import { existsSync, mkdirSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 在 pickle 里定位那段 JSON 主体：找到第一个 '{'，按括号配对取到对应的 '}'。 */
function sliceJson(buf) {
  const start = buf.indexOf(0x7b) // '{'
  if (start < 0) throw new Error('asar: 头部里找不到 JSON 起点')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < buf.length; i += 1) {
    const ch = buf[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === 0x5c) escaped = true
      else if (ch === 0x22) inString = false
      continue
    }
    if (ch === 0x22) inString = true
    else if (ch === 0x7b) depth += 1
    else if (ch === 0x7d) {
      depth -= 1
      if (depth === 0) return buf.subarray(start, i + 1).toString('utf8')
    }
  }
  throw new Error('asar: 头部 JSON 括号不闭合')
}

function readHeader(fd) {
  const sizeBuf = Buffer.alloc(8)
  readSync(fd, sizeBuf, 0, 8, 0)
  const n = sizeBuf.readUInt32LE(4)
  if (n <= 0 || n > 64 * 1024 * 1024) throw new Error(`asar: 头部长度异常 (${n})`)
  const headerBuf = Buffer.alloc(n)
  readSync(fd, headerBuf, 0, n, 8)
  let header
  try {
    header = JSON.parse(sliceJson(headerBuf))
  } catch (error) {
    // 绝不要让 Node 把整个头部 buffer 回显出来
    throw new Error(`asar: 头部 JSON 解析失败 (${error && error.name})`)
  }
  return { header, contentBase: 8 + n }
}

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (child.files !== undefined) {
      walk(child, path, out)
    } else {
      out.push({ path, size: child.size ?? 0, offset: child.offset === undefined ? undefined : Number(child.offset), unpacked: child.unpacked === true })
    }
  }
}

function entries(header) {
  const out = []
  walk(header, '', out)
  return out
}

const [command, archive, ...rest] = process.argv.slice(2)
if (command === undefined || archive === undefined) {
  console.error('用法: node tools/asar.mjs <list|size|extract> <archive> [prefix] [dest]')
  process.exit(2)
}
if (!existsSync(archive)) {
  console.error(`找不到 ${archive}`)
  process.exit(2)
}

const fd = openSync(archive, 'r')
try {
  const { header, contentBase } = readHeader(fd)
  const all = entries(header)

  if (command === 'list' || command === 'size') {
    const prefix = rest[0] ?? ''
    const matched = all.filter((e) => e.path.startsWith(prefix))
    if (command === 'list') {
      for (const e of matched) console.log(`${String(e.size).padStart(10)}  ${e.unpacked ? 'U' : ' '}  ${e.path}`)
    }
    const total = matched.reduce((sum, e) => sum + e.size, 0)
    console.log(`--- ${matched.length} 个文件, 合计 ${(total / 1024 / 1024).toFixed(2)} MB (总条目 ${all.length})`)
  } else if (command === 'extract') {
    const prefix = rest[0]
    const dest = resolve(rest[1] ?? '.')
    const matched = all.filter((e) => e.path.startsWith(prefix) && !e.unpacked && e.offset !== undefined)
    let written = 0
    let total = 0
    for (const e of matched) {
      const relative = e.path.slice(prefix.length).replace(/^\/+/, '')
      if (relative === '') continue
      const target = join(dest, relative)
      mkdirSync(dirname(target), { recursive: true })
      const buf = Buffer.alloc(e.size)
      if (e.size > 0) readSync(fd, buf, 0, e.size, contentBase + e.offset)
      writeFileSync(target, buf)
      written += 1
      total += e.size
    }
    console.log(`抽出 ${written} 个文件 (${(total / 1024 / 1024).toFixed(2)} MB) -> ${dest}`)
  } else {
    console.error(`未知命令 ${command}`)
    process.exit(2)
  }
} finally {
  closeSync(fd)
}
