/**
 * Field-encryption key providers (MFA TOTP secrets).
 *
 * Two roots of trust behind one interface:
 *
 *   `env` — the original behaviour. The 32-byte field key is derived from
 *   `SECRETS_PEPPER` through HKDF with a purpose string, so it is
 *   cryptographically separate from password hashing. Simple, no network,
 *   but the root of trust is an environment variable (accepted risk A4).
 *
 *   `kms` — envelope encryption done properly. A 32-byte data key is
 *   generated once (by KMS itself), stored KMS-encrypted in
 *   `KMS_MFA_KEY_CIPHERTEXT`, and decrypted once at startup; the plaintext
 *   lives only in process memory and is used directly for AES-256-GCM (a KMS
 *   data key is already uniform-random, so no KDF is applied — feeding it
 *   through HKDF would add nothing but a second preimage step). Select with
 *   `MFA_KEY_PROVIDER=kms`. Region and endpoint flow through the SDK's
 *   standard `AWS_REGION` / `AWS_ENDPOINT_URL` variables, which is what makes
 *   LocalStack work locally with no code change.
 *
 * The wire format (`v1.iv.tag.ct` AES-256-GCM) is identical under both
 * providers and the key length is identical, so switching providers is a
 * restart, not a migration — with one caveat stated plainly: existing rows
 * were encrypted under the old key, so a provider switch orphans them the
 * same way a pepper rotation would. The envelope is versioned precisely so a
 * future multi-key reader can be added without guessing.
 *
 * `fieldKey()` is synchronous because encryption runs in hot paths. KMS I/O
 * happens exactly once, in `initKeyProvider()` at startup; afterwards the
 * data key is memory-resident. Anything that encrypts before init (tests,
 * CLI one-shots) falls back to the `env` provider — the historical default —
 * rather than failing.
 */
import { hkdfSync } from 'node:crypto';
import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { env } from '../config/env.ts';

export interface KeyProvider {
  readonly id: 'env' | 'kms';
  fieldKey(info: string): Buffer;
}

const FIELD_KEY_LEN = 32;

class EnvKeyProvider implements KeyProvider {
  readonly id = 'env' as const;
  fieldKey(info: string): Buffer {
    return Buffer.from(hkdfSync(
      'sha256',
      Buffer.from(env.secretsPepper, 'utf8'),
      Buffer.from('bigcrm-field-encryption', 'utf8'),
      Buffer.from(info, 'utf8'),
      FIELD_KEY_LEN,
    ));
  }
}

/** The historical default, exported for the rekey tool. */
export function createEnvProvider(): KeyProvider {
  return new EnvKeyProvider();
}

/** A KMS provider against the real SDK (LocalStack included). */
export async function createKmsProvider(ciphertextB64: string): Promise<KeyProvider> {
  return KmsKeyProvider.create(ciphertextB64, sdkDecryptor());
}

/** Decrypts KMS blobs. Narrower than the SDK client, so tests inject a stub. */
export type KmsDecryptor = (ciphertext: Uint8Array) => Promise<Uint8Array>;

const sdkDecryptor = (): KmsDecryptor => {
  const client = new KMSClient({});
  return async (ciphertext: Uint8Array): Promise<Uint8Array> => {
    const out = await client.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return out.Plaintext;
  };
};

class KmsKeyProvider implements KeyProvider {
  readonly id = 'kms' as const;
  // Not a TypeScript parameter property (`constructor(private readonly ...)`):
  // `--experimental-strip-types` rejects those (see PgSession in db/driver.ts).
  private readonly dataKey: Buffer;
  private constructor(dataKey: Buffer) { this.dataKey = dataKey; }
  fieldKey(_info: string): Buffer {
    // One data key for all field purposes. Purpose separation here would be
    // theatre: the purposes share a process, a database and a threat model,
    // and splitting one random key into two buys nothing against an attacker
    // who holds either. The parameter stays so the interface matches `env`.
    return this.dataKey;
  }
  static async create(ciphertextB64: string, decrypt: KmsDecryptor): Promise<KmsKeyProvider> {
    let raw: Uint8Array;
    try {
      raw = Buffer.from(ciphertextB64, 'base64');
    } catch {
      throw new Error('KMS_MFA_KEY_CIPHERTEXT is not valid base64');
    }
    if (raw.length === 0) throw new Error('KMS_MFA_KEY_CIPHERTEXT is empty');
    const dataKey = Buffer.from(await decrypt(raw));
    if (dataKey.length !== FIELD_KEY_LEN) {
      throw new Error(`KMS data key must be ${FIELD_KEY_LEN} bytes, got ${dataKey.length}`);
    }
    return new KmsKeyProvider(dataKey);
  }
}

let provider: KeyProvider | null = null;

/** Selects the configured provider, performing the single KMS decrypt. */
export async function initKeyProvider(decrypt: KmsDecryptor = sdkDecryptor()): Promise<KeyProvider> {
  if (env.mfaKeyProvider === 'kms') {
    provider = await KmsKeyProvider.create(env.kmsMfaKeyCiphertext ?? '', decrypt);
  } else {
    provider = new EnvKeyProvider();
  }
  return provider;
}

export function fieldKey(info: string): Buffer {
  return (provider ?? new EnvKeyProvider()).fieldKey(info);
}

export const __testing = {
  FIELD_KEY_LEN,
  EnvKeyProvider,
  KmsKeyProvider,
  setProvider: (p: KeyProvider | null): void => { provider = p; },
};
