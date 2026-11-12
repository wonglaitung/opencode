import crypto from "node:crypto"

/**
 * 会话内容加密。
 *
 * 设计（SOPS-lite）：
 * - 仓库里只有密文，passphrase 永不进仓库；
 * - 内容密钥 = scrypt(passphrase, salt)；salt 存仓库明文 meta（不敏感），保证多机一致；
 * - 每个文件独立 nonce，AAD 绑定 repoId + 仓库内相对路径，防止「换路径/换会话」式替换攻击；
 * - 密钥错误时必须能识别并拒绝（绝不把无法解密的密文当作新数据写回远端）。
 */

const MAGIC = Buffer.from("OCGS1")
const NONCE_SIZE = 12
const KEY_SIZE = 32
const SALT_SIZE = 16
const SCRYPT_COST = 32768
const SCRYPT_BLOCK = 8
const SCRYPT_PARALLEL = 1
const SCRYPT_MAXMEM = 128 * 1024 * 1024

export const KEYCHECK_PLAINTEXT = "opencode-git-sync/keycheck/v1"
export const KEYCHECK_PATH = "keycheck.ocgs"

export function randomSalt(): string {
  return crypto.randomBytes(SALT_SIZE).toString("hex")
}

export function randomRepoId(): string {
  return crypto.randomBytes(16).toString("hex")
}

/** 由 passphrase + salt 派生 32 字节内容密钥。 */
export function deriveKey(passphrase: string, salt: string): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_SIZE, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
    maxmem: SCRYPT_MAXMEM,
  })
}

function aad(repoId: string, relativePath: string): Buffer {
  return Buffer.from(`${repoId}\u0000${relativePath}`, "utf8")
}

/** 加密一个仓库内文件：magic || nonce || ciphertext(+tag)。 */
export function encrypt(plaintext: Buffer, key: Buffer, repoId: string, relativePath: string): Buffer {
  const nonce = crypto.randomBytes(NONCE_SIZE)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad(repoId, relativePath))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()])
}

export class DecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "DecryptError"
  }
}

/** 解密仓库内文件；密钥错误或内容被篡改都会抛 DecryptError。 */
export function decrypt(payload: Buffer, key: Buffer, repoId: string, relativePath: string): Buffer {
  if (payload.length < MAGIC.length + NONCE_SIZE + 16) {
    throw new DecryptError(`密文长度异常: ${relativePath}`)
  }
  if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new DecryptError(`密文格式不匹配（版本不一致?）: ${relativePath}`)
  }
  const nonce = payload.subarray(MAGIC.length, MAGIC.length + NONCE_SIZE)
  const tag = payload.subarray(payload.length - 16)
  const body = payload.subarray(MAGIC.length + NONCE_SIZE, payload.length - 16)
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAAD(aad(repoId, relativePath))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch (cause) {
    throw new DecryptError(`解密失败（passphrase 不匹配或内容被篡改）: ${relativePath}`, { cause })
  }
}

/** 生成用于校验 passphrase 正确性的哨兵文件内容。 */
export function keycheck(key: Buffer, repoId: string): Buffer {
  return encrypt(Buffer.from(KEYCHECK_PLAINTEXT, "utf8"), key, repoId, KEYCHECK_PATH)
}

/** 校验哨兵文件；返回 true 表示 passphrase 正确。 */
export function verifyKeycheck(payload: Buffer, key: Buffer, repoId: string): boolean {
  try {
    return decrypt(payload, key, repoId, KEYCHECK_PATH).toString("utf8") === KEYCHECK_PLAINTEXT
  } catch {
    return false
  }
}
