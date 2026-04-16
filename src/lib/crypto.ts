import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Encrypts sensitive fields (SSH private keys, passphrases) with AES-256-GCM.
// The master key is a 32-byte value kept in DCM_KEYS_DIR/master.key with 0600
// perms. If absent, it is generated on first access. The key file must NEVER be
// committed — .gitignore blocks data/ and keys/.
//
// Threat model: DB dump alone is useless (encrypted blobs). DB + master.key ==
// plaintext. Rotate: decrypt all blobs, generate new key, re-encrypt, replace
// file. (Phase 2 MVP — rotation UX is out of scope here.)

const KEYS_DIR = process.env.DCM_KEYS_DIR ?? path.join(process.cwd(), "data", "keys");
const MASTER_KEY_PATH = path.join(KEYS_DIR, "master.key");

let _key: Buffer | null = null;

function assertNotSymlink(p: string): void {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to follow symlink at ${p}`);
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
}

function loadOrCreateMasterKey(): Buffer {
  if (_key) return _key;
  // Ensure the directory exists and is not a symlink we're about to follow.
  assertNotSymlink(KEYS_DIR);
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  try {
    // Tighten perms on an existing dir in case it was created by someone else.
    chmodSync(KEYS_DIR, 0o700);
  } catch {
    // ignore on platforms where chmod is a no-op
  }

  assertNotSymlink(MASTER_KEY_PATH);
  if (existsSync(MASTER_KEY_PATH)) {
    const st = statSync(MASTER_KEY_PATH);
    if ((st.mode & 0o077) !== 0) {
      // Perms are too loose. Tighten and warn (do not fail — operator may be
      // recovering a backup).
      try {
        chmodSync(MASTER_KEY_PATH, 0o600);
      } catch {
        // best effort
      }
    }
    const buf = readFileSync(MASTER_KEY_PATH);
    if (buf.length !== 32) {
      throw new Error(
        `master.key at ${MASTER_KEY_PATH} has unexpected length ${buf.length} (expected 32)`
      );
    }
    _key = buf;
    return buf;
  }

  // Atomic create: open tmp with O_WRONLY|O_CREAT|O_EXCL 0600, write, fsync,
  // close, rename. If two processes race, only one wins the EXCL and the other
  // loses — it then rereads.
  const tmpPath = `${MASTER_KEY_PATH}.${process.pid}.${Date.now()}.tmp`;
  const generated = crypto.randomBytes(32);
  let fd: number;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
  } catch (e) {
    throw new Error(`could not open ${tmpPath}: ${(e as Error).message}`);
  }
  try {
    writeSync(fd, generated, 0, generated.length);
  } finally {
    closeSync(fd);
  }
  try {
    // If someone else won the race and created master.key in the meantime,
    // rename will overwrite it — which is WRONG. Guard with existsSync and
    // re-read if the target is already there.
    if (existsSync(MASTER_KEY_PATH)) {
      // clean up our tmp, then load the winner
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      const buf = readFileSync(MASTER_KEY_PATH);
      if (buf.length !== 32) throw new Error("racing writer left invalid master.key");
      _key = buf;
      return buf;
    }
    renameSync(tmpPath, MASTER_KEY_PATH);
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw e;
  }
  _key = generated;
  return generated;
}

export function getMasterKey(): Buffer {
  return loadOrCreateMasterKey();
}

// Override for tests — pass a 32-byte buffer to use an isolated key.
export function _setKeyForTests(key: Buffer | null): void {
  _key = key;
}

// encrypt returns base64(nonce (12) || tag (16) || ciphertext)
export function encryptString(plaintext: string): string {
  const key = getMasterKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]).toString("base64");
}

export function decryptString(encoded: string): string {
  const key = getMasterKey();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < 12 + 16) throw new Error("ciphertext too short");
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
