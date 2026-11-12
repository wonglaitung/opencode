import { describe, expect, test } from "bun:test"
import { decrypt, DecryptError, deriveKey, encrypt, keycheck, randomSalt, verifyKeycheck } from "../src/crypto"

const repoId = "repo-1"
const salt = randomSalt()
const passphrase = "correct horse battery staple"

describe("crypto", () => {
  test("加解密往返一致", () => {
    const key = deriveKey(passphrase, salt)
    const plain = Buffer.from("会话内容 with unicode 中文", "utf8")
    const cipher = encrypt(plain, key, repoId, "sessions/s1/m1.ocgs")
    const out = decrypt(cipher, key, repoId, "sessions/s1/m1.ocgs")
    expect(out.toString("utf8")).toBe(plain.toString("utf8"))
  })

  test("相同明文每次密文不同（随机 nonce）", () => {
    const key = deriveKey(passphrase, salt)
    const plain = Buffer.from("same", "utf8")
    const a = encrypt(plain, key, repoId, "sessions/s1/m1.ocgs")
    const b = encrypt(plain, key, repoId, "sessions/s1/m1.ocgs")
    expect(a.equals(b)).toBe(false)
  })

  test("passphrase 不匹配时解密失败", () => {
    const key = deriveKey(passphrase, salt)
    const wrong = deriveKey("wrong passphrase", salt)
    const cipher = encrypt(Buffer.from("secret"), key, repoId, "sessions/s1/m1.ocgs")
    expect(() => decrypt(cipher, wrong, repoId, "sessions/s1/m1.ocgs")).toThrow(DecryptError)
  })

  test("路径被篡改时解密失败（AAD 绑定）", () => {
    const key = deriveKey(passphrase, salt)
    const cipher = encrypt(Buffer.from("secret"), key, repoId, "sessions/s1/m1.ocgs")
    expect(() => decrypt(cipher, key, repoId, "sessions/s2/m1.ocgs")).toThrow(DecryptError)
  })

  test("仓库 ID 不一致时解密失败", () => {
    const key = deriveKey(passphrase, salt)
    const cipher = encrypt(Buffer.from("secret"), key, repoId, "sessions/s1/m1.ocgs")
    expect(() => decrypt(cipher, key, "other-repo", "sessions/s1/m1.ocgs")).toThrow(DecryptError)
  })

  test("keycheck 能识别正确 passphrase", () => {
    const key = deriveKey(passphrase, salt)
    const check = keycheck(key, repoId)
    expect(verifyKeycheck(check, key, repoId)).toBe(true)
    expect(verifyKeycheck(check, deriveKey("nope", salt), repoId)).toBe(false)
  })
})
